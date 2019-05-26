/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const fs = require('fs-extra');
const BigNumber = require('bignumber.js');
const { Base64 } = require('js-base64');

const database = require('../plugins/Database');
const blockchain = require('../plugins/Blockchain');
const { Block } = require('../libs/Block');
const { Transaction } = require('../libs/Transaction');

const BP_CONSTANTS = require('../libs/BlockProduction.contants').CONSTANTS;

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

contractCode = contractCode.replace(/'\$\{BP_CONSTANTS.UTILITY_TOKEN_PRECISION\}\$'/g, BP_CONSTANTS.UTILITY_TOKEN_PRECISION);
contractCode = contractCode.replace(/'\$\{BP_CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, BP_CONSTANTS.UTILITY_TOKEN_SYMBOL);

let base64ContractCode = Base64.encode(contractCode);

let contractPayload = {
  name: 'tokens',
  params: '',
  code: base64ContractCode,
};

// smart tokens
describe('smart tokens', function () {
  this.timeout(30000);

  it('should enable staking', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'rocketx', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'rocketx', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "freedomex", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'freedomex', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'freedomex', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      let token = res.payload;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'freedomex');
      assert.equal(token.stakingEnabled, true);
      assert.equal(token.unstakingCooldown, 7);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not enable staking', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'rocketx', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'rocketx', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "freedomex", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'freedomex', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'freedomex', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "NKT", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'freedomex', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 0, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'freedomex', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 366, "numberTransactions": 1, "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      let token = res.payload;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'freedomex');
      assert.equal(token.stakingEnabled, false);
      assert.equal(token.unstakingCooldown, 1);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let txs = res.payload.transactions;

      assert.equal(JSON.parse(txs[4].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(txs[5].logs).errors[0], 'unstakingCooldown must be an integer between 1 and 365');
      assert.equal(JSON.parse(txs[6].logs).errors[0], 'unstakingCooldown must be an integer between 1 and 365');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not enable staking again', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'rocketx', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'rocketx', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "freedomex", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'freedomex', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'freedomex', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'freedomex', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 10, "numberTransactions": 1, "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      let token = res.payload;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'freedomex');
      assert.equal(token.stakingEnabled, true);
      assert.equal(token.unstakingCooldown, 7);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_TRANSACTION_INFO,
        payload: 'TXID1238'
      });

      let tx = res.payload;

      assert.equal(JSON.parse(tx.logs).errors[0], 'staking already enabled');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should stake tokens', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'rocketx', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'rocketx', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "freedomex", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'freedomex', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'freedomex', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'freedomex', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:01',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });


      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999998');
      assert.equal(balance.stake, '0.00000002');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_TRANSACTION_INFO,
        payload:  'TXID1239'
      });

      const tx = res.payload;
      const logs = JSON.parse(tx.logs);
      const event = logs.events[0];

      assert.equal(event.contract, 'tokens');
      assert.equal(event.event, 'stake');
      assert.equal(event.data.account, 'satoshi');
      assert.equal(event.data.quantity, '0.00000001');
      assert.equal(event.data.symbol, 'TKN');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      const token = res.payload;

      assert.equal(token.totalStaked, '0.00000002');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not stake tokens', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'rocketx', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'rocketx', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "freedomex", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'freedomex', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'freedomex', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'freedomex', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "-1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12310', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "100.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12311', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.000000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "100");
      assert.equal(balance.stake, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let txs = res.payload.transactions;

      assert.equal(JSON.parse(txs[4].logs).errors[0], 'staking not enabled');
      assert.equal(JSON.parse(txs[6].logs).errors[0], 'must stake positive quantity');
      assert.equal(JSON.parse(txs[7].logs).errors[0], 'overdrawn balance');
      assert.equal(JSON.parse(txs[8].logs).errors[0], 'symbol precision mismatch');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should start the unstake process', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'rocketx', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'rocketx', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "freedomex", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'freedomex', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'freedomex', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'freedomex', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      assert.equal(unstake.quantityLeft, '0.00000001');
      assert.equal(unstake.numberTransactionsLeft, 1);
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(unstake.txID, 'TXID1239');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not start the unstake process', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'rocketx', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'rocketx', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "freedomex", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'freedomex', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'freedomex', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'freedomex', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "-1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1240', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1241', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.000000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "100");
      assert.equal(balance.stake, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let txs = res.payload.transactions;

      assert.equal(JSON.parse(txs[4].logs).errors[0], 'staking not enabled');
      assert.equal(JSON.parse(txs[6].logs).errors[0], 'must unstake positive quantity');
      assert.equal(JSON.parse(txs[7].logs).errors[0], 'overdrawn stake');
      assert.equal(JSON.parse(txs[8].logs).errors[0], 'symbol precision mismatch');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should cancel an unstake', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'rocketx', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'rocketx', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "freedomex", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'freedomex', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'freedomex', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'freedomex', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });


      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID123910', 'satoshi', 'tokens', 'cancelUnstake', '{ "txID": "TXID1239", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:03:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, '0.00000001');
      assert.equal(balance.pendingUnstake, '0.00000000');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake, null);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not cancel an unstake', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'rocketx', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'rocketx', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "freedomex", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'freedomex', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'freedomex', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'freedomex', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });


      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      let blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID123910', 'satoshi', 'tokens', 'cancelUnstake', '{ "txID": "TXID12378", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123911', 'freedomex', 'tokens', 'cancelUnstake', '{ "txID": "TXID1239", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:03:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, '0.00000000');
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(unstake.txID, 'TXID1239');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should process the pending unstakes', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'rocketx', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'rocketx', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "freedomex", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'freedomex', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'freedomex', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'freedomex', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      let token = res.payload;

      assert.equal(token.totalStaked, '0.00000001');

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });


      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123810', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-07T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '100.00000000');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake, null);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let vtxs = res.payload.virtualTransactions;
      const logs = JSON.parse(vtxs[0].logs);
      const event = logs.events[0];

      assert.equal(event.contract, 'tokens');
      assert.equal(event.event, 'unstake');
      assert.equal(event.data.account, 'satoshi');
      assert.equal(event.data.quantity, '0.00000001');
      assert.equal(event.data.symbol, 'TKN');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      token = res.payload;

      assert.equal(token.totalStaked, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it.skip('should process thousands of pending unstakes', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'rocketx', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'rocketx', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "freedomex", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'freedomex', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'freedomex', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'freedomex', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });


      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123810', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-07T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '100.00000000');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake, null);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let vtxs = res.payload.virtualTransactions;
      const logs = JSON.parse(vtxs[0].logs);
      const event = logs.events[0];

      assert.equal(event.contract, 'tokens');
      assert.equal(event.event, 'unstake');
      assert.equal(event.data.account, 'satoshi');
      assert.equal(event.data.quantity, '0.00000001');
      assert.equal(event.data.symbol, 'TKN');

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID223811', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "1", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-14T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // generate thousands of unstakes
      console.log('start generating pending unstakes');
      for (let index = 10000; index < 12000; index++) {
        transactions = [];
        transactions.push(new Transaction(12345678901, `TXID${index}`, 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

        block = {
          refSteemBlockNumber: 12345678901,
          refSteemBlockId: 'ABCD1',
          prevRefSteemBlockId: 'ABCD2',
          timestamp: '2018-07-14T00:02:00',
          transactions,
        };

        await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      }

      transactions = [];
      transactions.push(new Transaction(12345678901, `TXID2000`, 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      console.log('done generating pending unstakes');

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-14T00:02:01',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.00000000');
      assert.equal(balance.stake, '0.99997999');
      assert.equal(balance.pendingUnstake, '0.00002001');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123899', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-21T00:02:00',
        transactions,
      };

      console.log('start processing pending unstakes');
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      console.log('done processing pending unstakes')
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.00002000');
      assert.equal(balance.stake, '0.99997999');
      assert.equal(balance.pendingUnstake, '0.00000001');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should process the pending unstakes (with multi transactions)', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'rocketx', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'rocketx', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "freedomex", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'freedomex', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'freedomex', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 3, "numberTransactions": 3, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'freedomex', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000008", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999992");
      assert.equal(balance.stake, "0.00000008");

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000006", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-01T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999992');
      assert.equal(balance.stake, '0.00000002');
      assert.equal(balance.pendingUnstake, '0.00000006');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000006');
      assert.equal(unstake.quantityLeft, '0.00000006');
      assert.equal(unstake.numberTransactionsLeft, 3);
      let blockDate = new Date('2018-07-01T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 1));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123810', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-02T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999994');
      assert.equal(balance.stake, '0.00000002');
      assert.equal(balance.pendingUnstake, '0.00000004');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000006');
      assert.equal(unstake.quantityLeft, '0.00000004');
      assert.equal(unstake.numberTransactionsLeft, 2);
      blockDate = new Date('2018-07-02T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 1));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123811', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-03T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999996');
      assert.equal(balance.stake, '0.00000002');
      assert.equal(balance.pendingUnstake, '0.00000002');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000006');
      assert.equal(unstake.quantityLeft, '0.00000002');
      assert.equal(unstake.numberTransactionsLeft, 1);
      blockDate = new Date('2018-07-03T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 1));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123812', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-04T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999998');
      assert.equal(balance.stake, '0.00000002');
      assert.equal(balance.pendingUnstake, '0.00000000');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake, null);



      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

});
