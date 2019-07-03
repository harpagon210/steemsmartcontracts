/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const fs = require('fs-extra');
const { MongoClient } = require('mongodb');

const database = require('../plugins/Database');
const blockchain = require('../plugins/Blockchain');
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
  databaseURL: "mongodb://localhost:27017",
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

contractCode = fs.readFileSync('./contracts/witnesses.js');
contractCode = contractCode.toString();
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_PRECISION\}\$'/g, CONSTANTS.UTILITY_TOKEN_PRECISION);
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, CONSTANTS.UTILITY_TOKEN_SYMBOL);
base64ContractCode = Base64.encode(contractCode);

let witnessesContractPayload = {
  name: 'witnesses',
  params: '',
  code: base64ContractCode,
};

describe('witnesses', function () {
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
  
  it('registers a witness', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(1, 'TXID1', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(1, 'TXID2', 'null', 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(1, 'TXID3', 'dan', 'witnesses', 'register', `{ "IP": "127.0.0.1", "RPCPort": 5000, "P2PPort": 5001, "signingKey": "STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pR", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID4', 'vitalik', 'witnesses', 'register', `{ "IP": "127.0.0.2", "RPCPort": 5000, "P2PPort": 5001, "signingKey": "STM8T4zKJuXgjLiKbp6fcsTTUtDY7afwc4XT9Xpf6uakYxwxfBabq", "enabled": false, "isSignedWithActiveKey": true }`));

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
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        }
      });

      let witnesses = res.payload;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, "0");
      assert.equal(witnesses[0].signingKey, "STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pR");
      assert.equal(witnesses[0].IP, "127.0.0.1");
      assert.equal(witnesses[0].RPCPort, 5000);
      assert.equal(witnesses[0].P2PPort, 5001);
      assert.equal(witnesses[0].enabled, true);

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "0");
      assert.equal(witnesses[1].signingKey, "STM8T4zKJuXgjLiKbp6fcsTTUtDY7afwc4XT9Xpf6uakYxwxfBabq");
      assert.equal(witnesses[1].IP, "127.0.0.2");
      assert.equal(witnesses[1].RPCPort, 5000);
      assert.equal(witnesses[1].P2PPort, 5001);
      assert.equal(witnesses[1].enabled, false);

      transactions = [];
      transactions.push(new Transaction(2, 'TXID5', 'dan', 'witnesses', 'register', `{ "IP": "127.0.0.3", "RPCPort": 5001, "P2PPort": 5002, "signingKey": "STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1p1", "enabled": false, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(2, 'TXID6', 'vitalik', 'witnesses', 'register', `{ "IP": "127.0.0.4", "RPCPort": 5001, "P2PPort": 5002, "signingKey": "STM8T4zKJuXgjLiKbp6fcsTTUtDY7afwc4XT9Xpf6uakYxwxfBab1", "enabled": true, "isSignedWithActiveKey": true }`));

      block = {
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
          contract: 'witnesses',
          table: 'witnesses',
          query: {
          }
        }
      });

      witnesses = res.payload;

      assert.equal(witnesses[0].account, "dan");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, "0");
      assert.equal(witnesses[0].signingKey, "STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1p1");
      assert.equal(witnesses[0].IP, "127.0.0.3");
      assert.equal(witnesses[0].RPCPort, 5001);
      assert.equal(witnesses[0].P2PPort, 5002);
      assert.equal(witnesses[0].enabled, false);

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "0");
      assert.equal(witnesses[1].signingKey, "STM8T4zKJuXgjLiKbp6fcsTTUtDY7afwc4XT9Xpf6uakYxwxfBab1");
      assert.equal(witnesses[1].IP, "127.0.0.4");
      assert.equal(witnesses[1].RPCPort, 5001);
      assert.equal(witnesses[1].P2PPort, 5002);
      assert.equal(witnesses[1].enabled, true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
});
