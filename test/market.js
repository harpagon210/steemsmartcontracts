/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const fs = require('fs-extra');

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

let tknContractPayload = {
  name: 'tokens',
  params: '',
  code: base64ContractCode,
};

contractCode = fs.readFileSync('./contracts/steempegged.js');
contractCode = contractCode.toString();
contractCode = contractCode.replace(/'\$\{BP_CONSTANTS.ACCOUNT_RECEIVING_FEES\}\$'/g, CONSTANTS.ACCOUNT_RECEIVING_FEES);
base64ContractCode = Base64.encode(contractCode);

let spContractPayload = {
  name: 'steempegged',
  params: '',
  code: base64ContractCode,
};

contractCode = fs.readFileSync('./contracts/market.js');
contractCode = contractCode.toString();
base64ContractCode = Base64.encode(contractCode);

let mktContractPayload = {
  name: 'market',
  params: '',
  code: base64ContractCode,
};

// Market
describe('Market', () => {
  it('creates a buy order', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1231', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1232', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1233', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 5, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1234', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "satoshi", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1235', 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": "876.988", "price": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 1,
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
            symbol: 'STEEMP',
            account: 'satoshi'
          }
        }
      });

      let balances = res.payload;
      assert.equal(balances[0].balance, '123.45599123');
      assert.equal(balances[0].account, 'satoshi');
      assert.equal(balances[0].symbol, 'STEEMP');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            symbol: 'STEEMP'
          }
        }
      });

      balances = res.payload;

      assert.equal(balances[0].balance, '0.00000877');
      assert.equal(balances[0].account, 'market');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'buyBook',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      const sellOrders = res.payload;

      assert.equal(sellOrders[0].txId, 'TXID1235');
      assert.equal(sellOrders[0].account, 'satoshi');
      assert.equal(sellOrders[0].symbol, 'TKN');
      assert.equal(sellOrders[0].price, '0.00000001');
      assert.equal(sellOrders[0].quantity, 876.988);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('creates buy orders with expirations', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1231', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1232', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1233', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 5, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1234', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "satoshi", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1235', 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": "1", "price": "0.00000001", "expiration": 2592000, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1236', 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": "2", "price": "0.00000001", "expiration": 10, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1237', 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": "3", "price": "0.00000001", "expiration": 30000000, "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'buyBook',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      const sellOrders = res.payload;

      assert.equal(sellOrders[0].txId, 'TXID1237');
      assert.equal(sellOrders[0].account, 'satoshi');
      assert.equal(sellOrders[0].symbol, 'TKN');
      assert.equal(sellOrders[0].price, '0.00000001');
      assert.equal(sellOrders[0].quantity, 3);
      assert.equal(sellOrders[0].timestamp, 1527811200);
      assert.equal(sellOrders[0].expiration, 1527811200 + 2592000);

      assert.equal(sellOrders[1].txId, 'TXID1236');
      assert.equal(sellOrders[1].account, 'satoshi');
      assert.equal(sellOrders[1].symbol, 'TKN');
      assert.equal(sellOrders[1].price, '0.00000001');
      assert.equal(sellOrders[1].quantity, 2);
      assert.equal(sellOrders[1].timestamp, 1527811200);
      assert.equal(sellOrders[1].expiration, 1527811200 + 10);

      assert.equal(sellOrders[2].txId, 'TXID1235');
      assert.equal(sellOrders[2].account, 'satoshi');
      assert.equal(sellOrders[2].symbol, 'TKN');
      assert.equal(sellOrders[2].price, '0.00000001');
      assert.equal(sellOrders[2].quantity, 1);
      assert.equal(sellOrders[2].timestamp, 1527811200);
      assert.equal(sellOrders[2].expiration, 1527811200 + 2592000);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('generates error when trying to create a buy order with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1231', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1232', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1233', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 5, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1234', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "satoshi", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1235', 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": "0.1", "price": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 1,
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
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'order cannot be placed as it cannot be filled');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('creates sell orders with expirations', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1231', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1232', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1233', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 5, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1234', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "satoshi", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1235', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "1", "price": "0.00000001", "expiration": 2592000, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1236', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "2", "price": "0.00000001", "expiration": 10, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1237', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "3", "price": "0.00000001", "expiration": 30000000, "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'sellBook',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      const sellOrders = res.payload;

      assert.equal(sellOrders[0].txId, 'TXID1237');
      assert.equal(sellOrders[0].account, 'satoshi');
      assert.equal(sellOrders[0].symbol, 'TKN');
      assert.equal(sellOrders[0].price, '0.00000001');
      assert.equal(sellOrders[0].quantity, 3);
      assert.equal(sellOrders[0].timestamp, 1527811200);
      assert.equal(sellOrders[0].expiration, 1527811200 + 2592000);

      assert.equal(sellOrders[1].txId, 'TXID1236');
      assert.equal(sellOrders[1].account, 'satoshi');
      assert.equal(sellOrders[1].symbol, 'TKN');
      assert.equal(sellOrders[1].price, '0.00000001');
      assert.equal(sellOrders[1].quantity, 2);
      assert.equal(sellOrders[1].timestamp, 1527811200);
      assert.equal(sellOrders[1].expiration, 1527811200 + 10);

      assert.equal(sellOrders[2].txId, 'TXID1235');
      assert.equal(sellOrders[2].account, 'satoshi');
      assert.equal(sellOrders[2].symbol, 'TKN');
      assert.equal(sellOrders[2].price, '0.00000001');
      assert.equal(sellOrders[2].quantity, 1);
      assert.equal(sellOrders[2].timestamp, 1527811200);
      assert.equal(sellOrders[2].expiration, 1527811200 + 2592000);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('creates a sell order', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1231', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1232', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1233', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1234', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "satoshi", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1235', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "100.276", "price": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 1,
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
            symbol: 'TKN',
            account: 'satoshi',
          }
        }
      });

      let balances = res.payload;

      assert.equal(balances[0].balance, 23.18);
      assert.equal(balances[0].account, 'satoshi');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            symbol: 'TKN'
          }
        }
      });

      balances = res.payload;

      assert.equal(balances[0].balance, 100.276);
      assert.equal(balances[0].account, 'market');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'sellBook',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      const sellOrders = res.payload;

      assert.equal(sellOrders[0].txId, 'TXID1235');
      assert.equal(sellOrders[0].account, 'satoshi');
      assert.equal(sellOrders[0].symbol, 'TKN');
      assert.equal(sellOrders[0].price, '0.00000001');
      assert.equal(sellOrders[0].quantity, 100.276);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('generates error when trying to create a sell order with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1231', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1232', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1233', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1234', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "satoshi", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1235', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "0.001", "price": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 1,
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

      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'order cannot be placed as it cannot be filled');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('cancels a buy order', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1231', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1232', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1233', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1234', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "satoshi", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1235', 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": "1000", "price": "0.001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 1,
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
            symbol: 'STEEMP',
            account: 'satoshi'
          }
        }
      });

      let balances = res.payload;

      assert.equal(balances[0].balance, 122.456);
      assert.equal(balances[0].account, 'satoshi');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            symbol: 'STEEMP'
          }
        }
      });

      balances = res.payload;

      assert.equal(balances[0].balance, 1);
      assert.equal(balances[0].account, 'market');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'buyBook',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      const sellOrders = res.payload;

      assert.equal(sellOrders[0].txId, 'TXID1235');
      assert.equal(sellOrders[0].account, 'satoshi');
      assert.equal(sellOrders[0].symbol, 'TKN');
      assert.equal(sellOrders[0].price, 0.001);
      assert.equal(sellOrders[0].quantity, 1000);

      transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1236', 'satoshi', 'market', 'cancel', '{ "id": "TXID1235", "type": "buy", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: CONSTANTS.FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            symbol: 'STEEMP',
            account: {
              $in: ['satoshi']
            }
          }
        }
      });

      balances = res.payload;

      assert.equal(balances[0].balance, 123.456);
      assert.equal(balances[0].account, 'satoshi');
      assert.equal(balances[0].symbol, 'STEEMP');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'market',
          table: 'buyBook',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      assert.equal(res.payload, null);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('cancels a sell order', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1231', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1232', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1233', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1234', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "satoshi", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1235', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "100", "price": "0.234", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 1,
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
            symbol: 'TKN',
            account: {
              $in: ['satoshi']
            }
          }
        }
      });

      let balances = res.payload;

      assert.equal(balances[0].balance, 23.456);
      assert.equal(balances[0].account, 'satoshi');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            symbol: 'TKN',
            account: 'market'
          }
        }
      });

      balances = res.payload;

      assert.equal(balances[0].balance, 100);
      assert.equal(balances[0].account, 'market');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'sellBook',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      const sellOrders = res.payload;

      assert.equal(sellOrders[0].txId, 'TXID1235');
      assert.equal(sellOrders[0].account, 'satoshi');
      assert.equal(sellOrders[0].symbol, 'TKN');
      assert.equal(sellOrders[0].price, 0.234);
      assert.equal(sellOrders[0].quantity, 100);

      transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1236', 'satoshi', 'market', 'cancel', '{ "id": "TXID1235", "type": "sell", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: CONSTANTS.FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            symbol: 'TKN',
            account: {
              $in: ['satoshi']
            }
          }
        }
      });

      balances = res.payload;

      assert.equal(balances[0].balance, 123.456);
      assert.equal(balances[0].account, 'satoshi');
      assert.equal(balances[0].symbol, 'TKN');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'market',
          table: 'sellBook',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      assert.equal(res.payload, null);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('buys from the market from one seller', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1231', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1232', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1234', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1235', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "vitalik", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1236', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "satoshi", "quantity": "456.789", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1237', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "100", "price": "0.234", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1238', 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": "10", "price": "0.234", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 1,
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
            symbol: { $in: ['TKN', 'STEEMP'] },
            account: { $in: ['satoshi', 'vitalik'] }
          }
        }
      });

      let balances = res.payload;

      assert.equal(balances[0].account, 'vitalik');
      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].balance, 23.456);

      assert.equal(balances[1].account, 'satoshi');
      assert.equal(balances[1].symbol, 'STEEMP');
      assert.equal(balances[1].balance, 454.449);

      assert.equal(balances[2].account, 'satoshi');
      assert.equal(balances[2].symbol, 'TKN');
      assert.equal(balances[2].balance, 10);

      assert.equal(balances[3].account, 'vitalik');
      assert.equal(balances[3].symbol, 'STEEMP');
      assert.equal(balances[3].balance, 2.34);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            symbol: 'TKN'
          }
        }
      });

      balances = res.payload;

      assert.equal(balances[0].balance, 90);
      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].account, 'market');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'sellBook',
          query: {
            account: 'vitalik',
            symbol: 'TKN'
          }
        }
      });

      const sellOrders = res.payload;

      assert.equal(sellOrders[0].txId, 'TXID1237');
      assert.equal(sellOrders[0].account, 'vitalik');
      assert.equal(sellOrders[0].symbol, 'TKN');
      assert.equal(sellOrders[0].price, 0.234);
      assert.equal(sellOrders[0].quantity, 90);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('buys from the market from several sellers', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1231', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1232', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://TKN.token.com", "symbol": "TKN", "precision": 3, "maxSupply": "100000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1236', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "harpagon", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1237', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "satoshi", "quantity": "200", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1238', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "vitalik", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1239', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "dan", "quantity": "300", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1240', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "2", "price": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1241', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1242', 'dan', 'market', 'sell', '{ "symbol": "TKN", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1243', 'harpagon', 'market', 'buy', '{ "symbol": "TKN", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 1,
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
            symbol: { $in: ['TKN', 'STEEMP'] },
            account: { $in: ['satoshi', 'vitalik', 'dan', 'harpagon'] }
          }
        }
      });

      const balances = res.payload;

      assert.equal(balances[0].account, 'harpagon');
      assert.equal(balances[0].symbol, 'STEEMP');
      assert.equal(balances[0].balance, 477);

      assert.equal(balances[1].account, 'harpagon');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, 10);

      assert.equal(balances[2].account, 'satoshi');
      assert.equal(balances[2].symbol, 'TKN');
      assert.equal(balances[2].balance, 198);

      assert.equal(balances[3].account, 'vitalik');
      assert.equal(balances[3].symbol, 'TKN');
      assert.equal(balances[3].balance, 97);

      assert.equal(balances[4].account, 'dan');
      assert.equal(balances[4].symbol, 'TKN');
      assert.equal(balances[4].balance, 295);

      assert.equal(balances[5].account, 'satoshi');
      assert.equal(balances[5].symbol, 'STEEMP');
      assert.equal(balances[5].balance, 2);

      assert.equal(balances[6].account, 'vitalik');
      assert.equal(balances[6].symbol, 'STEEMP');
      assert.equal(balances[6].balance, 6);

      assert.equal(balances[7].account, 'dan');
      assert.equal(balances[7].symbol, 'STEEMP');
      assert.equal(balances[7].balance, 15);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('buys from the market partially', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1231', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1232', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://TKN.token.com", "symbol": "TKN", "precision": 3, "maxSupply": "100000" }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1236', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "harpagon", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1237', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "satoshi", "quantity": "200", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1238', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "vitalik", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1239', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "dan", "quantity": "300", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1240', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "2", "price": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1241', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1242', 'dan', 'market', 'sell', '{ "symbol": "TKN", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1243', 'harpagon', 'market', 'buy', '{ "symbol": "TKN", "quantity": "15", "price": "3", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 1,
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
            symbol: { $in: ['TKN', 'STEEMP'] },
            account: { $in: ['null', 'satoshi', 'vitalik', 'dan', 'harpagon'] }
          }
        }
      });

      let balances = res.payload;

      assert.equal(balances[0].account, 'harpagon');
      assert.equal(balances[0].symbol, 'STEEMP');
      assert.equal(balances[0].balance, 455);

      assert.equal(balances[1].account, 'harpagon');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, 10);

      assert.equal(balances[2].account, 'satoshi');
      assert.equal(balances[2].symbol, 'TKN');
      assert.equal(balances[2].balance, 198);

      assert.equal(balances[3].account, 'vitalik');
      assert.equal(balances[3].symbol, 'TKN');
      assert.equal(balances[3].balance, 97);

      assert.equal(balances[4].account, 'dan');
      assert.equal(balances[4].symbol, 'TKN');
      assert.equal(balances[4].balance, 295);

      assert.equal(balances[5].account, 'satoshi');
      assert.equal(balances[5].symbol, 'STEEMP');
      assert.equal(balances[5].balance, 2);

      assert.equal(balances[6].account, 'vitalik');
      assert.equal(balances[6].symbol, 'STEEMP');
      assert.equal(balances[6].balance, 6);

      assert.equal(balances[7].account, 'dan');
      assert.equal(balances[7].symbol, 'STEEMP');
      assert.equal(balances[7].balance, 15);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            symbol: 'STEEMP'
          }
        }
      });

      balances = res.payload;

      assert.equal(balances[0].balance, 22);
      assert.equal(balances[0].symbol, 'STEEMP');
      assert.equal(balances[0].account, 'market');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'buyBook',
          query: {
            account: 'harpagon',
            symbol: 'TKN'
          }
        }
      });

      const sellOrders = res.payload;

      assert.equal(sellOrders[0].txId, 'TXID1243');
      assert.equal(sellOrders[0].account, 'harpagon');
      assert.equal(sellOrders[0].symbol, 'TKN');
      assert.equal(sellOrders[0].price, 3);
      assert.equal(sellOrders[0].quantity, 5);
      assert.equal(sellOrders[0].tokensLocked, 22);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('sells on the market to one buyer', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1229', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1228', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1227', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1231', 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1232', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1233', 'vitalik', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1234', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1235', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "vitalik", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1236', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "satoshi", "quantity": "456.789", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1238', 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": "100", "price": "0.234", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1237', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "10", "price": "0.234", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 1,
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
            symbol: { $in: ['TKN', 'STEEMP'] },
            account: { $in: ['satoshi', 'vitalik'] }
          }
        }
      });

      let balances = res.payload;

      assert.equal(balances[0].account, 'vitalik');
      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].balance, 113.456);

      assert.equal(balances[1].account, 'satoshi');
      assert.equal(balances[1].symbol, 'STEEMP');
      assert.equal(balances[1].balance, 433.389);

      assert.equal(balances[2].account, 'satoshi');
      assert.equal(balances[2].symbol, 'TKN');
      assert.equal(balances[2].balance, 10);

      assert.equal(balances[3].account, 'vitalik');
      assert.equal(balances[3].symbol, 'STEEMP');
      assert.equal(balances[3].balance, 2.34);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            symbol: 'STEEMP'
          }
        }
      });

      balances = res.payload;

      assert.equal(balances[0].balance, 21.06);
      assert.equal(balances[0].symbol, 'STEEMP');
      assert.equal(balances[0].account, 'market');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'buyBook',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      const buyOrders = res.payload;

      assert.equal(buyOrders[0].txId, 'TXID1238');
      assert.equal(buyOrders[0].account, 'satoshi');
      assert.equal(buyOrders[0].symbol, 'TKN');
      assert.equal(buyOrders[0].price, 0.234);
      assert.equal(buyOrders[0].quantity, 90);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('sells on the market to several buyers', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1229', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1228', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1227', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1231', 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1232', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1233', 'vitalik', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1234', 'dan', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://TKN.token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "harpagon", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1237', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "satoshi", "quantity": "200", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1238', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "vitalik", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1239', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "dan", "quantity": "300", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1240', 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": "2", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1241', 'vitalik', 'market', 'buy', '{ "symbol": "TKN", "quantity": "3", "price": "4", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1242', 'dan', 'market', 'buy', '{ "symbol": "TKN", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1243', 'harpagon', 'market', 'sell', '{ "symbol": "TKN", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 1,
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
            symbol: { $in: ['TKN', 'STEEMP'] },
            account: { $in: ['satoshi', 'vitalik', 'dan', 'harpagon'] }
          }
        }
      });

      const balances = res.payload;

      assert.equal(balances[0].account, 'harpagon');
      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].balance, 490);

      assert.equal(balances[1].account, 'satoshi');
      assert.equal(balances[1].symbol, 'STEEMP');
      assert.equal(balances[1].balance, 194);

      assert.equal(balances[2].account, 'vitalik');
      assert.equal(balances[2].symbol, 'STEEMP');
      assert.equal(balances[2].balance, 88);

      assert.equal(balances[3].account, 'dan');
      assert.equal(balances[3].symbol, 'STEEMP');
      assert.equal(balances[3].balance, 285);

      assert.equal(balances[4].account, 'vitalik');
      assert.equal(balances[4].symbol, 'TKN');
      assert.equal(balances[4].balance, 3);

      assert.equal(balances[5].account, 'harpagon');
      assert.equal(balances[5].symbol, 'STEEMP');
      assert.equal(balances[5].balance, 33);

      assert.equal(balances[6].account, 'satoshi');
      assert.equal(balances[6].symbol, 'TKN');
      assert.equal(balances[6].balance, 2);

      assert.equal(balances[7].account, 'dan');
      assert.equal(balances[7].symbol, 'TKN');
      assert.equal(balances[7].balance, 5);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('fills a buy order from different sellers', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1229', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1228', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1227', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1231', 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1232', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1233', 'vitalik', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1234', 'dan', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://TKN.token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1236', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "harpagon", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1237', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "satoshi", "quantity": "200", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1238', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "vitalik", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1239', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "dan", "quantity": "300", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1243', 'harpagon', 'market', 'buy', '{ "symbol": "TKN", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1240', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "2", "price": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1241', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1242', 'dan', 'market', 'sell', '{ "symbol": "TKN", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 1,
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
            symbol: { $in: ['TKN', 'STEEMP'] },
            account: { $in: ['satoshi', 'vitalik', 'dan', 'harpagon'] }
          }
        }
      });

      const balances = res.payload;

      assert.equal(balances[0].account, 'harpagon');
      assert.equal(balances[0].symbol, 'STEEMP');
      assert.equal(balances[0].balance, 470);

      assert.equal(balances[1].account, 'harpagon');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, 10);

      assert.equal(balances[2].account, 'satoshi');
      assert.equal(balances[2].symbol, 'TKN');
      assert.equal(balances[2].balance, 198);

      assert.equal(balances[3].account, 'vitalik');
      assert.equal(balances[3].symbol, 'TKN');
      assert.equal(balances[3].balance, 97);

      assert.equal(balances[4].account, 'dan');
      assert.equal(balances[4].symbol, 'TKN');
      assert.equal(balances[4].balance, 295);

      assert.equal(balances[5].account, 'satoshi');
      assert.equal(balances[5].symbol, 'STEEMP');
      assert.equal(balances[5].balance, 6);

      assert.equal(balances[6].account, 'vitalik');
      assert.equal(balances[6].symbol, 'STEEMP');
      assert.equal(balances[6].balance, 9);

      assert.equal(balances[7].account, 'dan');
      assert.equal(balances[7].symbol, 'STEEMP');
      assert.equal(balances[7].balance, 15);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('creates a trade history', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1229', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1228', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1227', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1231', 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1232', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1233', 'vitalik', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1234', 'dan', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://TKN.token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1236', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "harpagon", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1237', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "satoshi", "quantity": "200", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1238', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "vitalik", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1239', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "dan", "quantity": "300", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1243', 'harpagon', 'market', 'buy', '{ "symbol": "TKN", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1240', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "2", "price": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1241', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1242', 'dan', 'market', 'sell', '{ "symbol": "TKN", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'tradesHistory',
          query: {

          }
        }
      });

      let trades = res.payload;

      assert.equal(trades[0].type, 'sell');
      assert.equal(trades[0].symbol, 'TKN');
      assert.equal(trades[0].quantity, 2);
      assert.equal(trades[0].price, 3);
      assert.equal(trades[0].timestamp, 1527811200);

      assert.equal(trades[1].type, 'sell');
      assert.equal(trades[1].symbol, 'TKN');
      assert.equal(trades[1].quantity, 3);
      assert.equal(trades[1].price, 3);
      assert.equal(trades[1].timestamp, 1527811200);

      assert.equal(trades[2].type, 'sell');
      assert.equal(trades[2].symbol, 'TKN');
      assert.equal(trades[2].quantity, 5);
      assert.equal(trades[2].price, 3);
      assert.equal(trades[2].timestamp, 1527811200);

      transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12351', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://TKN.token.com", "symbol": "BTC", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12372', 'harpagon', 'tokens', 'issue', '{ "symbol": "BTC", "to": "satoshi", "quantity": "200", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12383', 'harpagon', 'tokens', 'issue', '{ "symbol": "BTC", "to": "vitalik", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12394', 'harpagon', 'tokens', 'issue', '{ "symbol": "BTC", "to": "dan", "quantity": "300", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12405', 'satoshi', 'market', 'sell', '{ "symbol": "BTC", "quantity": "2", "price": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12416', 'vitalik', 'market', 'sell', '{ "symbol": "BTC", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12427', 'dan', 'market', 'sell', '{ "symbol": "BTC", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12438', 'harpagon', 'market', 'buy', '{ "symbol": "BTC", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: CONSTANTS.FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T01:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'tradesHistory',
          query: {

          }
        }
      });

      trades = res.payload;

      assert.equal(trades[0].type, 'sell');
      assert.equal(trades[0].symbol, 'TKN');
      assert.equal(trades[0].quantity, 2);
      assert.equal(trades[0].price, 3);
      assert.equal(trades[0].timestamp, 1527811200);

      assert.equal(trades[1].type, 'sell');
      assert.equal(trades[1].symbol, 'TKN');
      assert.equal(trades[1].quantity, 3);
      assert.equal(trades[1].price, 3);
      assert.equal(trades[1].timestamp, 1527811200);

      assert.equal(trades[2].type, 'sell');
      assert.equal(trades[2].symbol, 'TKN');
      assert.equal(trades[2].quantity, 5);
      assert.equal(trades[2].price, 3);
      assert.equal(trades[2].timestamp, 1527811200);

      assert.equal(trades[3].type, 'buy');
      assert.equal(trades[3].symbol, 'BTC');
      assert.equal(trades[3].quantity, 2);
      assert.equal(trades[3].price, 1);
      assert.equal(trades[3].timestamp, 1527814800);

      assert.equal(trades[4].type, 'buy');
      assert.equal(trades[4].symbol, 'BTC');
      assert.equal(trades[4].quantity, 3);
      assert.equal(trades[4].price, 2);
      assert.equal(trades[4].timestamp, 1527814800);

      assert.equal(trades[5].type, 'buy');
      assert.equal(trades[5].symbol, 'BTC');
      assert.equal(trades[5].quantity, 5);
      assert.equal(trades[5].price, 3);
      assert.equal(trades[5].timestamp, 1527814800);

      transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12432', 'harpagon', 'market', 'buy', '{ "symbol": "TKN", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12413', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12433', 'harpagon', 'market', 'buy', '{ "symbol": "BTC", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12426', 'dan', 'market', 'sell', '{ "symbol": "BTC", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: CONSTANTS.FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-03T01:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });


      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'tradesHistory',
          query: {

          }
        }
      });

      trades = res.payload;

      assert.equal(trades[0].type, 'sell');
      assert.equal(trades[0].symbol, 'TKN');
      assert.equal(trades[0].quantity, 3);
      assert.equal(trades[0].price, 3);
      assert.equal(trades[0].timestamp, 1527987600);

      assert.equal(trades[1].type, 'sell');
      assert.equal(trades[1].symbol, 'BTC');
      assert.equal(trades[1].quantity, 5);
      assert.equal(trades[1].price, 3);
      assert.equal(trades[1].timestamp, 1527987600);

      assert.equal(trades.length, 2);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('maintains the different metrics', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1229', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1228', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1227', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1231', 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1232', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1233', 'vitalik', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1234', 'dan', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://TKN.token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1236', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "harpagon", "quantity": "500", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1237', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "satoshi", "quantity": "200", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1238', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "vitalik", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1239', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "dan", "quantity": "300", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1243', 'harpagon', 'market', 'buy', '{ "symbol": "TKN", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1240', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "2", "price": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1241', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1242', 'dan', 'market', 'sell', '{ "symbol": "TKN", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T02:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'market',
          table: 'metrics',
          query: {
            symbol: 'TKN'
          }
        }
      });

      let volume = res.payload;

      assert.equal(volume.symbol, 'TKN');
      assert.equal(volume.volume, 30);
      let blockDate = new Date('2018-06-02T02:00:00.000Z')
      assert.equal(volume.volumeExpiration, blockDate.getTime() / 1000);

      transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12351', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://TKN.token.com", "symbol": "BTC", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12372', 'harpagon', 'tokens', 'issue', '{ "symbol": "BTC", "to": "satoshi", "quantity": "200", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12383', 'harpagon', 'tokens', 'issue', '{ "symbol": "BTC", "to": "vitalik", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12394', 'harpagon', 'tokens', 'issue', '{ "symbol": "BTC", "to": "dan", "quantity": "300", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12405', 'satoshi', 'market', 'sell', '{ "symbol": "BTC", "quantity": "2", "price": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12416', 'vitalik', 'market', 'sell', '{ "symbol": "BTC", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12427', 'dan', 'market', 'sell', '{ "symbol": "BTC", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12438', 'harpagon', 'market', 'buy', '{ "symbol": "BTC", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12449', 'harpagon', 'market', 'buy', '{ "symbol": "TKN", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID124510', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": "2", "price": "1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID124611', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID124712', 'dan', 'market', 'sell', '{ "symbol": "TKN", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));


      block = {
        refSteemBlockNumber: CONSTANTS.FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-02T01:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'metrics',
          query: {
          }
        }
      });

      let metrics = res.payload;

      assert.equal(metrics[0].symbol, 'TKN');
      assert.equal(metrics[0].volume, 60);
      blockDate = new Date('2018-06-03T01:00:00.000Z');
      assert.equal(metrics[0].volumeExpiration, blockDate.getTime() / 1000);

      assert.equal(metrics[1].symbol, 'BTC');
      assert.equal(metrics[1].volume, 23);
      blockDate = new Date('2018-06-03T01:00:00.000Z');
      assert.equal(metrics[1].volumeExpiration, blockDate.getTime() / 1000);

      transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12434', 'harpagon', 'market', 'buy', '{ "symbol": "TKN", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID124168', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "3", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12432', 'harpagon', 'market', 'buy', '{ "symbol": "BTC", "quantity": "10", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12426', 'dan', 'market', 'sell', '{ "symbol": "BTC", "quantity": "5", "price": "3", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: CONSTANTS.FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-03T01:01:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'metrics',
          query: {

          }
        }
      });

      metrics = res.payload;

      assert.equal(metrics[0].symbol, 'TKN');
      assert.equal(metrics[0].volume, 9);
      blockDate = new Date('2018-06-04T01:01:00.000Z');
      assert.equal(metrics[0].volumeExpiration, blockDate.getTime() / 1000);

      assert.equal(metrics[1].symbol, 'BTC');
      assert.equal(metrics[1].volume, 15);
      blockDate = new Date('2018-06-04T01:01:00.000Z');
      assert.equal(metrics[1].volumeExpiration, blockDate.getTime() / 1000);

      transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID123798', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "harpagon", "quantity": "100", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12435', 'harpagon', 'market', 'buy', '{ "symbol": "TKN", "quantity": "1", "price": "3", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID12431', 'harpagon', 'market', 'buy', '{ "symbol": "TKN", "quantity": "1", "price": "2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID124324', 'harpagon', 'market', 'sell', '{ "symbol": "TKN", "quantity": "1", "price": "5", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID124335', 'harpagon', 'market', 'sell', '{ "symbol": "TKN", "quantity": "1", "price": "4", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: CONSTANTS.FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-04T01:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'market',
          table: 'metrics',
          query: {
          }
        }
      });

      const metric = res.payload;

      assert.equal(metric.symbol, 'TKN');
      assert.equal(metric.volume, 9);
      blockDate = new Date('2018-06-04T01:01:00.000Z');
      assert.equal(metric.volumeExpiration, blockDate.getTime() / 1000);
      assert.equal(metric.lastPrice, 3);
      assert.equal(metric.highestBid, 3);
      assert.equal(metric.lowestAsk, 4);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('removes an expired sell order', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1229', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1228', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1227', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1234', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1235', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "vitalik", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1236', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "satoshi", "quantity": "456.789", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1237', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "10", "price": "0.234", "isSignedWithActiveKey": true }'));


      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'sellBook',
          query: {
            account: 'vitalik',
            symbol: 'TKN'
          }
        }
      });

      let sellOrders = res.payload;

      assert.equal(sellOrders[0].txId, 'TXID1237');
      assert.equal(sellOrders[0].account, 'vitalik');
      assert.equal(sellOrders[0].symbol, 'TKN');
      assert.equal(sellOrders[0].price, 0.234);
      assert.equal(sellOrders[0].quantity, 10);

      transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1238', 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": "100", "price": "0.234", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: CONSTANTS.FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'sellBook',
          query: {
            account: 'vitalik',
            symbol: 'TKN'
          }
        }
      });

      sellOrders = res.payload;

      assert.equal(sellOrders.length, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'buyBook',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let buyOrders = res.payload;

      assert.equal(buyOrders[0].txId, 'TXID1238');
      assert.equal(buyOrders[0].account, 'satoshi');
      assert.equal(buyOrders[0].symbol, 'TKN');
      assert.equal(buyOrders[0].price, 0.234);
      assert.equal(buyOrders[0].quantity, 100);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('removes an expired buy order', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1229', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1228', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1227', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1234', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1235', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "vitalik", "quantity": "123.456", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1236', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "satoshi", "quantity": "456.789", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1238', 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": "100", "price": "0.234", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'buyBook',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let buyOrders = res.payload;

      assert.equal(buyOrders[0].txId, 'TXID1238');
      assert.equal(buyOrders[0].account, 'satoshi');
      assert.equal(buyOrders[0].symbol, 'TKN');
      assert.equal(buyOrders[0].price, 0.234);
      assert.equal(buyOrders[0].quantity, 100);

      transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1237', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "10", "price": "0.234", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: CONSTANTS.FORK_BLOCK_NUMBER,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'buyBook',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      buyOrders = res.payload;

      assert.equal(buyOrders.length, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'sellBook',
          query: {
            account: 'vitalik',
            symbol: 'TKN'
          }
        }
      });

      sellOrders = res.payload;

      assert.equal(sellOrders[0].txId, 'TXID1237');
      assert.equal(sellOrders[0].account, 'vitalik');
      assert.equal(sellOrders[0].symbol, 'TKN');
      assert.equal(sellOrders[0].price, 0.234);
      assert.equal(sellOrders[0].quantity, 10);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('removes dust sell orders', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1229', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1228', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1227', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1234', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1235', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "vitalik", "quantity": "101", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1236', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "satoshi", "quantity": "110", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1237', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "1.4", "price": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1238', 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": "1", "price": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: CONSTANTS.FORK_BLOCK_NUMBER,
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
            symbol: { $in: ['TKN', 'STEEMP'] },
            account: { $in: ['satoshi', 'vitalik'] }
          }
        }
      });

      let balances = res.payload;

      assert.equal(balances[0].account, 'vitalik');
      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].balance, 100);

      assert.equal(balances[1].account, 'satoshi');
      assert.equal(balances[1].symbol, 'STEEMP');
      assert.equal(balances[1].balance, '109.99999999');

      assert.equal(balances[2].account, 'satoshi');
      assert.equal(balances[2].symbol, 'TKN');
      assert.equal(balances[2].balance, 1);

      assert.equal(balances[3].account, 'vitalik');
      assert.equal(balances[3].symbol, 'STEEMP');
      assert.equal(balances[3].balance, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            symbol: 'TKN'
          }
        }
      });

      balances = res.payload;

      assert.equal(balances[0].balance, 0);
      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].account, 'market');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'sellBook',
          query: {
            account: 'vitalik',
            symbol: 'TKN'
          }
        }
      });

      let sellOrders = res.payload;

      assert.equal(sellOrders.length, 0);

      transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1239', 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": "1", "price": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID123710', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "1.4", "price": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: CONSTANTS.FORK_BLOCK_NUMBER_TWO,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            symbol: { $in: ['TKN', 'STEEMP'] },
            account: { $in: ['satoshi', 'vitalik'] }
          }
        }
      });

      balances = res.payload;

      assert.equal(balances[0].account, 'vitalik');
      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].balance, 99);

      assert.equal(balances[1].account, 'satoshi');
      assert.equal(balances[1].symbol, 'STEEMP');
      assert.equal(balances[1].balance, '109.99999998');

      assert.equal(balances[2].account, 'satoshi');
      assert.equal(balances[2].symbol, 'TKN');
      assert.equal(balances[2].balance, 2);

      assert.equal(balances[3].account, 'vitalik');
      assert.equal(balances[3].symbol, 'STEEMP');
      assert.equal(balances[3].balance, '0.00000002');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            symbol: 'TKN'
          }
        }
      });

      balances = res.payload;

      assert.equal(balances[0].balance, 0);
      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].account, 'market');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'sellBook',
          query: {
            account: 'vitalik',
            symbol: 'TKN'
          }
        }
      });

      sellOrders = res.payload;

      assert.equal(sellOrders.length, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('removes dust buy orders', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1229', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1228', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER, 'TXID1227', 'steemsc', 'contract', 'update', JSON.stringify(mktContractPayload)));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1231', 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1232', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1233', 'vitalik', 'accounts', 'register', ''));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1234', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000" }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1235', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "vitalik", "quantity": "101", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1236', CONSTANTS.STEEM_PEGGED_ACCOUNT, 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "satoshi", "quantity": "110", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1238', 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": "1", "price": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID1237', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "1.4", "price": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: CONSTANTS.FORK_BLOCK_NUMBER_TWO,
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
            symbol: { $in: ['TKN', 'STEEMP'] },
            account: { $in: ['satoshi', 'vitalik'] }
          }
        }
      });

      let balances = res.payload;

      assert.equal(balances[0].account, 'vitalik');
      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].balance, 100);

      assert.equal(balances[1].account, 'satoshi');
      assert.equal(balances[1].symbol, 'STEEMP');
      assert.equal(balances[1].balance, '109.99999999');

      assert.equal(balances[2].account, 'satoshi');
      assert.equal(balances[2].symbol, 'TKN');
      assert.equal(balances[2].balance, 1);

      assert.equal(balances[3].account, 'vitalik');
      assert.equal(balances[3].symbol, 'STEEMP');
      assert.equal(balances[3].balance, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            symbol: 'STEEMP'
          }
        }
      });

      balances = res.payload;

      assert.equal(balances[0].balance, 0);
      assert.equal(balances[0].symbol, 'STEEMP');
      assert.equal(balances[0].account, 'market');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'buyBook',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let buyOrders = res.payload;

      assert.equal(buyOrders.length, 0);

      transactions = [];
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID12378', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": "1.4", "price": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(CONSTANTS.FORK_BLOCK_NUMBER_TWO, 'TXID12388', 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": "1", "price": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: CONSTANTS.FORK_BLOCK_NUMBER_TWO,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            symbol: { $in: ['TKN', 'STEEMP'] },
            account: { $in: ['satoshi', 'vitalik'] }
          }
        }
      });

      balances = res.payload;

      assert.equal(balances[0].account, 'vitalik');
      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].balance, 99);

      assert.equal(balances[1].account, 'satoshi');
      assert.equal(balances[1].symbol, 'STEEMP');
      assert.equal(balances[1].balance, '109.99999998');

      assert.equal(balances[2].account, 'satoshi');
      assert.equal(balances[2].symbol, 'TKN');
      assert.equal(balances[2].balance, 2);

      assert.equal(balances[3].account, 'vitalik');
      assert.equal(balances[3].symbol, 'STEEMP');
      assert.equal(balances[3].balance, '0.00000002');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            symbol: 'STEEMP'
          }
        }
      });

      balances = res.payload;

      assert.equal(balances[0].balance, 0);
      assert.equal(balances[0].symbol, 'STEEMP');
      assert.equal(balances[0].account, 'market');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'market',
          table: 'buyBook',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      buyOrders = res.payload;

      assert.equal(buyOrders.length, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
});
