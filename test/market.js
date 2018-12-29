/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const fs = require('fs-extra');

const database = require('../plugins/Database');
const blockchain = require('../plugins/Blockchain');
const { Block } = require('../libs/Block');
const { Transaction } = require('../libs/Transaction');

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

// Market
describe('Market', () => {
  it('creates a buy order', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });
      
      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1231', 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1232', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1233', 'harpagon', 'tokens', 'create', '{ "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 5, "maxSupply": 1000 }'));
      transactions.push(new Transaction(123456789, 'TXID1234', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "satoshi", "quantity": 123.456, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1235', 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": 100000, "price": 0.00001, "isSignedWithActiveKey": true }'));

      let block = {
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
            symbol: 'TKN'
          }
        }
      });
      
      const balances = res.payload;

      assert.equal(balances[0].balance, 122.456);
      assert.equal(balances[0].account, 'satoshi');
      assert.equal(balances[1].balance, 1);
      assert.equal(balances[1].account, 'null');

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

      assert.equal(sellOrders[0].id, 'TXID1235');
      assert.equal(sellOrders[0].account, 'satoshi');
      assert.equal(sellOrders[0].symbol, 'TKN');
      assert.equal(sellOrders[0].price, 0.00001);
      assert.equal(sellOrders[0].quantity, 100000);

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
      transactions.push(new Transaction(123456789, 'TXID1231', 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1232', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1233', 'harpagon', 'tokens', 'create', '{ "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": 1000 }'));
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "satoshi", "quantity": 123.456, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1235', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": 100, "price": 0.234, "isSignedWithActiveKey": true }'));

      let block = {
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
            account : {
              $in : ['null', 'satoshi']
            }
          }
        }
      });

      const balances = res.payload;

      assert.equal(balances[0].balance, 23.456);
      assert.equal(balances[0].account, 'satoshi');
      assert.equal(balances[1].balance, 100);
      assert.equal(balances[1].account, 'null');

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

      assert.equal(sellOrders[0].id, 'TXID1235');
      assert.equal(sellOrders[0].account, 'satoshi');
      assert.equal(sellOrders[0].symbol, 'TKN');
      assert.equal(sellOrders[0].price, 0.234);
      assert.equal(sellOrders[0].quantity, 100);

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
      transactions.push(new Transaction(123456789, 'TXID1231', 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1232', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1233', 'vitalik', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1234', 'harpagon', 'tokens', 'create', '{ "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": 1000 }'));
      transactions.push(new Transaction(123456789, 'TXID1235', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "satoshi", "quantity": 123.456, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "vitalik", "quantity": 456.789, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1237', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": 100, "price": 0.234, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1238', 'satoshi', 'market', 'buy', '{ "symbol": "TKN", "quantity": 10, "price": 0.234, "isSignedWithActiveKey": true }'));

      let block = {
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
            account: { $in: ['null', 'satoshi', 'vitalik'] }
          }
        }
      });

      const balances = res.payload;

      assert.equal(balances[0].account, 'satoshi');
      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].balance, 121.116);

      assert.equal(balances[1].account, 'vitalik');
      assert.equal(balances[1].symbol, 'STEEMP');
      assert.equal(balances[1].balance, 356.789);

      assert.equal(balances[2].account, 'null');
      assert.equal(balances[2].symbol, 'STEEMP');
      assert.equal(balances[2].balance, 90);

      assert.equal(balances[3].account, 'satoshi');
      assert.equal(balances[3].symbol, 'STEEMP');
      assert.equal(balances[3].balance, 10);

      assert.equal(balances[4].account, 'vitalik');
      assert.equal(balances[4].symbol, 'TKN');
      assert.equal(balances[4].balance, 2.34);

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

      assert.equal(sellOrders[0].id, 'TXID1237');
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
      transactions.push(new Transaction(123456789, 'TXID1231', 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1232', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1233', 'vitalik', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1234', 'dan', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "url": "https://TKN.token.com", "symbol": "TKN", "precision": 3, "maxSupply": 1000 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "harpagon", "quantity": 500, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1237', 'steemsc', 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "satoshi", "quantity": 200, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1238', 'steemsc', 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "vitalik", "quantity": 100, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1239', 'steemsc', 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "dan", "quantity": 300, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1240', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": 2, "price": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1241', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": 3, "price": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1242', 'dan', 'market', 'sell', '{ "symbol": "TKN", "quantity": 5, "price": 3, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1243', 'harpagon', 'market', 'buy', '{ "symbol": "TKN", "quantity": 10, "price": 3, "isSignedWithActiveKey": true }'));

      let block = {
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

      const balances = res.payload;
      
      assert.equal(balances[0].account, 'harpagon');
      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].balance, 477);

      assert.equal(balances[1].account, 'satoshi');
      assert.equal(balances[1].symbol, 'STEEMP');
      assert.equal(balances[1].balance, 198);

      assert.equal(balances[2].account, 'vitalik');
      assert.equal(balances[2].symbol, 'STEEMP');
      assert.equal(balances[2].balance, 97);

      assert.equal(balances[3].account, 'dan');
      assert.equal(balances[3].symbol, 'STEEMP');
      assert.equal(balances[3].balance, 295);

      assert.equal(balances[4].account, 'harpagon');
      assert.equal(balances[4].symbol, 'STEEMP');
      assert.equal(balances[4].balance, 10);

      assert.equal(balances[5].account, 'satoshi');
      assert.equal(balances[5].symbol, 'TKN');
      assert.equal(balances[5].balance, 2);

      assert.equal(balances[6].account, 'vitalik');
      assert.equal(balances[6].symbol, 'TKN');
      assert.equal(balances[6].balance, 6);

      assert.equal(balances[7].account, 'dan');
      assert.equal(balances[7].symbol, 'TKN');
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
      transactions.push(new Transaction(123456789, 'TXID1231', 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1232', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1233', 'vitalik', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1234', 'dan', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "url": "https://TKN.token.com", "symbol": "TKN", "precision": 3, "maxSupply": 1000 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "to": "harpagon", "quantity": 500, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1237', 'steemsc', 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "satoshi", "quantity": 200, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1238', 'steemsc', 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "vitalik", "quantity": 100, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1239', 'steemsc', 'tokens', 'transfer', '{ "symbol": "STEEMP", "to": "dan", "quantity": 300, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1240', 'satoshi', 'market', 'sell', '{ "symbol": "TKN", "quantity": 2, "price": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1241', 'vitalik', 'market', 'sell', '{ "symbol": "TKN", "quantity": 3, "price": 2, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1242', 'dan', 'market', 'sell', '{ "symbol": "TKN", "quantity": 5, "price": 3, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1243', 'harpagon', 'market', 'buy', '{ "symbol": "TKN", "quantity": 15, "price": 3, "isSignedWithActiveKey": true }'));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const bl = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: { }
      });

      //console.log(bl.payload.transactions)

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

      const balances = res.payload;
      console.log(balances)
      assert.equal(balances[0].account, 'harpagon');
      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].balance, 455);

      assert.equal(balances[1].account, 'satoshi');
      assert.equal(balances[1].symbol, 'STEEMP');
      assert.equal(balances[1].balance, 198);

      assert.equal(balances[2].account, 'vitalik');
      assert.equal(balances[2].symbol, 'STEEMP');
      assert.equal(balances[2].balance, 97);

      assert.equal(balances[3].account, 'dan');
      assert.equal(balances[3].symbol, 'STEEMP');
      assert.equal(balances[3].balance, 295);

      assert.equal(balances[4].account, 'null');
      assert.equal(balances[4].symbol, 'TKN');
      assert.equal(balances[4].balance, 22);

      assert.equal(balances[5].account, 'harpagon');
      assert.equal(balances[5].symbol, 'STEEMP');
      assert.equal(balances[5].balance, 10);

      assert.equal(balances[6].account, 'satoshi');
      assert.equal(balances[6].symbol, 'TKN');
      assert.equal(balances[6].balance, 2);

      assert.equal(balances[7].account, 'vitalik');
      assert.equal(balances[7].symbol, 'TKN');
      assert.equal(balances[7].balance, 6);

      assert.equal(balances[8].account, 'dan');
      assert.equal(balances[8].symbol, 'TKN');
      assert.equal(balances[8].balance, 15);

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
      console.log(sellOrders)
      assert.equal(sellOrders[0].id, 'TXID1243');
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
});
