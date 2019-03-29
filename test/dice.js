/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const { Database } = require('arangojs');

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
  databaseURL: "http://127.0.0.1:8529",
  databaseName: "testssc",
};

let plugins = {};
let jobs = new Map();
let currentJobId = 0;

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

const db = new Database(conf.databaseURL);
const STEEM_PEGGED_ACCOUNT = 'steem-peg';

// dice
describe('dice', function () {
  this.timeout(10000);

  beforeEach((done) => {
    new Promise(async (resolve) => {
      try {
        await db.dropDatabase(conf.databaseName);
      } catch (error) {

      }

      resolve();
    })
      .then(() => {
        done()
      })
  });

  after((done) => {
    new Promise(async (resolve) => {
      try {
        await db.dropDatabase(conf.databaseName);
      } catch (error) {

      }

      resolve();
    })
      .then(() => {
        done()
      })
  });

  it('makes you win', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(30983000, 'TXID1233', 'harpagon', 'steempegged', 'buy', `{ "recipient": "${STEEM_PEGGED_ACCOUNT}", "amountSTEEMSBD": "1100.00 STEEM", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(30983000, 'TXID1234', 'harpagon', 'tokens', 'transferToContract', '{ "symbol": "STEEMP", "to": "dice", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30983000, 'TXID1236', 'satoshi', 'steempegged', 'buy', `{ "recipient": "${STEEM_PEGGED_ACCOUNT}", "amountSTEEMSBD": "100.00 STEEM", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(30983000, 'TXID1237', 'satoshi', 'dice', 'roll', `{ "roll": 95, "amount": "33" , "isSignedWithActiveKey": true }`));

      let block = new Block(30983000, 'ABCD2', 'ABCD1', '2018-06-01T00:00:00', transactions);

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_TRANSACTION_INFO,
        payload: 'TXID1237'
      });

      const tx = res.payload;

      const logs = JSON.parse(tx.logs);

      const event = logs.events.find(ev => ev.contract === 'dice' && ev.event == 'results').data;

      assert.equal(event.memo, "you won. roll: 5, your bet: 95");

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('makes you lose', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
   
      transactions.push(new Transaction(30983000, 'TXID1233', 'harpagon', 'steempegged', 'buy', `{ "recipient": "${STEEM_PEGGED_ACCOUNT}", "amountSTEEMSBD": "1100.00 STEEM", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(30983000, 'TXID1234', 'harpagon', 'tokens', 'transferToContract', '{ "symbol": "STEEMP", "to": "dice", "quantity": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30983000, 'TXID1236', 'satoshi', 'steempegged', 'buy', `{ "recipient": "${STEEM_PEGGED_ACCOUNT}", "amountSTEEMSBD": "100.00 STEEM", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(30983000, 'TXID1237', 'satoshi', 'dice', 'roll', `{ "roll": 2, "amount": "33" , "isSignedWithActiveKey": true }`));

      let block = new Block(30983000, 'ABCD2', 'ABCD1', '2018-06-01T00:00:00', transactions);

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_TRANSACTION_INFO,
        payload: 'TXID1237'
      });

      const tx = res.payload;

      const logs = JSON.parse(tx.logs);

      const event = logs.events.find(ev => ev.contract === 'dice' && ev.event == 'results').data;

      assert.equal(event.memo, "you lost. roll: 5, your bet: 2");

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
});

