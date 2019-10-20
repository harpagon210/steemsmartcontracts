/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const fs = require('fs-extra');
const BigNumber = require('bignumber.js');
const { Base64 } = require('js-base64');
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

// prepare tokens contract for deployment
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

console.log(tknContractPayload)

// prepare steempegged contract for deployment
contractCode = fs.readFileSync('./contracts/steempegged.js');
contractCode = contractCode.toString();
contractCode = contractCode.replace(/'\$\{ACCOUNT_RECEIVING_FEES\}\$'/g, CONSTANTS.ACCOUNT_RECEIVING_FEES);
base64ContractCode = Base64.encode(contractCode);

let spContractPayload = {
  name: 'steempegged',
  params: '',
  code: base64ContractCode,
};

console.log(spContractPayload)

// prepare nft contract for deployment
contractCode = fs.readFileSync('./contracts/nft.js');
contractCode = contractCode.toString();
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, CONSTANTS.UTILITY_TOKEN_SYMBOL);
base64ContractCode = Base64.encode(contractCode);

let nftContractPayload = {
  name: 'nft',
  params: '',
  code: base64ContractCode,
};

console.log(nftContractPayload)

// nft
describe('nft', function() {
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

  it('updates parameters', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1230', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1231', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "0.5" , "nftIssuanceFee": "1", "dataPropertyCreationFee": "2", "enableDelegationFee": "3" }'));
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "22.222" }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // check if the params updated OK
      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'nft',
          table: 'params',
          query: {}
        }
      });

      const params = res.payload;
      console.log(params)

      assert.equal(params.nftCreationFee, '22.222');
      assert.equal(params.nftIssuanceFee, '1');
      assert.equal(params.dataPropertyCreationFee, '2');
      assert.equal(params.enableDelegationFee, '3');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('rejects invalid parameters', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1230', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1231', 'cryptomancer', 'nft', 'updateParams', '{ "nftCreationFee": "0.5" , "nftIssuanceFee": "1", "dataPropertyCreationFee": "2", "enableDelegationFee": "3" }'));
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": 0.5 , "nftIssuanceFee": 1, "dataPropertyCreationFee": 2, "enableDelegationFee": 3 }'));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "hi" , "nftIssuanceFee": "bob", "dataPropertyCreationFee": "u", "enableDelegationFee": "rock" }'));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "-0.5" , "nftIssuanceFee": "-1", "dataPropertyCreationFee": "-2", "enableDelegationFee": "-3" }'));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "" }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // params should not have changed from their initial values
      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'nft',
          table: 'params',
          query: {}
        }
      });

      const params = res.payload;
      console.log(params)

      assert.equal(params.nftCreationFee, '100');
      assert.equal(params.nftIssuanceFee, '0.001');
      assert.equal(params.dataPropertyCreationFee, '100');
      assert.equal(params.enableDelegationFee, '1000');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('creates an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"10", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST" }'));

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
          contract: 'nft',
          table: 'nfts',
          query: {}
        }
      });

      let tokens = res.payload;
      console.log(tokens)

      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(tokens[0].name, 'test NFT');
      assert.equal(tokens[0].maxSupply, 1000);
      assert.equal(tokens[0].supply, 0);
      assert.equal(tokens[0].metadata, '{"url":"http://mynft.com"}');
      assert.equal(tokens[0].circulatingSupply, 0);

      assert.equal(tokens[1].symbol, 'TEST');
      assert.equal(tokens[1].issuer, 'cryptomancer');
      assert.equal(tokens[1].name, 'test NFT 2');
      assert.equal(tokens[1].maxSupply, 0);
      assert.equal(tokens[1].supply, 0);
      assert.equal(tokens[1].metadata, '{"url":""}');
      assert.equal(tokens[1].circulatingSupply, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('does not allow nft creation with invalid parameters', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "cryptomancer", "quantity": "1", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "cryptomancer", "quantity": "4", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":false, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"dsfds" }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"tSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test@NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1240', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"-1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1241', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"99999999999999999999999999999999" }'));
      transactions.push(new Transaction(12345678901, 'TXID1242', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1243', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "cryptomancer", "quantity": "5", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1244', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
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
      console.log(transactionsBlock1[4].logs)
      console.log(transactionsBlock1[6].logs)
      console.log(transactionsBlock1[7].logs)
      console.log(transactionsBlock1[8].logs)
      console.log(transactionsBlock1[9].logs)
      console.log(transactionsBlock1[10].logs)
      console.log(transactionsBlock1[11].logs)
      console.log(transactionsBlock1[14].logs)

      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'you must have enough tokens to cover the creation fees');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'invalid symbol: uppercase letters only, max length of 10');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'invalid name: letters, numbers, whitespaces only, max length of 50');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'maxSupply must be positive');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], `maxSupply must be lower than ${Number.MAX_SAFE_INTEGER}`);
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'symbol already exists');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('adds to the list of authorized issuing accounts', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["cryptomancer"] }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["harpagon"] }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["satoshi","aggroed"] }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["satoshi","aggroed","marc"] }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": [] }'));

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
          contract: 'nft',
          table: 'nfts',
          query: {}
        }
      });

      let tokens = res.payload;
      console.log(tokens)

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer","harpagon","satoshi","aggroed","marc"]');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('does not add to the list of authorized issuing accounts', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["acc1","acc2","acc3","acc4","acc5","acc6","acc7"] }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": false, "symbol": "TSTNFT", "accounts": ["harpagon"] }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["satoshi","aggroed"] }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": [1, 2, 3] }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": {"account": "aggroed"} }'));
      transactions.push(new Transaction(12345678901, 'TXID1240', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["dup1","dup2"," DUP2","dup3"] }'));
      transactions.push(new Transaction(12345678901, 'TXID1241', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["acc8","acc9","acc10","acc11"] }'));
      transactions.push(new Transaction(12345678901, 'TXID1242', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["a","aggroed"] }'));
      transactions.push(new Transaction(12345678901, 'TXID1243', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["tooooooooolooooooooong","aggroed"] }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
        payload: 1,
      });

      const block1 = res.payload;
      const transactionsBlock = block1.transactions;
      console.log(transactionsBlock[6].logs);
      console.log(transactionsBlock[7].logs);
      console.log(transactionsBlock[8].logs);
      console.log(transactionsBlock[9].logs);
      console.log(transactionsBlock[10].logs);
      console.log(transactionsBlock[11].logs);
      console.log(transactionsBlock[12].logs);
      console.log(transactionsBlock[13].logs);

      assert.equal(JSON.parse(transactionsBlock[6].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock[7].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(transactionsBlock[8].logs).errors[0], 'invalid account list');
      assert.equal(JSON.parse(transactionsBlock[9].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock[10].logs).errors[0], 'cannot add the same account twice');
      assert.equal(JSON.parse(transactionsBlock[11].logs).errors[0], 'cannot have more than 10 authorized issuing accounts');
      assert.equal(JSON.parse(transactionsBlock[12].logs).errors[0], 'invalid account list');
      assert.equal(JSON.parse(transactionsBlock[13].logs).errors[0], 'invalid account list');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('updates the name of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(30896501, 'TXID1235', 'cryptomancer', 'nft', 'updateName', '{ "symbol": "TSTNFT", "name": "Cool Test NFT" }'));

      block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        }
      });

      const token = res.payload;
      console.log(token);

      assert.equal(token.name, 'Cool Test NFT');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('does not update the name of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(30896501, 'TXID1235', 'harpagon', 'nft', 'updateName', '{ "symbol": "TSTNFT", "name": "Cool Test NFT" }'));
      transactions.push(new Transaction(30896501, 'TXID1236', 'cryptomancer', 'nft', 'updateName', '{ "symbol": "TSTNFT", "name": "&%^#" }'));
      transactions.push(new Transaction(30896501, 'TXID1237', 'cryptomancer', 'nft', 'updateName', '{ "symbol": "TSTNFT", "name": "toolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolong" }'));

      block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        }
      });

      const token = res.payload;
      console.log(token);

      assert.equal(token.name, 'test NFT');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
        payload: 2,
      });

      const block2 = res.payload;
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[0].logs);
      console.log(transactionsBlock2[1].logs);
      console.log(transactionsBlock2[2].logs);

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'invalid name: letters, numbers, whitespaces only, max length of 50');
      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'invalid name: letters, numbers, whitespaces only, max length of 50');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('updates the url of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(30896501, 'TXID1235', 'cryptomancer', 'nft', 'updateMetadata', '{"symbol":"TSTNFT", "metadata": { "url": "https://url.token.com", "image":"https://image.token.com"}}'));
      transactions.push(new Transaction(30896501, 'TXID1236', 'cryptomancer', 'nft', 'updateUrl', '{ "symbol": "TSTNFT", "url": "https://new.token.com" }'));

      block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        }
      });

      const token = res.payload;
      console.log(token);

      assert.equal(JSON.parse(token.metadata).url, 'https://new.token.com');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('does not update the url of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(30896501, 'TXID1235', 'harpagon', 'nft', 'updateUrl', '{ "symbol": "TSTNFT", "url": "https://new.token.com" }'));

      block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        }
      });

      const token = res.payload;
      console.log(token);

      assert.equal(JSON.parse(token.metadata).url, 'http://mynft.com');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
        payload: 2,
      });

      const block2 = res.payload;
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[0].logs);

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'must be the issuer');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('updates the metadata of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(30896501, 'TXID1235', 'cryptomancer', 'nft', 'updateMetadata', '{"symbol":"TSTNFT", "metadata": { "url": "https://url.token.com", "image":"https://image.token.com"}}'));

      block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        }
      });

      const token = res.payload;
      console.log(token);

      const metadata = JSON.parse(token.metadata);
      assert.equal(metadata.url, 'https://url.token.com');
      assert.equal(metadata.image, 'https://image.token.com');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('does not update the metadata of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(30896501, 'TXID1235', 'harpagon', 'nft', 'updateMetadata', '{"symbol":"TSTNFT", "metadata": { "url": "https://url.token.com", "image":"https://image.token.com"}}'));

      block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        }
      });

      const token = res.payload;
      console.log(token);

      const metadata = JSON.parse(token.metadata);
      assert.equal(metadata.url, 'http://mynft.com');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
        payload: 2,
      });

      const block2 = res.payload;
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[0].logs);

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'must be the issuer');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('transfers the ownership of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

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
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        }
      });

      let token = res.payload;

      assert.equal(token.issuer, 'cryptomancer');
      assert.equal(token.symbol, 'TSTNFT');

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1235', 'cryptomancer', 'nft', 'transferOwnership', '{ "symbol":"TSTNFT", "to": "satoshi", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        }
      });

      token = res.payload;
      console.log(token)

      assert.equal(token.issuer, 'satoshi');
      assert.equal(token.symbol, 'TSTNFT');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('does not transfer the ownership of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

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
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        }
      });

      let token = res.payload;

      assert.equal(token.issuer, 'cryptomancer');
      assert.equal(token.symbol, 'TSTNFT');

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'nft', 'transferOwnership', '{ "symbol":"TSTNFT", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'cryptomancer', 'nft', 'transferOwnership', '{ "symbol":"TSTNFT", "to": "satoshi", "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'cryptomancer', 'nft', 'transferOwnership', '{ "symbol":"TSTNFT", "to": "s", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        }
      });

      token = res.payload;
      console.log(token)

      assert.equal(token.issuer, 'cryptomancer');
      assert.equal(token.symbol, 'TSTNFT');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO,
        payload: 2,
      });

      const block2 = res.payload;
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[0].logs);
      console.log(transactionsBlock2[1].logs);
      console.log(transactionsBlock2[2].logs);

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'invalid to');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
});
