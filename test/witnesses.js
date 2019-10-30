/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const fs = require('fs-extra');
const { MongoClient } = require('mongodb');
const dsteem = require('dsteem');
const SHA256 = require('crypto-js/sha256');
const enchex = require('crypto-js/enc-hex');

const database = require('../plugins/Database');
const blockchain = require('../plugins/Blockchain');
const { Transaction } = require('../libs/Transaction');

const { CONSTANTS } = require('../libs/Constants');

//process.env.ACCOUNT = 'witness20';
//process.env.ACTIVE_SIGNING_KEY = dsteem.PrivateKey.fromLogin(process.env.ACCOUNT, 'testnet', 'active').toString();

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

const signPayload = (signingKey, payload, isPayloadSHA256 = false) => {
  let payloadHash;
  if (isPayloadSHA256 === true) {
    payloadHash = payload;
  } else {
    payloadHash = typeof payload === 'string'
      ? SHA256(payload).toString(enchex)
      : SHA256(JSON.stringify(payload)).toString(enchex);
  }

  const buffer = Buffer.from(payloadHash, 'hex');

  return signingKey.sign(buffer).toString();
};

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
      transactions.push(new Transaction(1, 'TXID3', 'dan', 'witnesses', 'register', `{ "IP": "123.255.123.254", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pR", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID4', 'vitalik', 'witnesses', 'register', `{ "IP": "123.255.123.253", "RPCPort": 7000, "P2PPort": 8000, "signingKey": "STM8T4zKJuXgjLiKbp6fcsTTUtDY7afwc4XT9Xpf6uakYxwxfBabq", "enabled": false, "isSignedWithActiveKey": true }`));

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

      assert.equal(witnesses[0].account, 'dan');
      assert.equal(witnesses[0].IP, "123.255.123.254");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '0');
      assert.equal(witnesses[0].RPCPort, 5000);
      assert.equal(witnesses[0].P2PPort, 6000);
      assert.equal(witnesses[0].signingKey, 'STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pR');
      assert.equal(witnesses[0].enabled, true);

      assert.equal(witnesses[1].account, 'vitalik');
      assert.equal(witnesses[1].IP, "123.255.123.253");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, '0');
      assert.equal(witnesses[1].RPCPort, 7000);
      assert.equal(witnesses[1].P2PPort, 8000);
      assert.equal(witnesses[1].signingKey, 'STM8T4zKJuXgjLiKbp6fcsTTUtDY7afwc4XT9Xpf6uakYxwxfBabq');
      assert.equal(witnesses[1].enabled, false);

      transactions = [];

      transactions.push(new Transaction(2, 'TXID5', 'dan', 'witnesses', 'register', `{ "IP": "123.255.123.123", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pR", "enabled": false, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(2, 'TXID6', 'vitalik', 'witnesses', 'register', `{ "IP": "123.255.123.124", "RPCPort": 7000, "P2PPort": 8000, "signingKey": "STM8T4zKJuXgjLiKbp6fcsTTUtDY7afwc4XT9Xpf6uakYxwxfBabq", "enabled": true, "isSignedWithActiveKey": true }`));

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

      assert.equal(witnesses[0].account, 'dan');
      assert.equal(witnesses[0].IP, "123.255.123.123");
      assert.equal(witnesses[0].approvalWeight.$numberDecimal, '0');
      assert.equal(witnesses[0].RPCPort, 5000);
      assert.equal(witnesses[0].P2PPort, 6000);
      assert.equal(witnesses[0].signingKey, 'STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pR');
      assert.equal(witnesses[0].enabled, false);

      assert.equal(witnesses[1].account, 'vitalik');
      assert.equal(witnesses[1].IP, "123.255.123.124");
      assert.equal(witnesses[1].approvalWeight.$numberDecimal, '0');
      assert.equal(witnesses[1].RPCPort, 7000);
      assert.equal(witnesses[1].P2PPort, 8000);
      assert.equal(witnesses[1].signingKey, 'STM8T4zKJuXgjLiKbp6fcsTTUtDY7afwc4XT9Xpf6uakYxwxfBabq');
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
      transactions.push(new Transaction(1, 'TXID3', 'dan', 'witnesses', 'register', `{ "IP": "123.234.123.234", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pR", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID4', 'vitalik', 'witnesses', 'register', `{ "IP": "123.234.123.233", "RPCPort": 7000, "P2PPort": 8000, "signingKey": "STM8T4zKJuXgjLiKbp6fcsTTUtDY7afwc4XT9Xpf6uakYxwxfBabq", "enabled": false, "isSignedWithActiveKey": true }`));
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
      transactions.push(new Transaction(1, 'TXID8', 'satoshi', 'witnesses', 'register', `{ "IP": "123.234.123.245", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pJ", "enabled": true, "isSignedWithActiveKey": true }`));
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
      transactions.push(new Transaction(1, 'TXID3', 'dan', 'witnesses', 'register', `{ "IP": "123.234.123.233", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pR", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID4', 'vitalik', 'witnesses', 'register', `{ "IP": "123.234.123.232", "RPCPort": 7000, "P2PPort": 8000, "signingKey": "STM8T4zKJuXgjLiKbp6fcsTTUtDY7afwc4XT9Xpf6uakYxwxfBabq", "enabled": false, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID5', 'harpagon', 'tokens', 'stake', `{ "to": "harpagon", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "100", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID6', 'harpagon', 'witnesses', 'approve', `{ "witness": "dan", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID7', 'harpagon', 'witnesses', 'approve', `{ "witness": "vitalik", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID8', 'satoshi', 'witnesses', 'register', `{ "IP": "123.234.123.231", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pJ", "enabled": true, "isSignedWithActiveKey": true }`));
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
      transactions.push(new Transaction(1, 'TXID3', 'dan', 'witnesses', 'register', `{ "IP": "123.234.123.233", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "STM7sw22HqsXbz7D2CmJfmMwt9rimtk518dRzsR1f8Cgw52dQR1pR", "enabled": true, "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(1, 'TXID4', 'vitalik', 'witnesses', 'register', `{ "IP": "123.234.123.234", "RPCPort": 7000, "P2PPort": 8000, "signingKey": "STM8T4zKJuXgjLiKbp6fcsTTUtDY7afwc4XT9Xpf6uakYxwxfBabq", "enabled": false, "isSignedWithActiveKey": true }`));
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
        const witnessAccount = `witness${index}`;
        const wif = dsteem.PrivateKey.fromLogin(witnessAccount, 'testnet', 'active');
        transactions.push(new Transaction(1, `TXID${txId}`, witnessAccount, 'witnesses', 'register', `{ "IP": "123.123.123.${txId}", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "${wif.createPublic('TST').toString()}", "enabled": true, "isSignedWithActiveKey": true }`));
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

      assert.equal(schedule[0].witness, "witness34");
      assert.equal(schedule[0].blockNumber, 2);
      assert.equal(schedule[0].round, 1);

      assert.equal(schedule[1].witness, "witness33");
      assert.equal(schedule[1].blockNumber, 3);
      assert.equal(schedule[1].round, 1);

      assert.equal(schedule[2].witness, "witness32");
      assert.equal(schedule[2].blockNumber, 4);
      assert.equal(schedule[2].round, 1);

      assert.equal(schedule[3].witness, "witness15");
      assert.equal(schedule[3].blockNumber, 5);
      assert.equal(schedule[3].round, 1);

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
      assert.equal(params.currentWitness, 'witness15');
      assert.equal(params.lastWitnesses.includes('witness15'), true);
      assert.equal(params.round, 1);
      assert.equal(params.lastBlockRound, 5);

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
        const witnessAccount = `witness${index}`;
        const wif = dsteem.PrivateKey.fromLogin(witnessAccount, 'testnet', 'active');
        transactions.push(new Transaction(1, `TXID${txId}`, witnessAccount, 'witnesses', 'register', `{ "IP": "123.123.123.${txId}", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "${wif.createPublic().toString()}", "enabled": true, "isSignedWithActiveKey": true }`));
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

      for (let i = 1; i < 4; i++) {
        transactions = [];
        txId++
        // send whatever transaction;
        transactions.push(new Transaction(i, `TXID${txId}`, 'satoshi', 'whatever', 'whatever', ''));
        block = {
          refSteemBlockNumber: 32713426 + i,
          refSteemBlockId: `ABCD123${i}`,
          prevRefSteemBlockId: `ABCD123${i - 1}`,
          timestamp: `2018-06-01T00:00:0${i}`,
          transactions,
        };

        await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      } 

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
            
          }
        }
      });

      let params = res.payload;

      let blockNum = params.lastVerifiedBlockNumber + 1;
      const endBlockRound = params.lastBlockRound;

      let calculatedRoundHash = '';
      // calculate round hash
      while (blockNum <= endBlockRound) {
        // get the block from the current node
        const queryRes = await send(database.PLUGIN_NAME, 'MASTER', {
          action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
          payload: blockNum
        });

        const blockFromNode = queryRes.payload;
        if (blockFromNode !== null) {
          calculatedRoundHash = SHA256(`${calculatedRoundHash}${blockFromNode.hash}`).toString(enchex);
        }
        blockNum += 1;
      }
      
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'schedules',
          query: {
            
          }
        }
      });

      let schedules = res.payload;

      const signatures = [];
      schedules.forEach(schedule => {
        const wif = dsteem.PrivateKey.fromLogin(schedule.witness, 'testnet', 'active');
        const sig = signPayload(wif, calculatedRoundHash, true)
        signatures.push([schedule.witness, sig])
      });

      const json = {
        round: 1,
        roundHash: calculatedRoundHash,
        signatures,
        isSignedWithActiveKey: true,
      };

      transactions = [];
      txId++;
      transactions.push(new Transaction(1, `TXID${txId}`, params.currentWitness, 'witnesses', 'proposeRound', JSON.stringify(json)));

      block = {
        refSteemBlockNumber: 32713425,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      blockNum = params.lastVerifiedBlockNumber + 1;

      // check if the blocks are now marked as verified
      let i = 0;
      while (blockNum <= endBlockRound) {
        // get the block from the current node
        const queryRes = await send(database.PLUGIN_NAME, 'MASTER', {
          action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
          payload: blockNum
        });

        const blockFromNode = queryRes.payload;
        const wif = dsteem.PrivateKey.fromLogin(blockFromNode.witness, 'testnet', 'active');
        assert.equal(blockFromNode.round, 1);
        assert.equal(blockFromNode.witness, schedules[schedules.length - 1].witness);
        assert.equal(blockFromNode.roundHash, calculatedRoundHash);
        assert.equal(blockFromNode.signingKey, wif.createPublic().toString());
        assert.equal(blockFromNode.roundSignature, signatures[signatures.length - 1][1]);
        
        blockNum += 1;
        i +=1;
      }
      
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('generates a new schedule once the current one is completed', (done) => {
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
        const witnessAccount = `witness${index}`;
        const wif = dsteem.PrivateKey.fromLogin(witnessAccount, 'testnet', 'active');
        transactions.push(new Transaction(1, `TXID${txId}`, witnessAccount, 'witnesses', 'register', `{ "IP": "123.123.123.${txId}", "RPCPort": 5000, "P2PPort": 6000, "signingKey": "${wif.createPublic().toString()}", "enabled": true, "isSignedWithActiveKey": true }`));
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

      for (let i = 1; i < 4; i++) {
        transactions = [];
        txId++
        // send whatever transaction;
        transactions.push(new Transaction(i, `TXID${txId}`, 'satoshi', 'whatever', 'whatever', ''));
        block = {
          refSteemBlockNumber: 32713426 + i,
          refSteemBlockId: `ABCD123${i}`,
          prevRefSteemBlockId: `ABCD123${i - 1}`,
          timestamp: `2018-06-01T00:00:0${i}`,
          transactions,
        };

        await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      } 

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'witnesses',
          table: 'params',
          query: {
            
          }
        }
      });

      let params = res.payload;

      let blockNum = params.lastVerifiedBlockNumber + 1;
      const endBlockRound = params.lastBlockRound;

      let calculatedRoundHash = '';
      // calculate round hash
      while (blockNum <= endBlockRound) {
        // get the block from the current node
        const queryRes = await send(database.PLUGIN_NAME, 'MASTER', {
          action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
          payload: blockNum
        });

        const blockFromNode = queryRes.payload;
        if (blockFromNode !== null) {
          calculatedRoundHash = SHA256(`${calculatedRoundHash}${blockFromNode.hash}`).toString(enchex);
        }
        blockNum += 1;
      }
      
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'witnesses',
          table: 'schedules',
          query: {
            
          }
        }
      });

      let schedules = res.payload;

      const signatures = [];
      schedules.forEach(schedule => {
        const wif = dsteem.PrivateKey.fromLogin(schedule.witness, 'testnet', 'active');
        const sig = signPayload(wif, calculatedRoundHash, true)
        signatures.push([schedule.witness, sig])
      });

      const json = {
        round: 1,
        roundHash: calculatedRoundHash,
        signatures,
        isSignedWithActiveKey: true,
      };

      transactions = [];
      txId++;
      transactions.push(new Transaction(1, `TXID${txId}`, params.currentWitness, 'witnesses', 'proposeRound', JSON.stringify(json)));

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

      assert.equal(schedule[0].witness, "witness33");
      assert.equal(schedule[0].blockNumber, 6);
      assert.equal(schedule[0].round, 2);

      assert.equal(schedule[1].witness, "witness15");
      assert.equal(schedule[1].blockNumber, 7);
      assert.equal(schedule[1].round, 2);

      assert.equal(schedule[2].witness, "witness32");
      assert.equal(schedule[2].blockNumber, 8);
      assert.equal(schedule[2].round, 2);

      assert.equal(schedule[3].witness, "witness34");
      assert.equal(schedule[3].blockNumber, 9);
      assert.equal(schedule[3].round, 2);

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

      assert.equal(params.totalApprovalWeight, '3000.00000000');
      assert.equal(params.numberOfApprovedWitnesses, 30);
      assert.equal(params.lastVerifiedBlockNumber, 5);
      assert.equal(params.currentWitness, 'witness34');
      assert.equal(params.lastWitnesses.includes('witness34'), true);
      assert.equal(params.round, 2);
      assert.equal(params.lastBlockRound, 9);
      
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

});
