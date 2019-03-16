/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const fs = require('fs-extra');
const BigNumber = require('bignumber.js');

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

const FORK_BLOCK_NUMBER = 30896500;
const SSC_STORE_QTY = '1';

// tokens
describe('Tokens smart contract', () => {
  it('creates a token', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1236', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": "0.001" }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Harpagon', 'sscstore', 'buy', '{ "recipient": "steemsc", "amountSTEEMSBD": "0.001 STEEM", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": 1000, "isSignedWithActiveKey": true  }'));

      let block = {
        refSteemBlockNumber: 30529000,
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

      const token = res.payload;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'Harpagon');
      assert.equal(token.name, 'token');
      assert.equal(JSON.parse(token.metadata).url, 'https://token.com');
      assert.equal(token.maxSupply, 1000);
      assert.equal(token.supply, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            symbol: BP_CONSTANTS.UTILITY_TOKEN_SYMBOL,
            account: 'Harpagon'
          }
        }
      });

      const balance = res.payload;

      assert.equal(balance.symbol, BP_CONSTANTS.UTILITY_TOKEN_SYMBOL);
      assert.equal(balance.account, 'Harpagon');
      assert.equal(balance.balance, BigNumber(SSC_STORE_QTY).minus('0.001').toFixed(3));

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('creates a token v2', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": "0.001" }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Harpagon', 'sscstore', 'buy', '{ "recipient": "steemsc", "amountSTEEMSBD": "0.001 STEEM", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));

      let block = {
        refSteemBlockNumber: FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
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

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'Harpagon');
      assert.equal(token.name, 'token');
      assert.equal(JSON.parse(token.metadata).url, 'https://token.com');
      assert.equal(token.maxSupply, 1000);
      assert.equal(token.supply, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('generates error when trying to create a token with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "Harpagon", "quantity": 1000, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(30529000, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "T.KN", "precision": 3, "maxSupply": 1000, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKNNNNNNNNN", "precision": 3, "maxSupply": 1000, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 3.3, "maxSupply": 1000, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": -1, "maxSupply": 1000, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 9, "maxSupply": 1000, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": -2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "&é", "symbol": "TKN", "precision": 8, "maxSupply": -2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "qsdqsdqsdqsqsdqsdqsdqsdqsdsdqsdqsdqsdqsdqsdqsdqsdqsd", "symbol": "TKN", "precision": 8, "maxSupply": -2, "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 30529000,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
        payload: 1,
      });

      const block1 = res.payload;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[1].logs).errors[0], 'invalid symbol: uppercase letters only, max length of 10');
      assert.equal(JSON.parse(transactionsBlock1[2].logs).errors[0], 'invalid symbol: uppercase letters only, max length of 10');
      assert.equal(JSON.parse(transactionsBlock1[3].logs).errors[0], 'invalid precision');
      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'invalid precision');
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'invalid precision');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'maxSupply must be positive');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'invalid name: letters, numbers, whitespaces only, max length of 50');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'invalid name: letters, numbers, whitespaces only, max length of 50');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('generates error when trying to create a token with wrong parameters v2', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "Harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "T.KN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKNNNNNNNNN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 3.3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": -1, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 9, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "-2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "&é", "symbol": "TKN", "precision": 8, "maxSupply": "-2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "qsdqsdqsdqsqsdqsdqsdqsdqsdsdqsdqsdqsdqsdqsdqsdqsdqsd", "symbol": "TKN", "precision": 8, "maxSupply": "-2", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
        payload: 1,
      });

      const block1 = res.payload;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[1].logs).errors[0], 'invalid symbol: uppercase letters only, max length of 10');
      assert.equal(JSON.parse(transactionsBlock1[2].logs).errors[0], 'invalid symbol: uppercase letters only, max length of 10');
      assert.equal(JSON.parse(transactionsBlock1[3].logs).errors[0], 'invalid precision');
      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'invalid precision');
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'invalid precision');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'maxSupply must be positive');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'invalid name: letters, numbers, whitespaces only, max length of 50');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'invalid name: letters, numbers, whitespaces only, max length of 50');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('updates the url of a token', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1236', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": 0.001 }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Harpagon', 'sscstore', 'buy', '{ "recipient": "steemsc", "amountSTEEMSBD": "0.001 STEEM", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": 1000, "isSignedWithActiveKey": true  }'));

      let block = {
        refSteemBlockNumber: 30529000,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1234', 'Harpagon', 'tokens', 'updateUrl', '{ "symbol": "TKN", "url": "https://new.token.com" }'));

      block = {
        refSteemBlockNumber: 30529000,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
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

      assert.equal(JSON.parse(token.metadata).url, 'https://new.token.com');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('does not update the url of a token', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1236', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": 0.001 }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Harpagon', 'sscstore', 'buy', '{ "recipient": "steemsc", "amountSTEEMSBD": "0.001 STEEM", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": 1000, "isSignedWithActiveKey": true  }'));

      let block = {
        refSteemBlockNumber: 30529000,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1234', 'Satoshi', 'tokens', 'updateUrl', '{ "symbol": "TKN", "url": "https://new.token.com" }'));

      block = {
        refSteemBlockNumber: 30529000,
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

      const token = res.payload;

      assert.equal(JSON.parse(token.metadata).url, 'https://token.com');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
        payload: 2,
      });

      const block1 = res.payload;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[0].logs).errors[0], 'must be the issuer');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('updates the metadata of a token', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1236', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": 0.001 }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Harpagon', 'sscstore', 'buy', '{ "recipient": "steemsc", "amountSTEEMSBD": "0.001 STEEM", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": 1000, "isSignedWithActiveKey": true  }'));

      let block = {
        refSteemBlockNumber: 30529000,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1234', 'Harpagon', 'tokens', 'updateMetadata', '{"symbol":"TKN", "metadata": { "url": "https://url.token.com", "image":"https://image.token.com"}}'));

      block = {
        refSteemBlockNumber: 30529000,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
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

      const metadata = JSON.parse(token.metadata);
      assert.equal(metadata.url, 'https://url.token.com');
      assert.equal(metadata.image, 'https://image.token.com');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('issues tokens', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "Harpagon", "quantity": 1000, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(30529000, 'TXID1235', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 0, "maxSupply": 1000 }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": 100, "to": "Satoshi", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 30529000,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // check if the tokens have been accounted as supplied
      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: "TKN"
          }
        }
      });

      const token = res.payload;

      assert.equal(token.supply, 100);

      // check if the "to" received the tokens
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'Satoshi',
            symbol: "TKN"
          }
        }
      });

      const balance = res.payload;

      assert.equal(balance.balance, 100);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('issues tokens v2', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "Harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1235', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 0, "maxSupply": "1000" }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "Satoshi", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // check if the tokens have been accounted as supplied
      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: "TKN"
          }
        }
      });

      const token = res.payload;

      assert.equal(token.supply, 100);

      // check if the "to" received the tokens
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'Satoshi',
            symbol: "TKN"
          }
        }
      });

      const balance = res.payload;

      assert.equal(balance.balance, 100);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('generates error when trying to issue tokens with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "Harpagon", "quantity": 1000, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(30529000, 'TXID1235', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 0, "maxSupply": 1000 }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": 100, "to": "Satoshi" }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "NTK", "quantity": 100, "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Satoshi', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": 100, "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": 100.1, "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": -100, "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": 1001, "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": 1000, "to": "az", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 30529000,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
        payload: 1,
      });

      const block1 = res.payload;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[2].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[3].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'not allowed to issue tokens');
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'must issue positive quantity');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'quantity exceeds available supply');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'invalid to');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('generates error when trying to issue tokens with wrong parameters v2', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "Harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1235', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 0, "maxSupply": "1000" }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "Satoshi" }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "NTK", "quantity": "100", "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100.1", "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "-100", "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "1001", "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "1000", "to": "az", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
        payload: 1,
      });

      const block1 = res.payload;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[2].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[3].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'not allowed to issue tokens');
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'must issue positive quantity');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'quantity exceeds available supply');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'invalid to');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('transfers tokens', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "Harpagon", "quantity": 1000, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(30529000, 'TXID1235', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": 1000 }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": 100, "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": 3e-8, "to": "Vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": 0.1, "to": "Vitalik", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 30529000,
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
            account: 'Satoshi',
            symbol: "TKN"
          }
        }
      });

      const balanceSatoshi = res.payload;

      assert.equal(balanceSatoshi.balance, 99.89999997);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'Vitalik',
            symbol: "TKN"
          }
        }
      });

      const balanceVitalik = res.payload;

      assert.equal(balanceVitalik.balance, 0.10000003);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('transfers tokens v2', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "Harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1235', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": "3e-8", "to": "Vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": "0.1", "to": "Vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1235', 'Harpagon', 'tokens', 'create', `{ "name": "token", "symbol": "NTK", "precision": 8, "maxSupply": "${Number.MAX_SAFE_INTEGER}" }`));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Harpagon', 'tokens', 'issue', `{ "symbol": "NTK", "quantity": "${Number.MAX_SAFE_INTEGER}", "to": "Satoshi", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "NTK", "quantity": "0.00000001", "to": "Vitalik", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: FORK_BLOCK_NUMBER,
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
            account: 'Satoshi',
            symbol: "TKN"
          }
        }
      });

      const balanceSatoshi = res.payload;

      assert.equal(balanceSatoshi.balance, 99.89999997);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'Vitalik',
            symbol: "TKN"
          }
        }
      });

      const balanceVitalik = res.payload;

      assert.equal(balanceVitalik.balance, 0.10000003);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'Satoshi',
            symbol: "NTK"
          }
        }
      });

      const balNTKSatoshi = res.payload;

      assert.equal(balNTKSatoshi.balance, BigNumber(Number.MAX_SAFE_INTEGER).minus("0.00000001").toFixed(8));

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'Vitalik',
            symbol: "NTK"
          }
        }
      });

      const balNTKVitalik = res.payload;

      assert.equal(balNTKVitalik.balance, "0.00000001");

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('generates errors when trying to transfer tokens with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "Harpagon", "quantity": 1000, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(30529000, 'TXID1235', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 0, "maxSupply": 1000 }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": 100, "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": 7.99999999, "to": "Vitalik" }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": 7.99999999, "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": 7.99999999, "to": "aa", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TNK", "quantity": 7.99999999, "to": "Vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": 7.999999999, "to": "Vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": -1, "to": "Vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Vitalik', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": 101, "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": 101, "to": "Vitalik", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 30529000,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
        payload: 1,
      });

      const block1 = res.payload;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[3].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'cannot transfer to self');
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'must transfer positive quantity');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'balance does not exist');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'overdrawn balance');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('generates errors when trying to transfer tokens with wrong parameters v2', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "Harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1235', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 0, "maxSupply": "1000" }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": "7.99999999", "to": "Vitalik" }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": "7.99999999", "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": "7.99999999", "to": "aa", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TNK", "quantity": "7.99999999", "to": "Vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": "7.999999999", "to": "Vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": "-1", "to": "Vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Vitalik', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": "101", "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": "101", "to": "Vitalik", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
        payload: 1,
      });

      const block1 = res.payload;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[3].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'cannot transfer to self');
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'must transfer positive quantity');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'balance does not exist');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'overdrawn balance');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('transfers tokens to a contract', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = function (payload) {
          // Initialize the smart contract via the create action
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testContract',
        params: '',
        code: base64SmartContractCode,
      };

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));

      let block = {
        refSteemBlockNumber: 30529000,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "Harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1235', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1237', 'Satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "7.99999999", "to": "testContract", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: FORK_BLOCK_NUMBER,
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
            account: 'Satoshi',
            symbol: "TKN"
          }
        }
      });

      const balanceSatoshi = res.payload;

      assert.equal(balanceSatoshi.balance, 92.00000001);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            account: 'testContract',
            symbol: "TKN"
          }
        }
      });

      const testContract = res.payload;

      assert.equal(testContract.balance, 7.99999999);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('generates errors when trying to transfer tokens to a contract with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "Harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1235', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 0, "maxSupply": "1000" }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "7.99999999", "to": "testContract" }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "7.99999999", "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "7.99999999", "to": "ah", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'tokens', 'transferToContract', '{ "symbol": "TNK", "quantity": "7.99999999", "to": "testContract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "7.999999999", "to": "testContract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "-1", "to": "testContract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Vitalik', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "101", "to": "testContract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "101", "to": "testContract", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
        payload: 1,
      });

      const block1 = res.payload;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[3].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'cannot transfer to self');
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'must transfer positive quantity');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'balance does not exist');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'overdrawn balance');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('transfers tokens from a contract to a user', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = function (payload) {
          // Initialize the smart contract via the create action
        }

        actions.sendRewards = async function (payload) {
          const { to, quantity } = payload;
          await transferTokens(to, 'TKN', quantity, 'user');
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testContract',
        params: '',
        code: base64SmartContractCode,
      };

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));

      let block = {
        refSteemBlockNumber: 30529000,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "Harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1235', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1237', 'Satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "7.99999999", "to": "testContract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1238', 'Satoshi', 'testContract', 'sendRewards', '{ "quantity": "5.99999999", "to": "Vitalik", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: { $in: ['Satoshi', 'Vitalik'] },
            symbol: "TKN"
          }
        }
      });

      const balances = res.payload;

      assert.equal(balances[0].balance, 92.00000001);
      assert.equal(balances[1].balance, 5.99999999);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            account: 'testContract',
            symbol: "TKN"
          }
        }
      });

      const testContract = res.payload;

      assert.equal(testContract.balance, 2);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('generates errors when trying to transfer tokens from a contract to a user with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async function (payload) {
          // Initialize the smart contract via the create action
        }

        actions.notSigned = async function (payload) {
          await transferTokens('to', 'TKN', '2.02', 'user');
        }

        actions.toNotExist = async function (payload) {
          await transferTokens('df', 'TKN', '2.02', 'user');
        }

        actions.symbolNotExist = async function (payload) {
          await transferTokens('Satoshi', 'TNK', '2.02', 'user');
        }

        actions.wrongPrecision = async function (payload) {
          await transferTokens('Satoshi', 'TKN', '2.02', 'user');
        }

        actions.negativeQty = async function (payload) {
          await transferTokens('Satoshi', 'TKN', '-2', 'user');
        }

        actions.balanceNotExist = async function (payload) {
          await transferTokens('Satoshi', 'TKN', '2', 'user');
        }

        actions.overdrawnBalance = async function (payload) {
          await transferTokens('Satoshi', 'TKN', '2', 'user');
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testContract',
        params: '',
        code: base64SmartContractCode,
      };

      let transactions = [];
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "Harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1235', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 0, "maxSupply": "1000" }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'testContract', 'notSigned', '{ }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'testContract', 'toNotExist', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'testContract', 'symbolNotExist', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'testContract', 'wrongPrecision', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'testContract', 'negativeQty', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'testContract', 'balanceNotExist', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1237', 'Satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "1", "to": "testContract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'testContract', 'overdrawnBalance', '{ "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
        payload: 1,
      });

      const block1 = res.payload;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'must transfer positive quantity');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'balance does not exist');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'overdrawn balance');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('transfers tokens from a contract to a contract', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = function (payload) {
          // Initialize the smart contract via the create action
        }

        actions.sendRewards = async function (payload) {
          const { to, quantity } = payload;
          await transferTokens(to, 'TKN', quantity, 'contract');
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testContract',
        params: '',
        code: base64SmartContractCode,
      };

      const smartContractCode2 = `
        actions.createSSC = function (payload) {
          // Initialize the smart contract via the create action
        }
      `;

      const base64SmartContractCode2 = Base64.encode(smartContractCode2);

      const contractPayload2 = {
        name: 'testContract2',
        params: '',
        code: base64SmartContractCode2,
      };

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(30529000, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload2)));

      let block = {
        refSteemBlockNumber: 30529000,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "Harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1235', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1237', 'Satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "7.99999999", "to": "testContract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1238', 'Satoshi', 'testContract', 'sendRewards', '{ "quantity": "5.99999999", "to": "testContract2", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: { $in: ['Satoshi'] },
            symbol: "TKN"
          }
        }
      });

      const balances = res.payload;

      assert.equal(balances[0].balance, 92.00000001);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            symbol: "TKN"
          }
        }
      });

      const contractsBalances = res.payload;

      assert.equal(contractsBalances[0].balance, 2);
      assert.equal(contractsBalances[1].balance, 5.99999999);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('generates errors when trying to transfer tokens from a contract to another contract with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async function (payload) {
          // Initialize the smart contract via the create action
        }

        actions.notSigned = async function (payload) {
          await transferTokens('to', 'TKN', '2.02', 'contract');
        }

        actions.notToSelf = async function (payload) {
          await transferTokens('testContract', 'TKN', '2.02', 'contract');
        }

        actions.toNotExist = async function (payload) {
          await transferTokens('sd', 'TKN', '2.02', 'contract');
        }

        actions.symbolNotExist = async function (payload) {
          await transferTokens('testContract2', 'TNK', '2.02', 'contract');
        }

        actions.wrongPrecision = async function (payload) {
          await transferTokens('testContract2', 'TKN', '2.02', 'contract');
        }

        actions.negativeQty = async function (payload) {
          await transferTokens('testContract2', 'TKN', '-2', 'contract');
        }

        actions.balanceNotExist = async function (payload) {
          await transferTokens('testContract2', 'TKN', '2', 'contract');
        }

        actions.overdrawnBalance = async function (payload) {
          await transferTokens('testContract2', 'TKN', '2', 'contract');
        }

        actions.invalidParams = async function (payload) {
          await transferTokens('testContract2', 'TKN', '2', 'invalid');
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testContract',
        params: '',
        code: base64SmartContractCode,
      };

      const smartContractCode2 = `
        actions.createSSC = function (payload) {
          // Initialize the smart contract via the create action
        }
      `;

      const base64SmartContractCode2 = Base64.encode(smartContractCode2);

      const contractPayload2 = {
        name: 'testContract2',
        params: '',
        code: base64SmartContractCode2,
      };

      let transactions = [];
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload2)));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "Harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1235', 'Harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 0, "maxSupply": "1000" }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'testContract', 'notSigned', '{ }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'testContract', 'notToSelf', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'testContract', 'toNotExist', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'testContract', 'symbolNotExist', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'testContract', 'wrongPrecision', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'testContract', 'negativeQty', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'testContract', 'balanceNotExist', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1237', 'Satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "1", "to": "testContract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'testContract', 'overdrawnBalance', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'Satoshi', 'testContract', 'invalidParams', '{ "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
        payload: 1,
      });

      const block1 = res.payload;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'cannot transfer to self');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'must transfer positive quantity');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'balance does not exist');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[0], 'overdrawn balance');
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'invalid params');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
});

// sscstore
describe('sscstore smart contract', () => {

  it('should buy tokens', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1236', 'Satoshi', 'sscstore', 'buy', '{ "recipient": "steemsc", "amountSTEEMSBD": "0.001 STEEM", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 30529000,
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
            account: 'Satoshi',
            symbol: BP_CONSTANTS.UTILITY_TOKEN_SYMBOL
          }
        }
      });

      const balanceSatoshi = res.payload;

      assert.equal(balanceSatoshi.balance, SSC_STORE_QTY);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not buy tokens', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1236', 'Satoshi', 'sscstore', 'buy', '{ "recipient": "Satoshi", "amountSTEEMSBD": "0.001 STEEM", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 30529000,
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
            account: 'Satoshi',
            symbol: BP_CONSTANTS.UTILITY_TOKEN_SYMBOL
          }
        }
      });

      let balanceSatoshi = res.payload;

      assert.equal(balanceSatoshi, null);

      transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1236', 'steemsc', 'sscstore', 'updateParams', '{ "priceSBD": 0.001, "priceSteem": 0.001, "quantity": 1, "disabled": true }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Satoshi', 'sscstore', 'buy', '{ "recipient": "steemsc", "amountSTEEMSBD": "0.001 STEEM", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 30529000,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'Satoshi',
            symbol: BP_CONSTANTS.UTILITY_TOKEN_SYMBOL
          }
        }
      });

      balanceSatoshi = res.payload;

      assert.equal(balanceSatoshi, null);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });


  it('should update params', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1236', 'steemsc', 'sscstore', 'updateParams', '{ "priceSBD": 0.002, "priceSteem": 0.003, "quantity": 5, "disabled": true }'));

      let block = {
        refSteemBlockNumber: 30529000,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'sscstore',
          table: 'params',
          query: {
          }
        }
      });

      let params = res.payload;

      assert.equal(params.priceSBD, 0.002);
      assert.equal(params.priceSteem, 0.003);
      assert.equal(params.quantity, 5);
      assert.equal(params.disabled, true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not update params', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1236', 'steemsc', 'sscstore', 'updateParams', '{ "priceSBD": 0.002, "priceSteem": 0.003, "quantity": 5, "disabled": true }'));
      transactions.push(new Transaction(30529000, 'TXID1236', 'Satoshi', 'sscstore', 'updateParams', '{ "priceSBD": 0.001, "priceSteem": 0.001, "quantity": 1000000, "disabled": false }'));

      let block = {
        refSteemBlockNumber: 30529000,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'sscstore',
          table: 'params',
          query: {
          }
        }
      });

      let params = res.payload;

      assert.equal(params.priceSBD, 0.002);
      assert.equal(params.priceSteem, 0.003);
      assert.equal(params.quantity, 5);
      assert.equal(params.disabled, true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
});
