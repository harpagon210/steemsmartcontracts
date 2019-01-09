/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const { Base64 } = require('js-base64');
const fs = require('fs-extra');
const currency = require('currency.js');

const database = require('../plugins/Database');
const blockchain = require('../plugins/Blockchain');
const { Block } = require('../libs/Block');
const { Transaction } = require('../libs/Transaction');
const { sizeof } = require('../libs/sizeof');

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

// voting
describe('Fees Calculation', () => {
  it('should meter an insert action', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'satoshi', 'accounts', 'register', ''));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_CONTRACT, payload: { name: 'accounts' } });
      const contract = res.payload;

      const sizeNullAcct = sizeof({
        'id': 'null',
        '$loki': 1,
      });

      const sizeSteemScAcct = sizeof({
        'id': 'steemsc',
        '$loki': 2,
      });

      const sizeSatoshiAcct = sizeof({
        'id': 'satoshi',
        '$loki': 3,
      });

      const sizeOfIndex = 3*8;

      assert.equal(contract.tables['accounts_accounts'].size, sizeNullAcct + sizeSteemScAcct + sizeSatoshiAcct + sizeOfIndex);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should meter a remove action', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'satoshi', 'accounts', 'register', ''));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_CONTRACT, payload: { name: 'accounts' } });
      const contract = res.payload;

      const sizeNullAcct = sizeof({
        'id': 'null',
        '$loki': 1,
      });

      const sizeSteemScAcct = sizeof({
        'id': 'steemsc',
        '$loki': 2,
      });

      const sizeSatoshiAcct = sizeof({
        'id': 'satoshi',
        '$loki': 3,
      });

      const sizeOfIndex = 3*8;

      assert.equal(contract.tables['accounts_accounts'].size, sizeNullAcct + sizeSteemScAcct + sizeSatoshiAcct + sizeOfIndex);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
  
});
