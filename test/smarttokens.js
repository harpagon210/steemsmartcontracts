/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const fs = require('fs-extra');
const BigNumber = require('bignumber.js');
const { Base64 } = require('js-base64');

const database = require('../plugins/Database');
const blockchain = require('../plugins/Blockchain');
const { Block } = require('../libs/Block');
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


let contractCode = fs.readFileSync('./contracts/tokens.js');
contractCode = contractCode.toString();

contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_PRECISION\}\$'/g, CONSTANTS.UTILITY_TOKEN_PRECISION);
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, CONSTANTS.UTILITY_TOKEN_SYMBOL);

let base64ContractCode = Base64.encode(contractCode);

let contractPayload = {
  name: 'tokens',
  params: '',
  code: base64ContractCode,
};

// smart tokens
describe('smart tokens', function () {
  this.timeout(30000);

  it('should enable delegation', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      let token = res.payload;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.stakingEnabled, true);
      assert.equal(token.unstakingCooldown, 7);
      assert.equal(token.delegationEnabled, true);
      assert.equal(token.undelegationCooldown, 7);
      
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not enable delegation', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "NKT", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1240', 'satoshi', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 365, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1241', 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 0, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1242', 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 366, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1243', 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1244', 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let txs = res.payload.transactions;

      assert.equal(JSON.parse(txs[4].logs).errors[0], 'staking not enabled');
      assert.equal(JSON.parse(txs[6].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(txs[7].logs).errors[0], 'undelegationCooldown must be an integer between 1 and 365');
      assert.equal(JSON.parse(txs[8].logs).errors[0], 'undelegationCooldown must be an integer between 1 and 365');
      assert.equal(JSON.parse(txs[10].logs).errors[0], 'delegation already enabled');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should delegate tokens', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1240', 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "vitalik", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
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
            account: {
              $in: ['satoshi', 'vitalik']
            },
            symbol: 'TKN'
          }
        }
      });

      let balances = res.payload;

      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].account, 'satoshi');
      assert.equal(balances[0].balance, "99.99999999");
      assert.equal(balances[0].stake, "0.00000000");
      assert.equal(balances[0].delegationsOut, "0.00000001");

      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].account, 'vitalik');
      assert.equal(balances[1].balance, "0");
      assert.equal(balances[1].stake, "0");
      assert.equal(balances[1].delegationsIn, "0.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'delegations',
          query: {
            from: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let delegations = res.payload;

      assert.equal(delegations[0].symbol, 'TKN');
      assert.equal(delegations[0].from, 'satoshi');
      assert.equal(delegations[0].to, 'vitalik');
      assert.equal(delegations[0].quantity, '0.00000001');

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1241', 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000003", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1242', 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1243', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "ned", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1244', 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "ned", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:01',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: {
              $in: ['satoshi', 'vitalik', 'ned']
            },
            symbol: 'TKN'
          }
        }
      });

      balances = res.payload;

      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].account, 'satoshi');
      assert.equal(balances[0].balance, "99.99999996");
      assert.equal(balances[0].stake, "0.00000000");
      assert.equal(balances[0].delegationsOut, "0.00000004");

      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].account, 'vitalik');
      assert.equal(balances[1].balance, "0");
      assert.equal(balances[1].stake, "0");
      assert.equal(balances[1].delegationsIn, "0.00000003");

      assert.equal(balances[2].symbol, 'TKN');
      assert.equal(balances[2].account, 'ned');
      assert.equal(balances[2].balance, "100");
      assert.equal(balances[2].stake, "0");
      assert.equal(balances[2].delegationsIn, "0.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'delegations',
          query: {
            from: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      delegations = res.payload;

      assert.equal(delegations[0].symbol, 'TKN');
      assert.equal(delegations[0].from, 'satoshi');
      assert.equal(delegations[0].to, 'ned');
      assert.equal(delegations[0].quantity, '0.00000001');

      assert.equal(delegations[1].symbol, 'TKN');
      assert.equal(delegations[1].from, 'satoshi');
      assert.equal(delegations[1].to, 'vitalik');
      assert.equal(delegations[1].quantity, '0.00000003');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not delegate tokens', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "az", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'delegate', '{ "symbol": "NKT", "quantity": "0.00000001", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1240', 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.000000001", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1241', 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1242', 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1243', 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "-0.00000001", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1244', 'ned', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1245', 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1246', 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "satoshi", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
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
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, 100);
      assert.equal(balance.stake, 0);
      assert.equal(balance.delegationsOut, 0);
      assert.equal(balance.delegationsIn, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let txs = res.payload.transactions;

      assert.equal(JSON.parse(txs[5].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(txs[6].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(txs[7].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(txs[8].logs).errors[0], 'delegation not enabled');
      assert.equal(JSON.parse(txs[10].logs).errors[0], 'must delegate positive quantity');
      assert.equal(JSON.parse(txs[11].logs).errors[0], 'balanceFrom does not exist');
      assert.equal(JSON.parse(txs[12].logs).errors[0], 'overdrawn stake');
      assert.equal(JSON.parse(txs[13].logs).errors[0], 'cannot delegate to yourself');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should undelegate tokens', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000003", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1240', 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1241', 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "ned", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
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
            account: {
              $in: ['satoshi', 'vitalik', 'ned']
            },
            symbol: 'TKN'
          }
        }
      });

      let balances = res.payload;
      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].account, 'satoshi');
      assert.equal(balances[0].balance, "99.99999997");
      assert.equal(balances[0].stake, "0.00000000");
      assert.equal(balances[0].delegationsOut, "0.00000003");
      assert.equal(balances[0].pendingUndelegations, '0');

      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].account, 'vitalik');
      assert.equal(balances[1].balance, "0");
      assert.equal(balances[1].stake, "0");
      assert.equal(balances[1].delegationsIn, "0.00000002");

      assert.equal(balances[2].symbol, 'TKN');
      assert.equal(balances[2].account, 'ned');
      assert.equal(balances[2].balance, "0");
      assert.equal(balances[2].stake, "0");
      assert.equal(balances[2].delegationsIn, "0.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'delegations',
          query: {
            from: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let delegations = res.payload;

      assert.equal(delegations[0].symbol, 'TKN');
      assert.equal(delegations[0].from, 'satoshi');
      assert.equal(delegations[0].to, 'ned');
      assert.equal(delegations[0].quantity, '0.00000001');

      assert.equal(delegations[1].symbol, 'TKN');
      assert.equal(delegations[1].from, 'satoshi');
      assert.equal(delegations[1].to, 'vitalik');
      assert.equal(delegations[1].quantity, '0.00000002');

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1242', 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:01',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: {
              $in: ['satoshi', 'vitalik', 'ned']
            },
            symbol: 'TKN'
          }
        }
      });

      balances = res.payload;

      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].account, 'satoshi');
      assert.equal(balances[0].balance, "99.99999997");
      assert.equal(balances[0].stake, "0.00000000");
      assert.equal(balances[0].delegationsOut, "0.00000002");
      assert.equal(balances[0].pendingUndelegations, '0.00000001');

      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].account, 'vitalik');
      assert.equal(balances[1].balance, "0");
      assert.equal(balances[1].stake, "0");
      assert.equal(balances[1].delegationsIn, "0.00000001");

      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].account, 'vitalik');
      assert.equal(balances[1].balance, "0");
      assert.equal(balances[1].stake, "0");
      assert.equal(balances[1].delegationsIn, "0.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'delegations',
          query: {
            from: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      delegations = res.payload;

      assert.equal(delegations[0].symbol, 'TKN');
      assert.equal(delegations[0].from, 'satoshi');
      assert.equal(delegations[0].to, 'vitalik');
      assert.equal(delegations[0].quantity, '0.00000001');

      assert.equal(delegations[1].symbol, 'TKN');
      assert.equal(delegations[1].from, 'satoshi');
      assert.equal(delegations[1].to, 'ned');
      assert.equal(delegations[1].quantity, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'pendingUndelegations',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let pendingUndelegations = res.payload;

      assert.equal(pendingUndelegations[0].symbol, 'TKN');
      assert.equal(pendingUndelegations[0].account, 'satoshi');
      assert.equal(pendingUndelegations[0].quantity, '0.00000001');
      let blockDate = new Date('2018-06-01T00:00:01.000Z')
      assert.equal(pendingUndelegations[0].completeTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(pendingUndelegations[0].txID, 'TXID1242');


      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not undelegate tokens', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "az", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'undelegate', '{ "symbol": "NKT", "quantity": "0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1240', 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.000000001", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1241', 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1242', 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1243', 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "-0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1244', 'ned', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000002", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1245', 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000002", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1246', 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000002", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1247', 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000004", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1248', 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "ned", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1249', 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1250', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1251', 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1252', 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1253', 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000002", "from": "ned", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1254', 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000002", "from": "satoshi", "isSignedWithActiveKey": true }'));
      
      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let txs = res.payload.transactions;

      assert.equal(JSON.parse(txs[5].logs).errors[0], 'invalid from');
      assert.equal(JSON.parse(txs[6].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(txs[7].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(txs[8].logs).errors[0], 'delegation not enabled');
      assert.equal(JSON.parse(txs[10].logs).errors[0], 'must undelegate positive quantity');
      assert.equal(JSON.parse(txs[11].logs).errors[0], 'balanceTo does not exist');
      assert.equal(JSON.parse(txs[12].logs).errors[0], 'overdrawn delegation');
      assert.equal(JSON.parse(txs[16].logs).errors[0], 'balanceFrom does not exist');
      assert.equal(JSON.parse(txs[18].logs).errors[0], 'delegation does not exist');
      assert.equal(JSON.parse(txs[20].logs).errors[0], 'overdrawn delegation');
      assert.equal(JSON.parse(txs[21].logs).errors[0], 'cannot undelegate from yourself');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should process the pending undelegations', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'harpagon', 'tokens', 'enableDelegation', '{ "symbol": "TKN", "undelegationCooldown": 7, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000003", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1240', 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000002", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1241', 'satoshi', 'tokens', 'delegate', '{ "symbol": "TKN", "quantity": "0.00000001", "to": "ned", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1242', 'satoshi', 'tokens', 'undelegate', '{ "symbol": "TKN", "quantity": "0.00000001", "from": "vitalik", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678902,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-02T00:00:01',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123810', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678903,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-09T00:00:01',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999997');
      assert.equal(balance.stake, '0.00000001');
      assert.equal(balance.delegationsIn, '0');
      assert.equal(balance.delegationsOut, '0.00000002');
      assert.equal(balance.pendingUndelegations, '0.00000000');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUndelegations',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let undelegation = res.payload;

      assert.equal(undelegation, null);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let vtxs = res.payload.virtualTransactions;
      const logs = JSON.parse(vtxs[0].logs);
      const event = logs.events[0];

      assert.equal(event.contract, 'tokens');
      assert.equal(event.event, 'undelegateDone');
      assert.equal(event.data.account, 'satoshi');
      assert.equal(event.data.quantity, '0.00000001');
      assert.equal(event.data.symbol, 'TKN');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should enable staking', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      let token = res.payload;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.stakingEnabled, true);
      assert.equal(token.unstakingCooldown, 7);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not enable staking', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "NKT", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 0, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 366, "numberTransactions": 1, "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      let token = res.payload;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.stakingEnabled, false);
      assert.equal(token.unstakingCooldown, 1);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let txs = res.payload.transactions;

      assert.equal(JSON.parse(txs[4].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(txs[5].logs).errors[0], 'unstakingCooldown must be an integer between 1 and 365');
      assert.equal(JSON.parse(txs[6].logs).errors[0], 'unstakingCooldown must be an integer between 1 and 365');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not enable staking again', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 10, "numberTransactions": 1, "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      let token = res.payload;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.stakingEnabled, true);
      assert.equal(token.unstakingCooldown, 7);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_TRANSACTION_INFO,
        payload: 'TXID1238'
      });

      let tx = res.payload;

      assert.equal(JSON.parse(tx.logs).errors[0], 'staking already enabled');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should stake tokens', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
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
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1240', 'satoshi', 'tokens', 'stake', '{ "to":"vitalik", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:01',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: {
              $in: ['satoshi', 'vitalik']
            },
            symbol: 'TKN'
          }
        }
      });

      let balances = res.payload;

      assert.equal(balances[0].symbol, 'TKN');
      assert.equal(balances[0].account, 'satoshi');
      assert.equal(balances[0].balance, '99.99999997');
      assert.equal(balances[0].stake, '0.00000002');

      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].account, 'vitalik');
      assert.equal(balances[1].balance, 0);
      assert.equal(balances[1].stake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let txs = res.payload.transactions;
      
      assert.equal(JSON.parse(txs[0].logs).events[0].contract, 'tokens');
      assert.equal(JSON.parse(txs[0].logs).events[0].event, 'stake');
      assert.equal(JSON.parse(txs[0].logs).events[0].data.account, 'satoshi');
      assert.equal(JSON.parse(txs[0].logs).events[0].data.quantity, '0.00000001');
      assert.equal(JSON.parse(txs[0].logs).events[0].data.symbol, 'TKN');

      assert.equal(JSON.parse(txs[1].logs).events[0].contract, 'tokens');
      assert.equal(JSON.parse(txs[1].logs).events[0].event, 'stake');
      assert.equal(JSON.parse(txs[1].logs).events[0].data.account, 'vitalik');
      assert.equal(JSON.parse(txs[1].logs).events[0].data.quantity, '0.00000001');
      assert.equal(JSON.parse(txs[1].logs).events[0].data.symbol, 'TKN');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
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

      assert.equal(token.totalStaked, '0.00000003');

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
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'tokens', 'stake', '{ "to":"ez", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1240', 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "-1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1241', 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "100.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1242', 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.000000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
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
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "100");
      assert.equal(balance.stake, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let txs = res.payload.transactions;

      assert.equal(JSON.parse(txs[4].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(txs[5].logs).errors[0], 'staking not enabled');
      assert.equal(JSON.parse(txs[7].logs).errors[0], 'must stake positive quantity');
      assert.equal(JSON.parse(txs[8].logs).errors[0], 'overdrawn balance');
      assert.equal(JSON.parse(txs[9].logs).errors[0], 'symbol precision mismatch');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should start the unstake process', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
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
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      assert.equal(unstake.quantityLeft, '0.00000001');
      assert.equal(unstake.numberTransactionsLeft, 1);
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(unstake.txID, 'TXID1239');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not start the unstake process', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "-1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1240', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1241', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.000000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
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
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "100");
      assert.equal(balance.stake, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let txs = res.payload.transactions;

      assert.equal(JSON.parse(txs[4].logs).errors[0], 'staking not enabled');
      assert.equal(JSON.parse(txs[6].logs).errors[0], 'must unstake positive quantity');
      assert.equal(JSON.parse(txs[7].logs).errors[0], 'overdrawn stake');
      assert.equal(JSON.parse(txs[8].logs).errors[0], 'symbol precision mismatch');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should cancel an unstake', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
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
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID123910', 'satoshi', 'tokens', 'cancelUnstake', '{ "txID": "TXID1239", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:03:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, '0.00000001');
      assert.equal(balance.pendingUnstake, '0.00000000');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake, null);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not cancel an unstake', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
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
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      let blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID123910', 'satoshi', 'tokens', 'cancelUnstake', '{ "txID": "TXID12378", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123911', 'harpagon', 'tokens', 'cancelUnstake', '{ "txID": "TXID1239", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:03:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, '0.00000000');
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(unstake.txID, 'TXID1239');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should process the pending unstakes', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
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
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      let token = res.payload;

      assert.equal(token.totalStaked, '0.00000001');

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123810', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-07T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '100.00000000');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake, null);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let vtxs = res.payload.virtualTransactions;
      const logs = JSON.parse(vtxs[0].logs);
      const event = logs.events[0];

      assert.equal(event.contract, 'tokens');
      assert.equal(event.event, 'unstake');
      assert.equal(event.data.account, 'satoshi');
      assert.equal(event.data.quantity, '0.00000001');
      assert.equal(event.data.symbol, 'TKN');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      token = res.payload;

      assert.equal(token.totalStaked, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it.skip('should process thousands of pending unstakes', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
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
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123810', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-07T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '100.00000000');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake, null);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let vtxs = res.payload.virtualTransactions;
      const logs = JSON.parse(vtxs[0].logs);
      const event = logs.events[0];

      assert.equal(event.contract, 'tokens');
      assert.equal(event.event, 'unstake');
      assert.equal(event.data.account, 'satoshi');
      assert.equal(event.data.quantity, '0.00000001');
      assert.equal(event.data.symbol, 'TKN');

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID223811', 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "1", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-14T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // generate thousands of unstakes
      console.log('start generating pending unstakes');
      for (let index = 10000; index < 12000; index++) {
        transactions = [];
        transactions.push(new Transaction(12345678901, `TXID${index}`, 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

        block = {
          refSteemBlockNumber: 12345678901,
          refSteemBlockId: 'ABCD1',
          prevRefSteemBlockId: 'ABCD2',
          timestamp: '2018-07-14T00:02:00',
          transactions,
        };

        await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      }

      transactions = [];
      transactions.push(new Transaction(12345678901, `TXID2000`, 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      console.log('done generating pending unstakes');

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-14T00:02:01',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.00000000');
      assert.equal(balance.stake, '0.99997999');
      assert.equal(balance.pendingUnstake, '0.00002001');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123899', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-21T00:02:00',
        transactions,
      };

      console.log('start processing pending unstakes');
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      console.log('done processing pending unstakes')
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.00002000');
      assert.equal(balance.stake, '0.99997999');
      assert.equal(balance.pendingUnstake, '0.00000001');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should process the pending unstakes (with multi transactions)', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 3, "numberTransactions": 3, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "to":"satoshi", "symbol": "TKN", "quantity": "0.00000008", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
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
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999992");
      assert.equal(balance.stake, "0.00000008");

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000006", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-01T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999992');
      assert.equal(balance.stake, '0.00000002');
      assert.equal(balance.pendingUnstake, '0.00000006');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000006');
      assert.equal(unstake.quantityLeft, '0.00000006');
      assert.equal(unstake.numberTransactionsLeft, 3);
      let blockDate = new Date('2018-07-01T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 1));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123810', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-02T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999994');
      assert.equal(balance.stake, '0.00000002');
      assert.equal(balance.pendingUnstake, '0.00000004');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000006');
      assert.equal(unstake.quantityLeft, '0.00000004');
      assert.equal(unstake.numberTransactionsLeft, 2);
      blockDate = new Date('2018-07-02T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 1));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123811', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-03T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999996');
      assert.equal(balance.stake, '0.00000002');
      assert.equal(balance.pendingUnstake, '0.00000002');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000006');
      assert.equal(unstake.quantityLeft, '0.00000002');
      assert.equal(unstake.numberTransactionsLeft, 1);
      blockDate = new Date('2018-07-03T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 1));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123812', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-04T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999998');
      assert.equal(balance.stake, '0.00000002');
      assert.equal(balance.pendingUnstake, '0.00000000');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake, null);



      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

});
