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

// Accounts
describe('Accounts smart contract', () => {
  it('deploys the contract from bootstrap', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });
      
      const res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_CONTRACT, payload: { name: 'accounts'}});
      const contract = res.payload;

      assert.equal(contract.name, 'accounts');
      assert.equal(contract.owner, 'null');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('adds an account', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });
      
      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'accounts', 'register', ''));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'accounts',
          table: 'accounts',
          query: {
            id: 'Harpagon'
          }
        }
      });

      const account = res.payload;

      assert.equal(account.id, 'Harpagon');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('adds an account once', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });
      
      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Harpagon', 'accounts', 'register', ''));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };
      
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'accounts',
          table: 'accounts',
          query: {
            id: 'Harpagon'
          }
        }
      });

      const accounts = res.payload;

      assert.equal(accounts.length, 1);
      assert.equal(accounts[0].id, 'Harpagon');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
});

// tokens
describe('Tokens smart contract', () => {
  it('creates a token', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });
      
      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": 0.001 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon', 'sscstore', 'buy', '{ "recipient": "steemsc", "amountSTEEMSBD": "0.001 STEEM", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "symbol": "TKN", "precision": 3, "maxSupply": 1000 }'));

      let block = {
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
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "symbol": "T.KN", "precision": 3, "maxSupply": 1000 }'));
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "symbol": "TKN", "precision": 3.3, "maxSupply": 1000 }'));
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "symbol": "TKN", "precision": -1, "maxSupply": 1000 }'));
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "symbol": "TKN", "precision": 9, "maxSupply": 1000 }'));
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'tokens', 'create', '{ "symbol": "TKN", "precision": 8, "maxSupply": -2 }'));

      let block = {
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

      assert.equal(JSON.parse(transactionsBlock1[0].logs).errors[0], 'invalid symbol');
      assert.equal(JSON.parse(transactionsBlock1[1].logs).errors[0], 'invalid precision');
      assert.equal(JSON.parse(transactionsBlock1[2].logs).errors[0], 'invalid precision');
      assert.equal(JSON.parse(transactionsBlock1[3].logs).errors[0], 'invalid precision');
      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'maxSupply must be positive');

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
      transactions.push(new Transaction(123456789, 'TXID1234', 'Satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Harpagon', 'tokens', 'create', '{ "symbol": "TKN", "precision": 0, "maxSupply": 1000 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": 100, "to": "Satoshi", "isSignedWithActiveKey": true }'));

      let block = {
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

      assert.equal(JSON.parse(token.supply), 100);

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

      assert.equal(JSON.parse(balance.balance), 100);

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
      transactions.push(new Transaction(123456789, 'TXID1234', 'Satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Harpagon', 'tokens', 'create', '{ "symbol": "TKN", "precision": 0, "maxSupply": 1000 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": 100, "to": "Satoshi" }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "NTK", "quantity": 100, "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Satoshi', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": 100, "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": 100.1, "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": -100, "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": 1001, "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": 1000, "to": "Vitalik", "isSignedWithActiveKey": true }'));

      let block = {
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
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'to account does not exist');

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
      transactions.push(new Transaction(123456789, 'TXID1234', 'Satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1234', 'Vitalik', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Harpagon', 'tokens', 'create', '{ "symbol": "TKN", "precision": 8, "maxSupply": 1000 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": 100, "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": 7.99999999, "to": "Vitalik", "isSignedWithActiveKey": true }'));

      let block = {
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

      assert.equal(JSON.parse(balanceSatoshi.balance), 92.00000001);

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

      assert.equal(JSON.parse(balanceVitalik.balance), 7.99999999);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('generates error when trying to transfer tokens with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });
      
      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Harpagon', 'tokens', 'create', '{ "symbol": "TKN", "precision": 0, "maxSupply": 1000 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": 100, "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": 7.99999999, "to": "Vitalik" }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": 7.99999999, "to": "Satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": 7.99999999, "to": "Vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1234', 'Vitalik', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TNK", "quantity": 7.99999999, "to": "Vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": 7.999999999, "to": "Vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": -1, "to": "Vitalik", "isSignedWithActiveKey": true }'));

      let block = {
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
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'to account does not exist');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'must transfer positive quantity');

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
      transactions.push(new Transaction(123456789, 'TXID1234', 'Satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Satoshi', 'sscstore', 'buy', '{ "recipient": "steemsc", "amountSTEEMSBD": "0.001 STEEM", "isSignedWithActiveKey": true }'));

      let block = {
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
            symbol: "SSC"
          }
        }
      });

      const balanceSatoshi = res.payload;

      assert.equal(balanceSatoshi.balance, 1);

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
      transactions.push(new Transaction(123456789, 'TXID1234', 'Satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Satoshi', 'sscstore', 'buy', '{ "recipient": "Satoshi", "amountSTEEMSBD": "0.001 STEEM", "isSignedWithActiveKey": true }'));

      let block = {
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
            symbol: "SSC"
          }
        }
      });

      let balanceSatoshi = res.payload;

      assert.equal(balanceSatoshi, null);

      transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'sscstore', 'updateParams', '{ "priceSBD": 0.001, "priceSteem": 0.001, "quantity": 1, "disabled": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Satoshi', 'sscstore', 'buy', '{ "recipient": "steemsc", "amountSTEEMSBD": "0.001 STEEM", "isSignedWithActiveKey": true }'));

      block = {
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
            symbol: "SSC"
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
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'sscstore', 'updateParams', '{ "priceSBD": 0.002, "priceSteem": 0.003, "quantity": 5, "disabled": true }'));

      let block = {
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
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'sscstore', 'updateParams', '{ "priceSBD": 0.002, "priceSteem": 0.003, "quantity": 5, "disabled": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Satoshi', 'sscstore', 'updateParams', '{ "priceSBD": 0.001, "priceSteem": 0.001, "quantity": 1000000, "disabled": false }'));

      let block = {
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
