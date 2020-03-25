/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const fs = require('fs-extra');
const { MongoClient } = require('mongodb');

const { Database } = require('../libs/Database');
const blockchain = require('../plugins/Blockchain');
const { Transaction } = require('../libs/Transaction');

const { CONSTANTS } = require('../libs/Constants');

const conf = {
  chainId: "test-chain-id",
  genesisSteemBlock: 2000000,
  dataDirectory: "./test/data/",
  databaseFileName: "database.db",
  autosaveInterval: 0,
  javascriptVMTimeout: 10000,
  databaseURL: "mongodb://localhost:27017",
  databaseName: "testssc",
  streamNodes: ["https://api.steemit.com"],
};

let plugins = {};
let jobs = new Map();
let currentJobId = 0;
let database1 = null;

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

// sscstore
describe.skip('sscstore smart contract', function() {
  this.timeout(10000);

  before((done) => {
    new Promise(async (resolve) => {
      client = await MongoClient.connect(conf.databaseURL, { useNewUrlParser: true });
      db = await client.db(conf.databaseName);
      await db.dropDatabase();
      resolve();
    })
      .then(() => {
        done()
      })
  });
  
  after((done) => {
    new Promise(async (resolve) => {
      await client.close();
      resolve();
    })
      .then(() => {
        done()
      })
  });

  beforeEach((done) => {
    new Promise(async (resolve) => {
      db = await client.db(conf.databaseName);
      resolve();
    })
      .then(() => {
        done()
      })
  });

  afterEach((done) => {
      // runs after each test in this block
      new Promise(async (resolve) => {
        await db.dropDatabase()
        resolve();
      })
        .then(() => {
          done()
        })
  });

  it('should buy tokens', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1236', 'satoshi', 'sscstore', 'buy', '{ "recipient": CONSTANTS.HIVE_ENGINE_ACCOUNT, "amountHIVEHBD": "0.001 HIVE", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 30529000,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL
          }
        });

      const balancesatoshi = res;

      assert.equal(balancesatoshi.balance, CONSTANTS.SSC_STORE_QTY);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not buy tokens', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1236', 'satoshi', 'sscstore', 'buy', '{ "recipient": "satoshi", "amountHIVEHBD": "0.001 HIVE", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 30529000,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL
          }
        });

      let balancesatoshi = res;

      assert.equal(balancesatoshi, null);

      transactions = [];
      transactions.push(new Transaction(30529001, 'TXID1237', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'sscstore', 'updateParams', '{ "priceHBD": 0.001, "priceHive": 0.001, "quantity": 1, "disabled": true }'));
      transactions.push(new Transaction(30529001, 'TXID1238', 'satoshi', 'sscstore', 'buy', '{ "recipient": CONSTANTS.HIVE_ENGINE_ACCOUNT, "amountHIVEHBD": "0.001 HIVE", "isSignedWithActiveKey": true }'));

      block = {
        refHiveBlockNumber: 30529001,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL
          }
        });

      balancesatoshi = res;

      assert.equal(balancesatoshi, null);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });


  it('should update params', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(30529000, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'sscstore', 'updateParams', '{ "priceHBD": 0.002, "priceHive": 0.003, "quantity": 5, "disabled": true }'));

      let block = {
        refHiveBlockNumber: 30529000,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'sscstore',
          table: 'params',
          query: {
          }
        });

      let params = res;

      assert.equal(params.priceHBD, 0.002);
      assert.equal(params.priceHive, 0.003);
      assert.equal(params.quantity, 5);
      assert.equal(params.disabled, true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('should not update params', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(3052900, 'TXID1236', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'sscstore', 'updateParams', '{ "priceHBD": 0.002, "priceHive": 0.003, "quantity": 5, "disabled": true }'));
      transactions.push(new Transaction(30529000, 'TXID1237', 'satoshi', 'sscstore', 'updateParams', '{ "priceHBD": 0.001, "priceHive": 0.001, "quantity": 1000000, "disabled": false }'));

      let block = {
        refHiveBlockNumber: 30529000,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'sscstore',
          table: 'params',
          query: {
          }
        });

      let params = res;

      assert.equal(params.priceHBD, 0.002);
      assert.equal(params.priceHive, 0.003);
      assert.equal(params.quantity, 5);
      assert.equal(params.disabled, true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });
});
