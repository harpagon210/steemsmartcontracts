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

let contractCode = fs.readFileSync('./contracts/tokens.js');
contractCode = contractCode.toString();

contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_PRECISION\}\$'/g, CONSTANTS.UTILITY_TOKEN_PRECISION);
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, CONSTANTS.UTILITY_TOKEN_SYMBOL);
contractCode = contractCode.replace(/'\$\{CONSTANTS.HIVE_PEGGED_SYMBOL\}\$'/g, CONSTANTS.HIVE_PEGGED_SYMBOL);


let base64ContractCode = Base64.encode(contractCode);

let tknContractPayload = {
  name: 'tokens',
  params: '',
  code: base64ContractCode,
};

contractCode = fs.readFileSync('./contracts/hivepegged.js');
contractCode = contractCode.toString();
contractCode = contractCode.replace(/'\$\{CONSTANTS.ACCOUNT_RECEIVING_FEES\}\$'/g, CONSTANTS.ACCOUNT_RECEIVING_FEES);
base64ContractCode = Base64.encode(contractCode);

let spContractPayload = {
  name: 'hivepegged',
  params: '',
  code: base64ContractCode,
};

describe('Hive Pegged', function () {
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
  
  it(`buys ${CONSTANTS.HIVE_PEGGED_SYMBOL}`, (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(4000000, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(4000000, 'TXID1233', CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(4000000, 'TXID1236', 'harpagon', 'hivepegged', 'buy', `{ "recipient": "${CONSTANTS.HIVE_PEGGED_ACCOUNT}", "amountHIVEHBD": "0.002 HIVE", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(4000000, 'TXID1237', 'satoshi', 'hivepegged', 'buy', `{ "recipient": "${CONSTANTS.HIVE_PEGGED_ACCOUNT}", "amountHIVEHBD": "0.879 HIVE", "isSignedWithActiveKey": true }`));

      let block = {
        refHiveBlockNumber: 1,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'tokens',
          table: 'balances',
          query: {
            symbol: CONSTANTS.HIVE_PEGGED_SYMBOL,
            account: {
              $in: ['harpagon', 'satoshi']
            }
          }
        });

      let balances = res;
      assert.equal(balances[0].balance, 0.001);
      assert.equal(balances[0].account, 'harpagon');
      assert.equal(balances[0].symbol, CONSTANTS.HIVE_PEGGED_SYMBOL);

      assert.equal(balances[1].balance, 0.87);
      assert.equal(balances[1].account, 'satoshi');
      assert.equal(balances[1].symbol, CONSTANTS.HIVE_PEGGED_SYMBOL);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('withdraws HIVE', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(4000000, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(4000000, 'TXID1233', CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(4000000, 'TXID1236', 'harpagon', 'hivepegged', 'buy', `{ "recipient": "${CONSTANTS.HIVE_PEGGED_ACCOUNT}", "amountHIVEHBD": "0.003 HIVE", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(4000000, 'TXID1237', 'satoshi', 'hivepegged', 'buy', `{ "recipient": "${CONSTANTS.HIVE_PEGGED_ACCOUNT}", "amountHIVEHBD": "0.879 HIVE", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(4000000, 'TXID1238', 'harpagon', 'hivepegged', 'withdraw', '{ "quantity": "0.002", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(4000000, 'TXID1239', 'satoshi', 'hivepegged', 'withdraw', '{ "quantity": "0.3", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 1,
        refHiveBlockId: 'ABCD1',
        prevRefHiveBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'tokens',
          table: 'balances',
          query: {
            symbol: CONSTANTS.HIVE_PEGGED_SYMBOL,
            account: {
              $in: ['harpagon', 'satoshi']
            }
          }
        });

      let balances = res;

      assert.equal(balances[0].balance, 0);
      assert.equal(balances[0].account, 'harpagon');
      assert.equal(balances[0].symbol, CONSTANTS.HIVE_PEGGED_SYMBOL);

      assert.equal(balances[1].balance, 0.57);
      assert.equal(balances[1].account, 'satoshi');
      assert.equal(balances[1].symbol, CONSTANTS.HIVE_PEGGED_SYMBOL);

      res = await database1.find({
          contract: 'hivepegged',
          table: 'withdrawals',
          query: {
          }
        });

      let withdrawals = res;

      assert.equal(withdrawals[0].id, 'TXID1236-fee');
      assert.equal(withdrawals[0].type, 'HIVE');
      assert.equal(withdrawals[0].recipient, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(withdrawals[0].memo, 'fee tx TXID1236');
      assert.equal(withdrawals[0].quantity, 0.001);

      assert.equal(withdrawals[1].id, 'TXID1237-fee');
      assert.equal(withdrawals[1].type, 'HIVE');
      assert.equal(withdrawals[1].recipient, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(withdrawals[1].memo, 'fee tx TXID1237');
      assert.equal(withdrawals[1].quantity, 0.009);

      assert.equal(withdrawals[2].id, 'TXID1238');
      assert.equal(withdrawals[2].type, 'HIVE');
      assert.equal(withdrawals[2].recipient, 'harpagon');
      assert.equal(withdrawals[2].memo, 'withdrawal tx TXID1238');
      assert.equal(withdrawals[2].quantity, 0.001);

      assert.equal(withdrawals[3].id, 'TXID1238-fee');
      assert.equal(withdrawals[3].type, 'HIVE');
      assert.equal(withdrawals[3].recipient, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(withdrawals[3].memo, 'fee tx TXID1238');
      assert.equal(withdrawals[3].quantity, 0.001);

      assert.equal(withdrawals[4].id, 'TXID1239');
      assert.equal(withdrawals[4].type, 'HIVE');
      assert.equal(withdrawals[4].recipient, 'satoshi');
      assert.equal(withdrawals[4].memo, 'withdrawal tx TXID1239');
      assert.equal(withdrawals[4].quantity, 0.297);

      assert.equal(withdrawals[5].id, 'TXID1239-fee');
      assert.equal(withdrawals[5].type, 'HIVE');
      assert.equal(withdrawals[5].recipient, CONSTANTS.HIVE_ENGINE_ACCOUNT);
      assert.equal(withdrawals[5].memo, 'fee tx TXID1239');
      assert.equal(withdrawals[5].quantity, 0.003);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not withdraw HIVE', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(4000000, 'TXID1232', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(4000000, 'TXID1233', CONSTANTS.HIVE_PEGGED_ACCOUNT, 'contract', 'update', JSON.stringify(spContractPayload)));
      transactions.push(new Transaction(4000000, 'TXID1236', 'harpagon', 'hivepegged', 'buy', `{ "recipient": "${CONSTANTS.HIVE_PEGGED_ACCOUNT}", "amountHIVEHBD": "0.003 HIVE", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(4000000, 'TXID1237', 'satoshi', 'hivepegged', 'buy', `{ "recipient": "${CONSTANTS.HIVE_PEGGED_ACCOUNT}", "amountHIVEHBD": "0.879 HIVE", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(4000000, 'TXID1239', 'satoshi', 'hivepegged', 'withdraw', '{ "quantity": "0.001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(4000000, 'TXID1240', 'satoshi', 'hivepegged', 'withdraw', '{ "quantity": "0.0021", "isSignedWithActiveKey": true }'));

      let block = {
        refHiveBlockNumber: 1,
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
            symbol: CONSTANTS.HIVE_PEGGED_SYMBOL,
            account: 'satoshi'
          }
        });

      let balance = res;

      assert.equal(balance.balance, 0.87);
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.symbol, CONSTANTS.HIVE_PEGGED_SYMBOL);

      res = await database1.find({
          contract: 'hivepegged',
          table: 'withdrawals',
          query: {
            'recipient': 'satoshi'
          }
        });

      let withdrawals = res;
      assert.equal(withdrawals.length, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });
});
