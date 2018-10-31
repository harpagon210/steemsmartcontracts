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
describe('Voting', () => {
  it('should stake tokens', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'tokens', 'transfer', '{ "symbol": "SSC", "quantity": 100, "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'satoshi', 'blockProduction', 'stake', '{ "quantity": 30.0001 }'));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      const result = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: BP_CONSTANTS.CONTRACT_NAME, table: BP_CONSTANTS.BP_STAKES_TABLE, query: { account: "satoshi" }} });
      const stake = res.payload;

      // should have an active staking
      assert.equal(stake.account, 'satoshi');
      assert.equal(stake.balance, 30.0001);
      assert.equal(stake.stakedBlockNumber, 123456789);

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: 'tokens', table: 'balances', query: { account: "satoshi" }} });
      const balance = res.payload;
      
      // the balance should reflect the staking
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, 69.9999);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should unstake tokens', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'tokens', 'transfer', '{ "symbol": "SSC", "quantity": 100, "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'satoshi', 'blockProduction', 'stake', '{ "quantity": 30.0001 }'));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(123456789 + BP_CONSTANTS.STAKE_WITHDRAWAL_COOLDOWN, 'TXID1237', 'satoshi', 'blockProduction', 'unstake', '{ "quantity": 10 }'));

      block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: BP_CONSTANTS.CONTRACT_NAME, table: BP_CONSTANTS.BP_STAKES_TABLE, query: { account: "satoshi" }} });

      let stake = res.payload;
      
      // should have an active staking minus the unstake
      assert.equal(stake.account, 'satoshi');
      assert.equal(stake.balance, 20.0001);
      assert.equal(stake.stakedBlockNumber, 123456789);

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: 'tokens', table: 'balances', query: { account: "satoshi" }} });
      let balance = res.payload;
      
      // the balance should reflect the staking
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, 79.9999);

      transactions = [];
      transactions.push(new Transaction(123456789 + BP_CONSTANTS.STAKE_WITHDRAWAL_COOLDOWN, 'TXID1238', 'satoshi', 'blockProduction', 'unstake', '{ "quantity": 20.0001 }'));

      block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: BP_CONSTANTS.CONTRACT_NAME, table: BP_CONSTANTS.BP_STAKES_TABLE, query: { account: "satoshi" }} });
      stake = res.payload;
      
      // should not have an active staking
      assert.equal(stake, null);

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: 'tokens', table: 'balances', query: { account: "satoshi" }} });
      balance = res.payload;

      // the balance should reflect the staking
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, 100);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not stake tokens', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'satoshi', 'blockProduction', 'stake', '{ "quantity": 30.0001 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'tokens', 'transfer', '{ "symbol": "SSC", "quantity": 100, "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'satoshi', 'blockProduction', 'stake', '{ "quantity": 150 }'));


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

      assert.equal(JSON.parse(transactionsBlock1[1].logs).errors[0], 'balance does not exist');
      assert.equal(JSON.parse(transactionsBlock1[3].logs).errors[0], 'overdrawn balance');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not unstake tokens', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'satoshi', 'blockProduction', 'unstake', '{ "quantity": 30.0001 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'tokens', 'transfer', '{ "symbol": "SSC", "quantity": 100, "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'satoshi', 'blockProduction', 'stake', '{ "quantity": 100 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'satoshi', 'blockProduction', 'unstake', '{ "quantity": 200 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'satoshi', 'blockProduction', 'unstake', '{ "quantity": 100 }'));


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

      assert.equal(JSON.parse(transactionsBlock1[1].logs).errors[0], 'balance does not exist');
      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'overdrawn balance');
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], `you can only unstake after a period of ${BP_CONSTANTS.STAKE_WITHDRAWAL_COOLDOWN} blocks`);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should register a node', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1236', 'harpagon', 'blockProduction', 'registerNode', '{ "url": "https://mynode.com"}'));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: BP_CONSTANTS.CONTRACT_NAME, table: BP_CONSTANTS.BP_PRODUCERS_TABLE, query: { account: "harpagon" }} });
      const producer = res.payload;

      assert.equal(producer.account, 'harpagon');
      assert.equal(producer.power, 0);
      assert.equal(producer.url, 'https://mynode.com');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should vote', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'tokens', 'transfer', '{ "symbol": "SSC", "quantity": 100, "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'harpagon', 'blockProduction', 'registerNode', '{ "url": "https://mynode.com"}'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'satoshi', 'blockProduction', 'vote', '{ "producer": "harpagon"}'));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: BP_CONSTANTS.CONTRACT_NAME, table: BP_CONSTANTS.BP_PRODUCERS_TABLE, query: { account: "harpagon" }} });
      let producer = res.payload;

      assert.equal(producer.power, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: BP_CONSTANTS.CONTRACT_NAME, table: BP_CONSTANTS.BP_VOTES_TABLE, query: { account: "satoshi" }} });
      let userVotes = res.payload;
      assert.equal(userVotes.account, 'satoshi');
      assert.equal(userVotes.votes[0], 'harpagon');

      transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1236', 'satoshi', 'blockProduction', 'stake', '{ "quantity": 30 }'));

      block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: BP_CONSTANTS.CONTRACT_NAME, table: BP_CONSTANTS.BP_PRODUCERS_TABLE, query: { account: "harpagon" }} });
      producer = res.payload;

      assert.equal(producer.power, 30);

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: BP_CONSTANTS.CONTRACT_NAME, table: BP_CONSTANTS.BP_VOTES_TABLE, query: { account: "satoshi" }} });
      userVotes = res.payload;
      assert.equal(userVotes.account, 'satoshi');
      assert.equal(userVotes.votes[0], 'harpagon');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should unvote', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'tokens', 'transfer', '{ "symbol": "SSC", "quantity": 100, "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'harpagon', 'blockProduction', 'registerNode', '{ "url": "https://mynode.com"}'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'vitalik', 'blockProduction', 'registerNode', '{ "url": "https://mynode2.com"}'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'satoshi', 'blockProduction', 'stake', '{ "quantity": 30.0001 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'satoshi', 'blockProduction', 'vote', '{ "producer": "harpagon"}'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'satoshi', 'blockProduction', 'vote', '{ "producer": "vitalik"}'));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND, payload: { contract: BP_CONSTANTS.CONTRACT_NAME, table: BP_CONSTANTS.BP_PRODUCERS_TABLE, query: { account: { '$in' : ['harpagon', 'vitalik'] } }} });
      let producers = res.payload;

      assert.equal(producers[0].account, 'harpagon');
      assert.equal(producers[0].power, 30.0001);
      assert.equal(producers[1].account, 'vitalik');
      assert.equal(producers[1].power, 30.0001);

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: BP_CONSTANTS.CONTRACT_NAME, table: BP_CONSTANTS.BP_VOTES_TABLE, query: { account: "satoshi" }} });
      let userVotes = res.payload;
      assert.equal(userVotes.account, 'satoshi');
      assert.equal(userVotes.votes[0], 'harpagon');
      assert.equal(userVotes.votes[1], 'vitalik');

      transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1236', 'satoshi', 'blockProduction', 'unvote', '{ "producer": "harpagon" }'));

      block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND, payload: { contract: BP_CONSTANTS.CONTRACT_NAME, table: BP_CONSTANTS.BP_PRODUCERS_TABLE, query: { account: { '$in' : ['harpagon', 'vitalik'] } }} });
      producers = res.payload;

      assert.equal(producers[0].account, 'harpagon');
      assert.equal(producers[0].power, 0);
      assert.equal(producers[1].account, 'vitalik');
      assert.equal(producers[1].power, 30.0001);

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: BP_CONSTANTS.CONTRACT_NAME, table: BP_CONSTANTS.BP_VOTES_TABLE, query: { account: "satoshi" }} });
      userVotes = res.payload;
      assert.equal(userVotes.votes[0], 'vitalik');

      transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1236', 'satoshi', 'blockProduction', 'unvote', '{ "producer": "vitalik" }'));

      block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND, payload: { contract: BP_CONSTANTS.CONTRACT_NAME, table: BP_CONSTANTS.BP_PRODUCERS_TABLE, query: { account: { '$in' : ['harpagon', 'vitalik'] } }} });
      producers = res.payload;

      assert.equal(producers[0].account, 'harpagon');
      assert.equal(producers[0].power, 0);
      assert.equal(producers[1].account, 'vitalik');
      assert.equal(producers[1].power, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: BP_CONSTANTS.CONTRACT_NAME, table: BP_CONSTANTS.BP_VOTES_TABLE, query: { account: "satoshi" }} });
      userVotes = res.payload;
      assert.equal(userVotes, null);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should rank the producers by power', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1234', 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1234', 'vitalik', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'tokens', 'transfer', '{ "symbol": "SSC", "quantity": 100, "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'tokens', 'transfer', '{ "symbol": "SSC", "quantity": 100, "to": "harpagon", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'tokens', 'transfer', '{ "symbol": "SSC", "quantity": 100, "to": "vitalik", "isSignedWithActiveKey": true }'));

      transactions.push(new Transaction(123456789, 'TXID1236', 'harpagon', 'blockProduction', 'registerNode', '{ "url": "https://mynode.com"}'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'vitalik', 'blockProduction', 'registerNode', '{ "url": "https://eth.com"}'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'satoshi', 'blockProduction', 'registerNode', '{ "url": "https://btc.com"}'));

      transactions.push(new Transaction(123456789, 'TXID1236', 'harpagon', 'blockProduction', 'stake', '{ "quantity": 0.0002 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'satoshi', 'blockProduction', 'stake', '{ "quantity": 0.0003 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'vitalik', 'blockProduction', 'stake', '{ "quantity": 0.0001 }'));

      transactions.push(new Transaction(123456789, 'TXID1236', 'harpagon', 'blockProduction', 'vote', '{ "producer": "satoshi"}'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'satoshi', 'blockProduction', 'vote', '{ "producer": "vitalik"}'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'vitalik', 'blockProduction', 'vote', '{ "producer": "harpagon"}'));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: BP_CONSTANTS.CONTRACT_NAME,
          table: BP_CONSTANTS.BP_PRODUCERS_TABLE,
          query: {
            account: {
              '$in' : ['harpagon', 'vitalik', 'satoshi']
            }
          },
          index: 'power',
          descending: true,
        } 
      });

      let producers = res.payload;

      assert.equal(producers[0].account, 'vitalik');
      assert.equal(producers[0].power, 0.0003);
      assert.equal(producers[1].account, 'satoshi');
      assert.equal(producers[1].power, 0.0002);
      assert.equal(producers[2].account, 'harpagon');
      assert.equal(producers[2].power, 0.0001);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should initialize the rewards table', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(2000001, 'TXID1234', 'satoshi', 'accounts', 'register', ''));
      transactions.push(new Transaction(2000001, 'TXID1235', 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(2000001, 'TXID1236', 'vitalik', 'accounts', 'register', ''));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: BP_CONSTANTS.CONTRACT_NAME,
          table: BP_CONSTANTS.BP_REWARDS_TABLE,
          query: {
          },
        } 
      });

      let rewardsParams = res.payload;

      assert.equal(rewardsParams.lastInflationCalculation, conf.genesisSteemBlock);
      assert.equal(rewardsParams.inflationRate, BP_CONSTANTS.INITIAL_INFLATION_RATE);

      // the rewardsPerBlockPerProducer should be (0.1% of the total supply) / (the number of blocks * the number of block producers)
      assert.equal(rewardsParams.rewardsPerBlockPerProducer, 0.05905139);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should update the inflation rate until MINIMUM_INFLATION_RATE is reached', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(2000001, 'TXID1234', 'satoshi', 'accounts', 'register', ''));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let lastBlockNumber = 2000001;
      let totalSupply = BP_CONSTANTS.UTILITY_TOKEN_INITIAL_SUPPLY;

      let maxLoop = 100;

      for (let index = 1; index < maxLoop; index++) {
        lastBlockNumber += BP_CONSTANTS.NB_BLOCKS_UPDATE_INFLATION_RATE + 1;
        const totalRewards = currency(totalSupply, { precision: BP_CONSTANTS.UTILITY_TOKEN_PRECISION}).multiply(BP_CONSTANTS.INFLATION_RATE_DECREASING_RATE);

        totalSupply = currency(totalSupply, { precision: BP_CONSTANTS.UTILITY_TOKEN_PRECISION}).add(totalRewards);
        transactions = [];
        transactions.push(new Transaction(lastBlockNumber, 'TXID1234', 'null', 'tokens', 'issue', `{ "symbol": "SSC", "quantity": ${totalRewards}, "to": "satoshi", "isSignedWithActiveKey": true }`));
  
        block = {
          timestamp: '2018-06-01T00:00:00',
          transactions,
        };
  
        await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
  
        let res = await send(database.PLUGIN_NAME, 'MASTER', {
          action: database.PLUGIN_ACTIONS.FIND_ONE,
          payload: {
            contract: BP_CONSTANTS.CONTRACT_NAME,
            table: BP_CONSTANTS.BP_REWARDS_TABLE,
            query: {
            },
          } 
        });
  
        let rewardsParams = res.payload;
        let inflationRate = currency(BP_CONSTANTS.INITIAL_INFLATION_RATE, { precision: 3}).subtract(BP_CONSTANTS.INFLATION_RATE_DECREASING_RATE * index).value;

        if (inflationRate <= BP_CONSTANTS.MINIMUM_INFLATION_RATE) {
          index = maxLoop + 1;
        } else {
          assert.equal(rewardsParams.lastInflationCalculation, lastBlockNumber);
          assert.equal(rewardsParams.inflationRate, inflationRate);
        }
      }

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should reward the top NB_BLOCK_PRODUCERS block producers after a block is produced', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'harpagon', 'accounts', 'register', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'tokens', 'transfer', '{ "symbol": "SSC", "quantity": 100, "to": "harpagon", "isSignedWithActiveKey": true }'));

      // register block producers
      for (let index = 0; index < 50; index++) {
        transactions.push(new Transaction(123456789, `TXID1236${index}`, `bp${index}`, 'blockProduction', 'registerNode', '{ "url": "https://mynode.com"}'));        
      }

      // stake
      transactions.push(new Transaction(123456789, 'TXID1236', 'harpagon', 'blockProduction', 'stake', '{ "quantity": 100 }'));

      // vote
      for (let index = 0; index < 30; index++) {
        transactions.push(new Transaction(123456789, `TXID1236${index}`, 'harpagon', 'blockProduction', 'vote', `{ "producer": "bp${index}" }`));        
      }

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: BP_CONSTANTS.CONTRACT_NAME,
          table: BP_CONSTANTS.BP_PRODUCERS_TABLE,
          query: {
          },
          index: 'power',
          descending: true,
          limit: BP_CONSTANTS.NB_BLOCK_PRODUCERS + 10
        } 
      });

      let producers = res.payload;

      for (let index = 0; index < producers.length; index++) {
        const producer = producers[index];
        
        if (index < BP_CONSTANTS.NB_VOTES_ALLOWED) {
          assert.equal(producer.power, 100);
        } else {
          assert.equal(producer.power, 0);
        }
      }

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: { symbol: BP_CONSTANTS.UTILITY_TOKEN_SYMBOL }
        }
      });

      let balances = res.payload;

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: BP_CONSTANTS.CONTRACT_NAME,
          table: BP_CONSTANTS.BP_REWARDS_TABLE,
          query: {
          },
        } 
      });

      let rewardsParams = res.payload;

      for (let index = 0; index < balances.length; index++) {
        const balance = balances[index];
        if (balance.account !== 'steemsc') {
          assert.equal(balance.balance, rewardsParams.rewardsPerBlockPerProducer);
        }
      }

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
  
});
