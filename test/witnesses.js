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
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_MIN_VALUE\}\$'/g, CONSTANTS.UTILITY_TOKEN_MIN_VALUE);
base64ContractCode = Base64.encode(contractCode);

let witnessesContractPayload = {
  name: 'witnesses',
  params: '',
  code: base64ContractCode,
};

describe('witnesses', function () {
  this.timeout(60000);

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
  
  it('registers witnesses', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(1, 'TXID1', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(1, 'TXID2', 'null', 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(1, 'TXID3', 'dan', 'witnesses', 'register', `{ "RPCUrl": "my.awesome.node", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID4', 'vitalik', 'witnesses', 'register', `{ "RPCUrl": "my.awesome.node.too", "enabled": false, "isSignedWithActiveKey": true }`));

      let block = {
        refSteemBlockNumber: 32713425,
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
      assert.equal(witnesses[0].RPCUrl, "my.awesome.node");
      assert.equal(witnesses[0].enabled, true);

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "0");
      assert.equal(witnesses[1].RPCUrl, "my.awesome.node.too");
      assert.equal(witnesses[1].enabled, false);

      transactions = [];
      transactions.push(new Transaction(2, 'TXID5', 'dan', 'witnesses', 'register', `{ "RPCUrl": "my.new.awesome.node", "enabled": false, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(2, 'TXID6', 'vitalik', 'witnesses', 'register', `{ "RPCUrl": "my.new.awesome.node.too", "enabled": true, "isSignedWithActiveKey": true }`));

      block = {
        refSteemBlockNumber: 32713425,
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
      assert.equal(witnesses[0].RPCUrl, "my.new.awesome.node");
      assert.equal(witnesses[0].enabled, false);

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "0");
      assert.equal(witnesses[1].RPCUrl, "my.new.awesome.node.too");
      assert.equal(witnesses[1].enabled, true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('approves witnesses', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(1, 'TXID1', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(1, 'TXID2', 'null', 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(1, 'TXID3', 'dan', 'witnesses', 'register', `{ "RPCUrl": "my.awesome.node", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID4', 'vitalik', 'witnesses', 'register', `{ "RPCUrl": "my.awesome.node.too", "enabled": false, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID5', 'harpagon', 'tokens', 'stake', `{ "to": "harpagon", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID6', 'harpagon', 'witnesses', 'approve', `{ "witness": "dan", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID7', 'harpagon', 'witnesses', 'approve', `{ "witness": "vitalik", "isSignedWithActiveKey": true }`));

      let block = {
        refSteemBlockNumber: 32713425,
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
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.00000000');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00000000");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'witnesses',
          table: 'accounts',
          query: {
            account: 'harpagon'
          }
        }
      });

      let account = res.payload;

      assert.equal(account.approvals, 2);
      assert.equal(account.approvalWeight, "100.00000000");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        }
      });

      let approvals = res.payload;

      assert.equal(approvals[0].from, "harpagon");
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, "harpagon");
      assert.equal(approvals[1].to, "vitalik");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        }
      });

      let params = res.payload;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight, "200.00000000");

      transactions = [];
      transactions.push(new Transaction(1, 'TXID8', 'satoshi', 'witnesses', 'register', `{ "RPCUrl": "my.awesome.node", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID9', 'harpagon', 'tokens', 'stake', `{ "to": "ned", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "0.00000001", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID10', 'harpagon', 'witnesses', 'approve', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID11', 'ned', 'witnesses', 'approve', `{ "witness": "dan", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID12', 'ned', 'witnesses', 'approve', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));

      block = {
        refSteemBlockNumber: 32713425,
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
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.00000001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00000000");

      assert.equal(witnesses[2].account, "satoshi");
      assert.equal(witnesses[2].approvalWeight.$numberDecimal, "100.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        }
      });

      let accounts = res.payload;

      assert.equal(accounts[0].account, "harpagon");
      assert.equal(accounts[0].approvals, 3);
      assert.equal(accounts[0].approvalWeight, "100.00000000");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 2);
      assert.equal(accounts[1].approvalWeight, "0.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        }
      });

      approvals = res.payload;

      assert.equal(approvals[0].from, "harpagon");
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, "harpagon");
      assert.equal(approvals[1].to, "vitalik");

      assert.equal(approvals[2].from, "harpagon");
      assert.equal(approvals[2].to, "satoshi");

      assert.equal(approvals[3].from, "ned");
      assert.equal(approvals[3].to, "dan");

      assert.equal(approvals[4].from, "ned");
      assert.equal(approvals[4].to, "satoshi");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        }
      });

      params = res.payload;

      assert.equal(params[0].numberOfApprovedWitnesses, 3);
      assert.equal(params[0].totalApprovalWeight, "300.00000002");

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('disapproves witnesses', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(1, 'TXID1', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(1, 'TXID2', 'null', 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(1, 'TXID3', 'dan', 'witnesses', 'register', `{ "RPCUrl": "my.awesome.node", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID4', 'vitalik', 'witnesses', 'register', `{ "RPCUrl": "my.awesome.node.too", "enabled": false, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID5', 'harpagon', 'tokens', 'stake', `{ "to": "harpagon", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID6', 'harpagon', 'witnesses', 'approve', `{ "witness": "dan", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID7', 'harpagon', 'witnesses', 'approve', `{ "witness": "vitalik", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID8', 'satoshi', 'witnesses', 'register', `{ "RPCUrl": "my.awesome.node", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID9', 'harpagon', 'tokens', 'stake', `{ "to": "ned", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "0.00000001", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID10', 'harpagon', 'witnesses', 'approve', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID11', 'ned', 'witnesses', 'approve', `{ "witness": "dan", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID12', 'ned', 'witnesses', 'approve', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));

      let block = {
        refSteemBlockNumber: 32713425,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(1, 'TXID13', 'ned', 'witnesses', 'disapprove', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));

      block = {
        refSteemBlockNumber: 32713425,
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
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.00000001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00000000");

      assert.equal(witnesses[2].account, "satoshi");
      assert.equal(witnesses[2].approvalWeight.$numberDecimal, "100.00000000");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        }
      });

      let accounts = res.payload;

      assert.equal(accounts[0].account, "harpagon");
      assert.equal(accounts[0].approvals, 3);
      assert.equal(accounts[0].approvalWeight, "100.00000000");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 1);
      assert.equal(accounts[1].approvalWeight, "0.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'approvals',
          query: {
            to: "satoshi"
          }
        }
      });

      approvals = res.payload;

      assert.equal(approvals[0].from, "harpagon");
      assert.equal(approvals[0].to, "satoshi");
      assert.equal(approvals.length, 1);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        }
      });

      params = res.payload;

      assert.equal(params[0].numberOfApprovedWitnesses, 3);
      assert.equal(params[0].totalApprovalWeight, "300.00000001");

      transactions = [];
      transactions.push(new Transaction(1, 'TXID14', 'harpagon', 'witnesses', 'disapprove', `{ "witness": "satoshi", "isSignedWithActiveKey": true }`));

      block = {
        refSteemBlockNumber: 32713425,
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
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.00000001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00000000");

      assert.equal(witnesses[2].account, "satoshi");
      assert.equal(witnesses[2].approvalWeight.$numberDecimal, "0E-8");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        }
      });

      accounts = res.payload;

      assert.equal(accounts[0].account, "harpagon");
      assert.equal(accounts[0].approvals, 2);
      assert.equal(accounts[0].approvalWeight, "100.00000000");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 1);
      assert.equal(accounts[1].approvalWeight, "0.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'approvals',
          query: {
            to: "satoshi"
          }
        }
      });

      approvals = res.payload;

      assert.equal(approvals.length, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        }
      });

      params = res.payload;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight, "200.00000001");

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('updates witnesses approvals when staking, unstaking, delegating and undelegating the utility token', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(1, 'TXID1', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(1, 'TXID2', 'null', 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(1, 'TXID3', 'dan', 'witnesses', 'register', `{ "RPCUrl": "my.awesome.node", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID4', 'vitalik', 'witnesses', 'register', `{ "RPCUrl": "my.awesome.node.too", "enabled": false, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID5', 'harpagon', 'tokens', 'stake', `{ "to": "harpagon", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID6', 'harpagon', 'witnesses', 'approve', `{ "witness": "dan", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID7', 'harpagon', 'witnesses', 'approve', `{ "witness": "vitalik", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID8', 'harpagon', 'tokens', 'stake', `{ "to": "harpagon", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "0.00000001", "isSignedWithActiveKey": true }`));

      let block = {
        refSteemBlockNumber: 32713425,
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
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.00000001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'witnesses',
          table: 'accounts',
          query: {
            account: 'harpagon'
          }
        }
      });

      let account = res.payload;

      assert.equal(account.approvals, 2);
      assert.equal(account.approvalWeight, "100.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        }
      });

      let approvals = res.payload;

      assert.equal(approvals[0].from, "harpagon");
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, "harpagon");
      assert.equal(approvals[1].to, "vitalik");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        }
      });

      let params = res.payload;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight, "200.00000002");

      transactions = [];
      transactions.push(new Transaction(1, 'TXID9', 'harpagon', 'tokens', 'stake', `{ "to": "ned", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "1", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID10', 'ned', 'witnesses', 'approve', `{ "witness": "dan", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID11', 'harpagon', 'tokens', 'delegate', `{ "to": "ned", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "2", "isSignedWithActiveKey": true }`));

      block = {
        refSteemBlockNumber: 32713425,
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
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '101.00000001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "98.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        }
      });

      let accounts = res.payload;

      assert.equal(accounts[0].account, "harpagon");
      assert.equal(accounts[0].approvals, 2);
      assert.equal(accounts[0].approvalWeight, "98.00000001");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 1);
      assert.equal(accounts[1].approvalWeight, "3.00000000");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        }
      });

      approvals = res.payload;

      assert.equal(approvals[0].from, "harpagon");
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, "harpagon");
      assert.equal(approvals[1].to, "vitalik");

      assert.equal(approvals[2].from, "ned");
      assert.equal(approvals[2].to, "dan");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        }
      });

      params = res.payload;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight, "199.00000002");

      transactions = [];
      transactions.push(new Transaction(1, 'TXID12', 'harpagon', 'tokens', 'undelegate', `{ "from": "ned", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "2", "isSignedWithActiveKey": true }`));

      block = {
        refSteemBlockNumber: 32713425,
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
          table: 'pendingUndelegations',
          query: {
          }
        }
      });

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
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '99.00000001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "98.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        }
      });

      accounts = res.payload;

      assert.equal(accounts[0].account, "harpagon");
      assert.equal(accounts[0].approvals, 2);
      assert.equal(accounts[0].approvalWeight, "98.00000001");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 1);
      assert.equal(accounts[1].approvalWeight, "1.00000000");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        }
      });

      approvals = res.payload;

      assert.equal(approvals[0].from, "harpagon");
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, "harpagon");
      assert.equal(approvals[1].to, "vitalik");

      assert.equal(approvals[2].from, "ned");
      assert.equal(approvals[2].to, "dan");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        }
      });

      params = res.payload;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight, "197.00000002");

      transactions = [];
      transactions.push(new Transaction(1, 'TXID13', 'harpagon', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 32713425,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-08-01T00:00:00',
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
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '101.00000001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        }
      });

      accounts = res.payload;

      assert.equal(accounts[0].account, "harpagon");
      assert.equal(accounts[0].approvals, 2);
      assert.equal(accounts[0].approvalWeight, "100.00000001");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 1);
      assert.equal(accounts[1].approvalWeight, "1.00000000");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        }
      });

      approvals = res.payload;

      assert.equal(approvals[0].from, "harpagon");
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, "harpagon");
      assert.equal(approvals[1].to, "vitalik");

      assert.equal(approvals[2].from, "ned");
      assert.equal(approvals[2].to, "dan");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        }
      });

      params = res.payload;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight, "201.00000002");

      transactions = [];
      transactions.push(new Transaction(1, 'TXID14', 'ned', 'tokens', 'unstake', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "1", "isSignedWithActiveKey": true }`));

      block = {
        refSteemBlockNumber: 32713425,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-08-02T00:00:00',
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
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '101.00000001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        }
      });

      accounts = res.payload;

      assert.equal(accounts[0].account, "harpagon");
      assert.equal(accounts[0].approvals, 2);
      assert.equal(accounts[0].approvalWeight, "100.00000001");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 1);
      assert.equal(accounts[1].approvalWeight, "1.00000000");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        }
      });

      approvals = res.payload;

      assert.equal(approvals[0].from, "harpagon");
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, "harpagon");
      assert.equal(approvals[1].to, "vitalik");

      assert.equal(approvals[2].from, "ned");
      assert.equal(approvals[2].to, "dan");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        }
      });

      params = res.payload;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight, "201.00000002");

      transactions = [];
      transactions.push(new Transaction(1, 'TXID15', 'harpagon', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 32713425,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-10-01T00:00:00',
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
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '100.00000001');

      assert.equal(witnesses[1].account, "vitalik");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, "100.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'accounts',
          query: {
          }
        }
      });

      accounts = res.payload;

      assert.equal(accounts[0].account, "harpagon");
      assert.equal(accounts[0].approvals, 2);
      assert.equal(accounts[0].approvalWeight, "100.00000001");

      assert.equal(accounts[1].account, "ned");
      assert.equal(accounts[1].approvals, 1);
      assert.equal(accounts[1].approvalWeight, "0.00000000");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'approvals',
          query: {
          }
        }
      });

      approvals = res.payload;

      assert.equal(approvals[0].from, "harpagon");
      assert.equal(approvals[0].to, "dan");

      assert.equal(approvals[1].from, "harpagon");
      assert.equal(approvals[1].to, "vitalik");

      assert.equal(approvals[2].from, "ned");
      assert.equal(approvals[2].to, "dan");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
          }
        }
      });

      params = res.payload;

      assert.equal(params[0].numberOfApprovedWitnesses, 2);
      assert.equal(params[0].totalApprovalWeight, "200.00000002");
      
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('schedules witnesses', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });
      let txId = 100;
      let transactions = [];
      transactions.push(new Transaction(1, 'TXID1', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(1, 'TXID2', 'null', 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(1, 'TXID3', 'harpagon', 'tokens', 'stake', `{ "to": "harpagon", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));

      // register 100 witnesses
      for (let index = 0; index < 100; index++) {
        txId++;
        transactions.push(new Transaction(1, `TXID${txId}`, `witness${index}`, 'witnesses', 'register', `{ "RPCUrl": "my.awesome.node", "enabled": true, "isSignedWithActiveKey": true }`));
      }

      let block = {
        refSteemBlockNumber: 32713425,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      for (let index = 0; index < 30; index++) {
        txId++;
        transactions.push(new Transaction(1, `TXID${txId}`, 'harpagon', 'witnesses', 'approve', `{ "witness": "witness${index + 5}", "isSignedWithActiveKey": true }`));
      }

      block = {
        refSteemBlockNumber: 32713425,
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
          table: 'schedules',
          query: {
            
          }
        }
      });

      let schedule = res.payload;

      assert.equal(schedule[0].witness, "witness26");
      assert.equal(schedule[0].blockNumber, 2);
      assert.equal(schedule[0].blockPropositionDeadline, 13);

      assert.equal(schedule[1].witness, "witness33");
      assert.equal(schedule[1].blockNumber, 3);
      assert.equal(schedule[1].blockPropositionDeadline, 0);

      assert.equal(schedule[2].witness, "witness18");
      assert.equal(schedule[2].blockNumber, 4);
      assert.equal(schedule[2].blockPropositionDeadline, 0);

      assert.equal(schedule[3].witness, "witness20");
      assert.equal(schedule[3].blockNumber, 5);
      assert.equal(schedule[3].blockPropositionDeadline, 0);

      assert.equal(schedule[4].witness, "witness27");
      assert.equal(schedule[4].blockNumber, 6);
      assert.equal(schedule[4].blockPropositionDeadline, 0);

      assert.equal(schedule[5].witness, "witness24");
      assert.equal(schedule[5].blockNumber, 7);
      assert.equal(schedule[5].blockPropositionDeadline, 0);

      assert.equal(schedule[6].witness, "witness21");
      assert.equal(schedule[6].blockNumber, 8);
      assert.equal(schedule[6].blockPropositionDeadline, 0);

      assert.equal(schedule[7].witness, "witness23");
      assert.equal(schedule[7].blockNumber, 9);
      assert.equal(schedule[7].blockPropositionDeadline, 0);

      assert.equal(schedule[8].witness, "witness29");
      assert.equal(schedule[8].blockNumber, 10);
      assert.equal(schedule[8].blockPropositionDeadline, 0);

      assert.equal(schedule[9].witness, "witness15");
      assert.equal(schedule[9].blockNumber, 11);
      assert.equal(schedule[9].blockPropositionDeadline, 0);

      assert.equal(schedule[10].witness, "witness31");
      assert.equal(schedule[10].blockNumber, 12);
      assert.equal(schedule[10].blockPropositionDeadline, 0);

      assert.equal(schedule[11].witness, "witness34");
      assert.equal(schedule[11].blockNumber, 13);
      assert.equal(schedule[11].blockPropositionDeadline, 0);

      assert.equal(schedule[12].witness, "witness30");
      assert.equal(schedule[12].blockNumber, 14);
      assert.equal(schedule[12].blockPropositionDeadline, 0);

      assert.equal(schedule[13].witness, "witness28");
      assert.equal(schedule[13].blockNumber, 15);
      assert.equal(schedule[13].blockPropositionDeadline, 0);

      assert.equal(schedule[14].witness, "witness17");
      assert.equal(schedule[14].blockNumber, 16);
      assert.equal(schedule[14].blockPropositionDeadline, 0);

      assert.equal(schedule[15].witness, "witness22");
      assert.equal(schedule[15].blockNumber, 17);
      assert.equal(schedule[15].blockPropositionDeadline, 0);

      assert.equal(schedule[16].witness, "witness25");
      assert.equal(schedule[16].blockNumber, 18);
      assert.equal(schedule[16].blockPropositionDeadline, 0);

      assert.equal(schedule[17].witness, "witness32");
      assert.equal(schedule[17].blockNumber, 19);
      assert.equal(schedule[17].blockPropositionDeadline, 0);

      assert.equal(schedule[18].witness, "witness8");
      assert.equal(schedule[18].blockNumber, 20);
      assert.equal(schedule[18].blockPropositionDeadline, 0);

      assert.equal(schedule[19].witness, "witness19");
      assert.equal(schedule[19].blockNumber, 21);
      assert.equal(schedule[19].blockPropositionDeadline, 0);

      assert.equal(schedule[20].witness, "witness16");
      assert.equal(schedule[20].blockNumber, 22);
      assert.equal(schedule[20].blockPropositionDeadline, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
            
          }
        }
      });

      let params = res.payload;

      assert.equal(params.totalApprovalWeight, '3000.00000000');
      assert.equal(params.numberOfApprovedWitnesses, 30);
      assert.equal(params.lastVerifiedBlockNumber, 1);
      assert.equal(params.currentWitness, 'witness26');
      
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('verifies a block', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });
      let txId = 100;
      let transactions = [];
      transactions.push(new Transaction(1, 'TXID1', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(1, 'TXID2', 'null', 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(1, 'TXID3', 'harpagon', 'tokens', 'stake', `{ "to": "harpagon", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));

      // register 100 witnesses
      for (let index = 0; index < 100; index++) {
        txId++;
        transactions.push(new Transaction(1, `TXID${txId}`, `witness${index}`, 'witnesses', 'register', `{ "RPCUrl": "my.awesome.node", "enabled": true, "isSignedWithActiveKey": true }`));
      }

      let block = {
        refSteemBlockNumber: 32713425,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      for (let index = 0; index < 30; index++) {
        txId++;
        transactions.push(new Transaction(1, `TXID${txId}`, 'harpagon', 'witnesses', 'approve', `{ "witness": "witness${index + 5}", "isSignedWithActiveKey": true }`));
      }

      block = {
        refSteemBlockNumber: 32713425,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {
        }
      });

      let blockRes = res.payload;

      const {
        blockNumber,
        previousHash,
        previousDatabaseHash,
        hash,
        databaseHash,
        merkleRoot,
      } = blockRes;

      transactions = [];
      let payload = {
        blockNumber,
        previousHash,
        previousDatabaseHash,
        hash,
        databaseHash,
        merkleRoot,
        isSignedWithActiveKey: true 
      }
      transactions.push(new Transaction(1, 'TXID1000', 'witness26', 'witnesses', 'proposeBlock', JSON.stringify(payload)));

      block = {
        refSteemBlockNumber: 32713425,
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
          table: 'proposedBlocks',
          query: {
            
          }
        }
      });

      let proposedBlocks = res.payload;

      assert.equal(proposedBlocks[0].witness, 'witness26');
      assert.equal(proposedBlocks[0].blockNumber, payload.blockNumber);
      assert.equal(proposedBlocks[0].previousHash, payload.previousHash);
      assert.equal(proposedBlocks[0].previousDatabaseHash, payload.previousDatabaseHash);
      assert.equal(proposedBlocks[0].hash, payload.hash);
      assert.equal(proposedBlocks[0].databaseHash, payload.databaseHash);
      assert.equal(proposedBlocks[0].merkleRoot, payload.merkleRoot);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'witnesses',
          table: 'schedules',
          query: {
            witness: 'witness26'
          }
        }
      });

      let schedule = res.payload;
      assert.equal(schedule.blockNumber, 2);
      assert.equal(schedule.blockPropositionDeadline, 13);
      assert.equal(schedule.blockDisputeDeadline, 13);

      for (let index = 0; index < 10; index++) {
        transactions = [];
        txId++
        // send whatever transaction;
        transactions.push(new Transaction(1, `TXID${txId}`, 'satoshi', 'whatever', 'whatever', ''));

        block = {
          refSteemBlockNumber: 12345678903,
          refSteemBlockId: 'ABCD1',
          prevRefSteemBlockId: 'ABCD2',
          timestamp: '2018-06-09T00:00:01',
          transactions,
        };

        await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      }

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
        payload: 2
      });

      blockRes = res.payload;
      assert.equal(blockRes.verified, true);
      assert.equal(blockRes.witness, 'witness26');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
            
          }
        }
      });

      params = res.payload;

      assert.equal(params.lastVerifiedBlockNumber, 2);
      
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('generates a new schedule once the current one is complete', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });
      let txId = 100;
      let transactions = [];
      transactions.push(new Transaction(1, 'TXID1', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(1, 'TXID2', 'null', 'contract', 'deploy', JSON.stringify(witnessesContractPayload)));
      transactions.push(new Transaction(1, 'TXID3', 'harpagon', 'tokens', 'stake', `{ "to": "harpagon", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));

      // register 100 witnesses
      for (let index = 0; index < 100; index++) {
        txId++;
        transactions.push(new Transaction(1, `TXID${txId}`, `witness${index}`, 'witnesses', 'register', `{ "RPCUrl": "my.awesome.node", "enabled": true, "isSignedWithActiveKey": true }`));
      }

      let block = {
        refSteemBlockNumber: 32713425,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      for (let index = 0; index < 30; index++) {
        txId++;
        transactions.push(new Transaction(1, `TXID${txId}`, 'harpagon', 'witnesses', 'approve', `{ "witness": "witness${index + 5}", "isSignedWithActiveKey": true }`));
      }

      block = {
        refSteemBlockNumber: 32713425,
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
          table: 'schedules',
          query: {
          }
        }
      });

      let schedule = res.payload;

      for (let index = 0; index < 21; index++) {
        txId++;

        res = await send(database.PLUGIN_NAME, 'MASTER', {
          action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
          payload: schedule[index].blockNumber
        });
  
        let blockRes = res.payload;

        const {
          blockNumber,
          previousHash,
          previousDatabaseHash,
          hash,
          databaseHash,
          merkleRoot,
        } = blockRes;
  
        let payload = {
          blockNumber,
          previousHash,
          previousDatabaseHash,
          hash,
          databaseHash,
          merkleRoot,
          isSignedWithActiveKey: true 
        };

        transactions = [];
        transactions.push(new Transaction(1, `TXID${txId}`, schedule[index].witness, 'witnesses', 'proposeBlock', JSON.stringify(payload)));

        block = {
          refSteemBlockNumber: 32713425,
          refSteemBlockId: 'ABCD13',
          prevRefSteemBlockId: 'ABCD29',
          timestamp: '2018-06-01T00:00:00',
          transactions,
        };

        await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      }

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'schedules',
          query: {
            round: 2
          }
        }
      });

      schedule = res.payload;

      assert.equal(schedule[0].witness, "witness16");
      assert.equal(schedule[0].blockNumber, 23);
      assert.equal(schedule[0].blockPropositionDeadline, 34);

      assert.equal(schedule[1].witness, "witness23");
      assert.equal(schedule[1].blockNumber, 24);
      assert.equal(schedule[1].blockPropositionDeadline, 0);

      assert.equal(schedule[2].witness, "witness34");
      assert.equal(schedule[2].blockNumber, 25);
      assert.equal(schedule[2].blockPropositionDeadline, 0);

      assert.equal(schedule[3].witness, "witness18");
      assert.equal(schedule[3].blockNumber, 26);
      assert.equal(schedule[3].blockPropositionDeadline, 0);

      assert.equal(schedule[4].witness, "witness26");
      assert.equal(schedule[4].blockNumber, 27);
      assert.equal(schedule[4].blockPropositionDeadline, 0);

      assert.equal(schedule[5].witness, "witness30");
      assert.equal(schedule[5].blockNumber, 28);
      assert.equal(schedule[5].blockPropositionDeadline, 0);

      assert.equal(schedule[6].witness, "witness24");
      assert.equal(schedule[6].blockNumber, 29);
      assert.equal(schedule[6].blockPropositionDeadline, 0);

      assert.equal(schedule[7].witness, "witness25");
      assert.equal(schedule[7].blockNumber, 30);
      assert.equal(schedule[7].blockPropositionDeadline, 0);

      assert.equal(schedule[8].witness, "witness15");
      assert.equal(schedule[8].blockNumber, 31);
      assert.equal(schedule[8].blockPropositionDeadline, 0);

      assert.equal(schedule[9].witness, "witness28");
      assert.equal(schedule[9].blockNumber, 32);
      assert.equal(schedule[9].blockPropositionDeadline, 0);

      assert.equal(schedule[10].witness, "witness21");
      assert.equal(schedule[10].blockNumber, 33);
      assert.equal(schedule[10].blockPropositionDeadline, 0);

      assert.equal(schedule[11].witness, "witness31");
      assert.equal(schedule[11].blockNumber, 34);
      assert.equal(schedule[11].blockPropositionDeadline, 0);

      assert.equal(schedule[12].witness, "witness17");
      assert.equal(schedule[12].blockNumber, 35);
      assert.equal(schedule[12].blockPropositionDeadline, 0);

      assert.equal(schedule[13].witness, "witness27");
      assert.equal(schedule[13].blockNumber, 36);
      assert.equal(schedule[13].blockPropositionDeadline, 0);

      assert.equal(schedule[14].witness, "witness33");
      assert.equal(schedule[14].blockNumber, 37);
      assert.equal(schedule[14].blockPropositionDeadline, 0);

      assert.equal(schedule[15].witness, "witness20");
      assert.equal(schedule[15].blockNumber, 38);
      assert.equal(schedule[15].blockPropositionDeadline, 0);

      assert.equal(schedule[16].witness, "witness19");
      assert.equal(schedule[16].blockNumber, 39);
      assert.equal(schedule[16].blockPropositionDeadline, 0);

      assert.equal(schedule[17].witness, "witness29");
      assert.equal(schedule[17].blockNumber, 40);
      assert.equal(schedule[17].blockPropositionDeadline, 0);

      assert.equal(schedule[18].witness, "witness32");
      assert.equal(schedule[18].blockNumber, 41);
      assert.equal(schedule[18].blockPropositionDeadline, 0);

      assert.equal(schedule[19].witness, "witness22");
      assert.equal(schedule[19].blockNumber, 42);
      assert.equal(schedule[19].blockPropositionDeadline, 0);

      assert.equal(schedule[20].witness, "witness11");
      assert.equal(schedule[20].blockNumber, 43);
      assert.equal(schedule[20].blockPropositionDeadline, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
            
          }
        }
      });

      let params = res.payload;
      assert.equal(params.lastVerifiedBlockNumber, 12);
      assert.equal(params.currentWitness, 'witness16');

      for (let j = 0; j < 10; j++) {
        transactions = [];
        txId++
        // send whatever transaction;
        transactions.push(new Transaction(1, `TXID${txId}`, 'satoshi', 'whatever', 'whatever', ''));
        block = {
          refSteemBlockNumber: 32713426,
          refSteemBlockId: 'ABCD123',
          prevRefSteemBlockId: 'ABCD24',
          timestamp: '2018-06-01T00:00:00',
          transactions,
        };

        await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      }  

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
            
          }
        }
      });

      params = res.payload;
      assert.equal(params.lastVerifiedBlockNumber, 22);
      assert.equal(params.currentWitness, 'witness16');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
        payload: 22
      });

      blockRes = res.payload;
      assert.equal(blockRes.verified, true);
      assert.equal(blockRes.witness, 'witness16');
      
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
});
