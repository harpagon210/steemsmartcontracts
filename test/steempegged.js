/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const { Database } = require('arangojs');

const database = require('../plugins/Database');
const blockchain = require('../plugins/Blockchain');
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

const FORK_BLOCK_NUMBER = 30896500;
const STEEM_PEGGED_ACCOUNT = 'steem-peg';

// STEEMP
describe('Steem Pegged', function () {
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

  it('buys STEEMP', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'harpagon', 'steempegged', 'buy', `{ "recipient": "${STEEM_PEGGED_ACCOUNT}", "amountSTEEMSBD": "0.002 STEEM", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1237', 'satoshi', 'steempegged', 'buy', `{ "recipient": "${STEEM_PEGGED_ACCOUNT}", "amountSTEEMSBD": "0.879 STEEM", "isSignedWithActiveKey": true }`));

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
            account: {
              $in: ['harpagon', 'satoshi']
            }
          }
        }
      });

      let balances = res.payload;
      assert.equal(balances[0].balance, 0.001);
      assert.equal(balances[0].account, 'harpagon');
      assert.equal(balances[0].symbol, 'STEEMP');

      assert.equal(balances[1].balance, 0.87);
      assert.equal(balances[1].account, 'satoshi');
      assert.equal(balances[1].symbol, 'STEEMP');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('withdraws STEEM', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1236', 'harpagon', 'steempegged', 'buy', `{ "recipient": "${STEEM_PEGGED_ACCOUNT}", "amountSTEEMSBD": "0.003 STEEM", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1237', 'satoshi', 'steempegged', 'buy', `{ "recipient": "${STEEM_PEGGED_ACCOUNT}", "amountSTEEMSBD": "0.879 STEEM", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1238', 'harpagon', 'steempegged', 'withdraw', '{ "quantity": "0.002", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(FORK_BLOCK_NUMBER, 'TXID1239', 'satoshi', 'steempegged', 'withdraw', '{ "quantity": "0.3", "isSignedWithActiveKey": true }'));

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
            account: {
              $in: ['harpagon', 'satoshi']
            }
          }
        }
      });

      let balances = res.payload;

      assert.equal(balances[0].balance, 0);
      assert.equal(balances[0].account, 'harpagon');
      assert.equal(balances[0].symbol, 'STEEMP');

      assert.equal(balances[1].balance, 0.57);
      assert.equal(balances[1].account, 'satoshi');
      assert.equal(balances[1].symbol, 'STEEMP');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'steempegged',
          table: 'withdrawals',
          query: {
          }
        }
      });

      let withdrawals = res.payload;

      assert.equal(withdrawals[0].id, 'TXID1236-fee');
      assert.equal(withdrawals[0].type, 'STEEM');
      assert.equal(withdrawals[0].recipient, 'steemsc');
      assert.equal(withdrawals[0].memo, 'fee tx TXID1236');
      assert.equal(withdrawals[0].quantity, 0.001);

      assert.equal(withdrawals[1].id, 'TXID1237-fee');
      assert.equal(withdrawals[1].type, 'STEEM');
      assert.equal(withdrawals[1].recipient, 'steemsc');
      assert.equal(withdrawals[1].memo, 'fee tx TXID1237');
      assert.equal(withdrawals[1].quantity, 0.009);

      assert.equal(withdrawals[2].id, 'TXID1238');
      assert.equal(withdrawals[2].type, 'STEEM');
      assert.equal(withdrawals[2].recipient, 'harpagon');
      assert.equal(withdrawals[2].memo, 'withdrawal tx TXID1238');
      assert.equal(withdrawals[2].quantity, 0.001);

      assert.equal(withdrawals[3].id, 'TXID1238-fee');
      assert.equal(withdrawals[3].type, 'STEEM');
      assert.equal(withdrawals[3].recipient, 'steemsc');
      assert.equal(withdrawals[3].memo, 'fee tx TXID1238');
      assert.equal(withdrawals[3].quantity, 0.001);

      assert.equal(withdrawals[4].id, 'TXID1239');
      assert.equal(withdrawals[4].type, 'STEEM');
      assert.equal(withdrawals[4].recipient, 'satoshi');
      assert.equal(withdrawals[4].memo, 'withdrawal tx TXID1239');
      assert.equal(withdrawals[4].quantity, 0.297);

      assert.equal(withdrawals[5].id, 'TXID1239-fee');
      assert.equal(withdrawals[5].type, 'STEEM');
      assert.equal(withdrawals[5].recipient, 'steemsc');
      assert.equal(withdrawals[5].memo, 'fee tx TXID1239');
      assert.equal(withdrawals[5].quantity, 0.003);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
});
