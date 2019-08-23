/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const fs = require('fs-extra');
const { Base64 } = require('js-base64');
const database = require('../plugins/Database');
const blockchain = require('../plugins/Blockchain');
const { Block } = require('../libs/Block');
const { Transaction } = require('../libs/Transaction');
const { CONSTANTS } = require('../libs/Constants');

//process.env.NODE_ENV = 'test';

const conf = {
  chainId: "test-chain-id",
  genesisSteemBlock: 2000000,
  dataDirectory: "./test/data/",
  databaseFileName: "database.db",
  autosaveInterval: 0,
  javascriptVMTimeout: 10000,
};

let plugins = {};
let jobs = new Map();
let currentJobId = 0;

function cleanDataFolder() {
  fs.emptyDirSync(conf.dataDirectory);
}

function send(pluginName, from, message) {
  const plugin = plugins[pluginName];
  const newMessage = {
    ...message,
    to: plugin.name,
    from,
    type: 'request',
  };
  currentJobId += 1;
  newMessage.jobId = currentJobId;
  plugin.cp.send(newMessage);
  return new Promise((resolve) => {
    jobs.set(currentJobId, {
      message: newMessage,
      resolve,
    });
  });
}


// function to route the IPC requests
const route = (message) => {
  const { to, type, jobId } = message;
  if (to) {
    if (to === 'MASTER') {
      if (type && type === 'request') {
        // do something
      } else if (type && type === 'response' && jobId) {
        const job = jobs.get(jobId);
        if (job && job.resolve) {
          const { resolve } = job;
          jobs.delete(jobId);
          resolve(message);
        }
      }
    } else if (type && type === 'broadcast') {
      plugins.forEach((plugin) => {
        plugin.cp.send(message);
      });
    } else if (plugins[to]) {
      plugins[to].cp.send(message);
    } else {
      console.error('ROUTING ERROR: ', message);
    }
  }
};

const loadPlugin = (newPlugin) => {
  const plugin = {};
  plugin.name = newPlugin.PLUGIN_NAME;
  plugin.cp = fork(newPlugin.PLUGIN_PATH, [], { silent: true });
  plugin.cp.on('message', msg => route(msg));
  plugin.cp.stdout.on('data', data => console.log(`[${newPlugin.PLUGIN_NAME}]`, data.toString()));
  plugin.cp.stderr.on('data', data => console.error(`[${newPlugin.PLUGIN_NAME}]`, data.toString()));

  plugins[newPlugin.PLUGIN_NAME] = plugin;

  return send(newPlugin.PLUGIN_NAME, 'MASTER', { action: 'init', payload: conf });
};

const unloadPlugin = (plugin) => {
  plugins[plugin.PLUGIN_NAME].cp.kill('SIGINT');
  plugins[plugin.PLUGIN_NAME] = null;
  jobs = new Map();
  currentJobId = 0;
}

let contractCode = fs.readFileSync('./contracts/tokens.js');
contractCode = contractCode.toString();

contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_PRECISION\}\$'/g, CONSTANTS.UTILITY_TOKEN_PRECISION);
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, CONSTANTS.UTILITY_TOKEN_SYMBOL);

let base64ContractCode = Base64.encode(contractCode);

const tknContractPayload = {
  name: 'tokens',
  params: '',
  code: base64ContractCode,
};

contractCode = fs.readFileSync('./contracts/subscriptions.js');
contractCode = contractCode.toString();

base64ContractCode = Base64.encode(contractCode);

const subContractPayload = {
  name: 'subscriptions',
  params: '',
  code: base64ContractCode,
};

describe('Subscriptions smart contract', () => {
  it('creates a subscription', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(30983000, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(30983000, 'TXID1231', 'steemsc', 'contract', 'update', JSON.stringify(subContractPayload)));
      transactions.push(new Transaction(30983000, 'TXID1233', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 5, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30983000, 'TXID1234', 'elear.dev', 'tokens', 'addAuthorization', '{ "isSignedWithActiveKey": true,  "contract": "subscriptions", "version": 2, "symbol": "TKN", "action": "installment", "type": "transfer" }'));
      transactions.push(new Transaction(30983000, 'TXID6179b5ae2735d268091fb8edf18a3c71233d', 'elear.dev', 'subscriptions', 'subscribe', `{"provider": "harpagon", "beneficiaries": [{"account":"aggroed","percent":5000},{"account":"harpagon","percent":5000}], "quantity": "100", "symbol": "TKN", "period": "min", "recur": 10, "max": 10, "isSignedWithActiveKey": true}`));

      const block = new Block(
        '2018-06-01T00:00:00',
        0,
        '',
        '',
        transactions,
        123456788,
      );

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_TRANSACTION_INFO,
        payload: 'TXID6179b5ae2735d268091fb8edf18a3c71233d'
      });

      const tx = res.payload;
      console.log(tx);
      const logs = JSON.parse(tx.logs);
      const event = logs.events.find(ev => ev.contract === 'subscriptions' && ev.event == 'subscribe').data;

      const dbAuth = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'authorizations',
          query: {
            account: 'elear.dev',
            contract: 'subscriptions',
            version: 2,
            action: "installment",
            symbol: 'TKN',
          }
        }
      });
      const authorizations = dbAuth.payload;

      assert.equal(authorizations.length, 1);

      assert.equal(event.subscriber, "elear.dev");
      assert.equal(event.id, "TXID6179b5ae2735d268091fb8edf18a3c71233d");
      assert.equal(event.provider, "harpagon");
      assert.equal(event.beneficiaries.length, 2);
      assert.equal(event.quantity, 100);
      assert.equal(event.symbol, 'TKN');
      assert.equal(event.period, 'min');
      assert.equal(event.recur, 10);
      assert.equal(event.max, 10);
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
  it('refuses a subscription with wrong beneficiaries', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(30983000, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(30983000, 'TXID1231', 'steemsc', 'contract', 'update', JSON.stringify(subContractPayload)));
      transactions.push(new Transaction(30983000, 'TXID1233', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 5, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30983000, 'TXID1235', 'elear.dev', 'tokens', 'addAuthorization', '{ "isSignedWithActiveKey": true,  "contract": "subscriptions", "version": 2, "symbol": "TKN", "action": "installment", "type": "transfer" }'));
      transactions.push(new Transaction(30983000, 'TXID6179b5ae2735d268091fb8edf18a3c71233d', 'elear.dev', 'subscriptions', 'subscribe', `{"provider": "harpagon", "beneficiaries": [{"account":"aggroed","percent":5000},{"account":"harpagon","percent":7000}], "quantity": "100", "symbol": "TKN", "period": "min", "recur": 10, "max": 10, "isSignedWithActiveKey": true}`));

      const block = new Block(
        '2018-06-01T00:00:00',
        0,
        '',
        '',
        transactions,
        123456788,
      );

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_TRANSACTION_INFO,
        payload: 'TXID6179b5ae2735d268091fb8edf18a3c71233d'
      });

      const tx = res.payload;
      const logs = JSON.parse(tx.logs);

      assert.equal(logs.errors.includes("invalid beneficiaries percentage"), true);
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
  it('pays first installment', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const transactions = [];
      transactions.push(new Transaction(30983000, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(30983000, 'TXID1231', 'steemsc', 'contract', 'update', JSON.stringify(subContractPayload)));
      transactions.push(new Transaction(30983000, 'TXID1233', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 5, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30983000, 'TXID1234', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "elear.dev", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30983000, 'TXID1235', 'elear.dev', 'tokens', 'addAuthorization', '{ "isSignedWithActiveKey": true,  "contract": "subscriptions", "version": 2, "symbol": "TKN", "action": "installment", "type": "transfer" }'));
      transactions.push(new Transaction(30983000, 'TXID6179b5ae2735d268091fb8edf18a3c71233d', 'elear.dev', 'subscriptions', 'subscribe', `{ "provider": "harpagon", "beneficiaries": [{"account":"aggroed","percent":5000},{"account":"harpagon","percent":5000}], "quantity": "100", "symbol": "TKN", "period": "min", "recur": 10, "max": 10, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(30983000, 'TXID667', 'harpagon', 'subscriptions', 'installment', `{ "id": "TXID6179b5ae2735d268091fb8edf18a3c71233d", "isSignedWithActiveKey": true }`));

      const block = new Block(
        '2018-06-01T00:00:00',
        0,
        '',
        '',
        transactions,
        123456788,
      );

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const trxInstallment = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_TRANSACTION_INFO,
        payload: 'TXID667'
      });

      const tx = trxInstallment.payload;
      console.log(tx)
      const logs = JSON.parse(tx.logs);
      const event = logs.events.find(ev => ev.contract === 'subscriptions' && ev.event == 'installment').data;
      const dbTokens = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            symbol: 'TKN',
          }
        }
      });
      const balances = dbTokens.payload;
      const dbInstallments = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'subscriptions',
          table: 'installments',
          query: {
            subscriptionId: 'TXID6179b5ae2735d268091fb8edf18a3c71233d',
          }
        }
      });
      const installments = dbInstallments.payload;

      assert.equal(event.first, true);
      assert.equal(event.subscriber, "elear.dev");
      assert.equal(event.id, "TXID6179b5ae2735d268091fb8edf18a3c71233d");
      assert.equal(event.provider, "harpagon");
      assert.equal(installments[0].subscriptionId, "TXID6179b5ae2735d268091fb8edf18a3c71233d");
      for(let i = 0; i < balances.length; i += 1) {
        const account = balances[i].account;
        switch (account) {
          case 'aggroed':
          case 'harpagon': {
            assert.equal(balances[i].balance, 50);
            break;
          }
          default: {
            assert.equal(balances[i].balance, 900);
          }
        }
      }

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
  it('pays installments as scheduled', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const transactionsOne = [];
      const transactionsTwo = [];
      transactionsOne.push(new Transaction(30983000, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactionsOne.push(new Transaction(30983000, 'TXID1231', 'steemsc', 'contract', 'update', JSON.stringify(subContractPayload)));
      transactionsOne.push(new Transaction(30983000, 'TXID1233', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 5, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactionsOne.push(new Transaction(30983000, 'TXID1234', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "elear.dev", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactionsOne.push(new Transaction(30983000, 'TXID1235', 'elear.dev', 'tokens', 'addAuthorization', '{ "isSignedWithActiveKey": true,  "contract": "subscriptions", "version": 2, "symbol": "TKN", "action": "installment", "type": "transfer" }'));
      transactionsOne.push(new Transaction(30983000, 'TXID6179b5ae2735d268091fb8edf18a3c71233d', 'elear.dev', 'subscriptions', 'subscribe', `{ "provider": "harpagon", "beneficiaries": [{"account":"aggroed","percent":5000},{"account":"harpagon","percent":5000}], "quantity": "100", "symbol": "TKN", "period": "min", "recur": 2, "max": 10, "isSignedWithActiveKey": true }`));
      transactionsOne.push(new Transaction(30983000, 'TXID667', 'harpagon', 'subscriptions', 'installment', `{ "id": "TXID6179b5ae2735d268091fb8edf18a3c71233d", "isSignedWithActiveKey": true }`));
      transactionsTwo.push(new Transaction(30983000, 'TXID668', 'harpagon', 'subscriptions', 'installment', `{ "id": "TXID6179b5ae2735d268091fb8edf18a3c71233d", "isSignedWithActiveKey": true }`));

      const blockOne = new Block(
        '2018-06-01T10:00:00',
        0,
        '',
        '',
        transactionsOne,
        1,
      );
      const blockTwo = new Block(
        '2018-06-01T10:02:00',
        0,
        '',
        '',
        transactionsTwo,
        2,
      );

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: blockOne });
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: blockTwo });

      const trxInstallment = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_TRANSACTION_INFO,
        payload: 'TXID668'
      });

      const tx = trxInstallment.payload;
      const logs = JSON.parse(tx.logs);
      const event = logs.events.find(ev => ev.contract === 'subscriptions' && ev.event == 'installment').data;
      const dbTokens = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            symbol: 'TKN',
          }
        }
      });
      const balances = dbTokens.payload;
      const dbInstallments = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'subscriptions',
          table: 'installments',
          query: {
            subscriptionId: 'TXID6179b5ae2735d268091fb8edf18a3c71233d',
          }
        }
      });
      const installments = dbInstallments.payload;

      assert.equal(event.first, false);
      assert.equal(event.subscriber, "elear.dev");
      assert.equal(event.id, "TXID6179b5ae2735d268091fb8edf18a3c71233d");
      assert.equal(event.provider, "harpagon");
      assert.equal(installments[0].subscriptionId, "TXID6179b5ae2735d268091fb8edf18a3c71233d");
      for(let i = 0; i < balances.length; i += 1) {
        const account = balances[i].account;
        switch (account) {
          case 'aggroed':
          case 'harpagon': {
            assert.equal(balances[i].balance, 100);
            break;
          }
          default: {
            assert.equal(balances[i].balance, 800);
          }
        }
      }

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
  it('does not pay wrong installments', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const transactionsOne = [];
      const transactionsTwo = [];
      transactionsOne.push(new Transaction(30983000, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactionsOne.push(new Transaction(30983000, 'TXID1231', 'steemsc', 'contract', 'update', JSON.stringify(subContractPayload)));
      transactionsOne.push(new Transaction(30983000, 'TXID1233', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 5, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactionsOne.push(new Transaction(30983000, 'TXID1234', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "elear.dev", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactionsOne.push(new Transaction(30983000, 'TXID1235', 'elear.dev', 'tokens', 'addAuthorization', '{ "isSignedWithActiveKey": true,  "contract": "subscriptions", "version": 2, "symbol": "TKN", "action": "installment", "type": "transfer" }'));
      transactionsOne.push(new Transaction(30983000, 'TXID6179b5ae2735d268091fb8edf18a3c71233d', 'elear.dev', 'subscriptions', 'subscribe', `{ "provider": "harpagon", "beneficiaries": [{"account":"aggroed","percent":5000},{"account":"harpagon","percent":5000}], "quantity": "100", "symbol": "TKN", "period": "min", "recur": 10, "max": 10, "isSignedWithActiveKey": true }`));
      transactionsOne.push(new Transaction(30983000, 'TXID667', 'harpagon', 'subscriptions', 'installment', `{ "id": "TXID6179b5ae2735d268091fb8edf18a3c71233d", "isSignedWithActiveKey": true }`));
      transactionsTwo.push(new Transaction(30983000, 'TXID668', 'harpagon', 'subscriptions', 'installment', `{ "id": "TXID6179b5ae2735d268091fb8edf18a3c71233d", "isSignedWithActiveKey": true }`));

      const blockOne = new Block(
        '2018-06-01T10:00:00',
        0,
        '',
        '',
        transactionsOne,
        1,
      );
      const blockTwo = new Block(
        '2018-06-01T10:05:00',
        0,
        '',
        '',
        transactionsTwo,
        2,
      );

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: blockOne });
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: blockTwo });

      const trxInstallment = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_TRANSACTION_INFO,
        payload: 'TXID668'
      });

      const tx = trxInstallment.payload;
      const logs = JSON.parse(tx.logs);

      assert.equal(logs.errors.includes("this installment is not payable"), true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
  it('does not pay subscription that reached max installments', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const transactionsOne = [];
      const transactionsTwo = [];
      transactionsOne.push(new Transaction(30983000, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactionsOne.push(new Transaction(30983000, 'TXID1231', 'steemsc', 'contract', 'update', JSON.stringify(subContractPayload)));
      transactionsOne.push(new Transaction(30983000, 'TXID1233', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 5, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactionsOne.push(new Transaction(30983000, 'TXID1234', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "elear.dev", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactionsOne.push(new Transaction(30983000, 'TXID1235', 'elear.dev', 'tokens', 'addAuthorization', '{ "isSignedWithActiveKey": true,  "contract": "subscriptions", "version": 2, "symbol": "TKN", "action": "installment", "type": "transfer" }'));
      transactionsOne.push(new Transaction(30983000, 'TXID6179b5ae2735d268091fb8edf18a3c71233d', 'elear.dev', 'subscriptions', 'subscribe', `{ "provider": "harpagon", "beneficiaries": [{"account":"aggroed","percent":5000},{"account":"harpagon","percent":5000}], "quantity": "100", "symbol": "TKN", "period": "min", "recur": 10, "max": 2, "isSignedWithActiveKey": true }`));
      transactionsOne.push(new Transaction(30983000, 'TXID667', 'harpagon', 'subscriptions', 'installment', `{ "id": "TXID6179b5ae2735d268091fb8edf18a3c71233d", "isSignedWithActiveKey": true }`));
      transactionsTwo.push(new Transaction(30983000, 'TXID668', 'harpagon', 'subscriptions', 'installment', `{ "id": "TXID6179b5ae2735d268091fb8edf18a3c71233d", "isSignedWithActiveKey": true }`));
      transactionsTwo.push(new Transaction(30983000, 'TXID669', 'harpagon', 'subscriptions', 'installment', `{ "id": "TXID6179b5ae2735d268091fb8edf18a3c71233d", "isSignedWithActiveKey": true }`));

      const blockOne = new Block(
        '2018-06-01T10:00:00',
        0,
        '',
        '',
        transactionsOne,
        1,
      );
      const blockTwo = new Block(
        '2018-06-01T10:10:00',
        0,
        '',
        '',
        transactionsTwo,
        2,
      );

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: blockOne });
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: blockTwo });

      const trxInstallment = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_TRANSACTION_INFO,
        payload: 'TXID669'
      });

      const tx = trxInstallment.payload;
      const logs = JSON.parse(tx.logs);

      assert.equal(logs.errors.includes("subscription does not exist or is inactive"), true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
  it('removes a subscription and authorization to transfer', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const transactions = [];
      transactions.push(new Transaction(30983000, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(30983000, 'TXID1231', 'steemsc', 'contract', 'update', JSON.stringify(subContractPayload)));
      transactions.push(new Transaction(30983000, 'TXID1233', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 5, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30983000, 'TXID1235', 'elear.dev', 'tokens', 'addAuthorization', '{ "isSignedWithActiveKey": true,  "contract": "subscriptions", "version": 2, "symbol": "TKN", "action": "installment", "type": "transfer" }'));
      transactions.push(new Transaction(30983000, 'TXID6179b5ae2735d268091fb8edf18a3c71233d', 'elear.dev', 'subscriptions', 'subscribe', `{ "provider": "harpagon", "beneficiaries": [{"account":"aggroed","percent":5000},{"account":"harpagon","percent":5000}], "quantity": "100", "symbol": "TKN", "period": "min", "recur": 10, "max": 10, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(30983000, 'TXID666', 'harpagon', 'subscriptions', 'installment', `{ "id": "TXID6179b5ae2735d268091fb8edf18a3c71233d", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(30983000, 'TXID667', 'elear.dev', 'subscriptions', 'unsubscribe', `{ "id": "TXID6179b5ae2735d268091fb8edf18a3c71233d", "isSignedWithActiveKey": true }`));

      const block = new Block(
        '2018-06-01T00:00:00',
        0,
        '',
        '',
        transactions,
        123456788,
      );

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_TRANSACTION_INFO,
        payload: 'TXID667'
      });
      const tx = res.payload;
      const logs = JSON.parse(tx.logs);
      const event = logs.events.find(ev => ev.contract === 'subscriptions' && ev.event == 'unsubscribe').data;

      const dbSubscription = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'subscriptions',
          table: 'subscriptions',
          query: {
            id: 'TXID6179b5ae2735d268091fb8edf18a3c71233d',
          }
        }
      });
      const subscription = dbSubscription.payload;

      const dbInstallments = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'subscriptions',
          table: 'installments',
          query: {
            subscriptionId: 'TXID6179b5ae2735d268091fb8edf18a3c71233d',
          }
        }
      });
      const installments = dbInstallments.payload;

      const dbAuth = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'authorizations',
          query: {
            contract: 'subscriptions',
            type: 'transfer',
          }
        }
      });
      const hasAuth = dbAuth.payload;

      assert.equal(hasAuth.length, 0);
      assert.equal(subscription.length, 0);
      assert.equal(installments.length, 0);
      assert.equal(event.subscriber, "elear.dev");
      assert.equal(event.id, "TXID6179b5ae2735d268091fb8edf18a3c71233d");
      assert.equal(event.provider, "harpagon");
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
});

