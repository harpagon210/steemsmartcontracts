/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const fs = require('fs-extra');
const { Base64 } = require('js-base64');
const { MongoClient } = require('mongodb');


const { Database } = require('../libs/Database');
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

//console.log(tknContractPayload)

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

//console.log(nftContractPayload)

// prepare test contract for issuing & transferring NFT instances
const testSmartContractCode = `
  actions.createSSC = function (payload) {
    // Initialize the smart contract via the create action
  }

  actions.doTransfer = async function (payload) {
    await api.executeSmartContract('nft', 'transfer', payload);
  }

  actions.doDelegation = async function (payload) {
    await api.executeSmartContract('nft', 'delegate', payload);
  }

  actions.doUndelegation = async function (payload) {
    await api.executeSmartContract('nft', 'undelegate', payload);
  }

  actions.doBurn = async function (payload) {
    await api.executeSmartContract('nft', 'burn', payload);
  }

  actions.doIssuance = async function (payload) {
    await api.executeSmartContract('nft', 'issue', payload);
  }

  actions.doMultipleIssuance = async function (payload) {
    await api.executeSmartContract('nft', 'issueMultiple', payload);
  }

  actions.doSetProperties = async function (payload) {
    await api.executeSmartContract('nft', 'setProperties', payload);
  }
`;

base64ContractCode = Base64.encode(testSmartContractCode);

let testcontractPayload = {
  name: 'testcontract',
  params: '',
  code: base64ContractCode,
};

console.log(testcontractPayload)

// nft
describe('nft', function() {
  this.timeout(20000);

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
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1230', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1231', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "0.5" , "nftIssuanceFee": {"DEC":"500","SCT":"0.75"}, "dataPropertyCreationFee": "2", "enableDelegationFee": "3" }'));
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
      const res = await database1.findOne({
          contract: 'nft',
          table: 'params',
          query: {}
        });

      const params = res;
      console.log(params)

      assert.equal(params.nftCreationFee, '22.222');
      assert.equal(JSON.stringify(params.nftIssuanceFee), '{"DEC":"500","SCT":"0.75"}');
      assert.equal(params.dataPropertyCreationFee, '2');
      assert.equal(params.enableDelegationFee, '3');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('rejects invalid parameters', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1230', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1231', 'cryptomancer', 'nft', 'updateParams', '{ "nftCreationFee": "0.5" , "dataPropertyCreationFee": "2", "enableDelegationFee": "3" }'));
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
      const res = await database1.findOne({
          contract: 'nft',
          table: 'params',
          query: {}
        });

      const params = res;
      console.log(params)

      assert.equal(params.nftCreationFee, '100');
      assert.equal(JSON.stringify(params.nftIssuanceFee), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","PAL":"0.001"}`);
      assert.equal(params.dataPropertyCreationFee, '100');
      assert.equal(params.enableDelegationFee, '1000');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('creates an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"10", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "orgName": "Mancer Inc", "productName": "My First Product", "symbol": "TEST", "authorizedIssuingAccounts": ["marc","aggroed","harpagon"], "authorizedIssuingContracts": ["tokens","dice"] }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;
      console.log(tokens)

      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(tokens[0].name, 'test NFT');
      assert.equal(tokens[0].orgName, '');
      assert.equal(tokens[0].productName, '');
      assert.equal(tokens[0].maxSupply, 1000);
      assert.equal(tokens[0].supply, 0);
      assert.equal(tokens[0].metadata, '{"url":"http://mynft.com"}');
      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer"]');
      assert.equal(tokens[0].circulatingSupply, 0);
      assert.equal(tokens[0].delegationEnabled, false);
      assert.equal(tokens[0].undelegationCooldown, 0);

      assert.equal(tokens[1].symbol, 'TEST');
      assert.equal(tokens[1].issuer, 'cryptomancer');
      assert.equal(tokens[1].name, 'test NFT 2');
      assert.equal(tokens[1].orgName, 'Mancer Inc');
      assert.equal(tokens[1].productName, 'My First Product');
      assert.equal(tokens[1].maxSupply, 0);
      assert.equal(tokens[1].supply, 0);
      assert.equal(tokens[1].metadata, '{"url":""}');
      assert.equal(JSON.stringify(tokens[1].authorizedIssuingAccounts), '["marc","aggroed","harpagon"]');
      assert.equal(JSON.stringify(tokens[1].authorizedIssuingContracts), '["tokens","dice"]');
      assert.equal(tokens[1].circulatingSupply, 0);
      assert.equal(tokens[1].delegationEnabled, false);
      assert.equal(tokens[1].undelegationCooldown, 0);

      res = await database1.findContract({
        name: 'nft',
      });

      let tables = res.tables;
      console.log(tables);
      
      assert.equal('nft_TSTNFTinstances' in tables, true);
      assert.equal('nft_TESTinstances' in tables, true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not allow nft creation with invalid parameters', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

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
      transactions.push(new Transaction(12345678901, 'TXID1242', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000", "authorizedIssuingAccounts": ["myaccountdup","myaccountdup"] }'));
      transactions.push(new Transaction(12345678901, 'TXID1243', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "cryptomancer", "quantity": "5", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1244', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1245', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT2", "symbol":"TSTNFTTWO", "productName": "tooooooloooooooooonnnnnnnnnnnggggggggggggggggggggggggggggggggggggggggggggggggggggggggg", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1246', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT2", "symbol":"TSTNFTTWO", "orgName": "tooooooloooooooooonnnnnnnnnnnggggggggggggggggggggggggggggggggggggggggggggggggggggggggg", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[4].logs)
      console.log(transactionsBlock1[6].logs)
      console.log(transactionsBlock1[7].logs)
      console.log(transactionsBlock1[8].logs)
      console.log(transactionsBlock1[9].logs)
      console.log(transactionsBlock1[10].logs)
      console.log(transactionsBlock1[11].logs)
      console.log(transactionsBlock1[12].logs)
      console.log(transactionsBlock1[14].logs)
      console.log(transactionsBlock1[15].logs)
      console.log(transactionsBlock1[16].logs)

      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'you must have enough tokens to cover the creation fees');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'invalid symbol: uppercase letters only, max length of 10');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'invalid name: letters, numbers, whitespaces only, max length of 50');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'maxSupply must be positive');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], `maxSupply must be lower than ${Number.MAX_SAFE_INTEGER}`);
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'cannot add the same account twice');
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'symbol already exists');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[0], 'invalid product name: letters, numbers, whitespaces only, max length of 50');
      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'invalid org name: letters, numbers, whitespaces only, max length of 50');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('enables delegation', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5", "enableDelegationFee": "55" }'));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"60", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;
      console.log(tokens)

      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(tokens[0].name, 'test NFT');
      assert.equal(tokens[0].maxSupply, 1000);
      assert.equal(tokens[0].supply, 0);
      assert.equal(tokens[0].metadata, '{"url":"http://mynft.com"}');
      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer"]');
      assert.equal(tokens[0].circulatingSupply, 0);
      assert.equal(tokens[0].delegationEnabled, true);
      assert.equal(tokens[0].undelegationCooldown, 5);

      res = await database1.find({
          contract: 'tokens',
          table: 'balances',
          query: { "account": { "$in" : ["cryptomancer","null"] }}
        });

      let balances = res;
      console.log(balances)

      // check fees were subtracted from account balance
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '0.00000000');
      assert.equal(balances[0].account, 'cryptomancer');
      assert.equal(balances[1].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[1].balance, '60.00000000');
      assert.equal(balances[1].account, 'null');
      assert.equal(balances.length, 2);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not enable delegation', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145385, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145385, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145385, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5", "enableDelegationFee": "56" }'));
      transactions.push(new Transaction(38145385, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"aggroed", "quantity":"56", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145385, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"60", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145385, 'TXID1235', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(38145385, 'TXID1236', 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(38145385, 'TXID1237', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"1", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145385, 'TXID1238', 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":false, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(38145385, 'TXID1239', 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(38145385, 'TXID1240', 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": "dsads" }'));
      transactions.push(new Transaction(38145385, 'TXID1241', 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"INVALID", "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(38145385, 'TXID1242', 'aggroed', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));

      let block = {
        refSteemBlockNumber: 38145385,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[6].logs)
      console.log(transactionsBlock1[8].logs)
      console.log(transactionsBlock1[9].logs)
      console.log(transactionsBlock1[10].logs)
      console.log(transactionsBlock1[11].logs)
      console.log(transactionsBlock1[12].logs)

      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'you must have enough tokens to cover fees');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'invalid symbol');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'undelegationCooldown must be an integer between 1 and 18250');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'must be the issuer');

      res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;
      console.log(tokens)

      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(tokens[0].name, 'test NFT');
      assert.equal(tokens[0].maxSupply, 1000);
      assert.equal(tokens[0].supply, 0);
      assert.equal(tokens[0].metadata, '{"url":"http://mynft.com"}');
      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer"]');
      assert.equal(tokens[0].circulatingSupply, 0);
      assert.equal(tokens[0].delegationEnabled, false);
      assert.equal(tokens[0].undelegationCooldown, 0);

      res = await database1.find({
          contract: 'tokens',
          table: 'balances',
          query: { "account": { "$in" : ["cryptomancer","null"] }}
        });

      let balances = res;
      console.log(balances)

      // check fees were subtracted from account balance
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '56.00000000');
      assert.equal(balances[0].account, 'cryptomancer');
      assert.equal(balances[1].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[1].balance, '5.00000000');
      assert.equal(balances[1].account, 'null');
      assert.equal(balances.length, 2);

      // test that delegation cannot be enabled twice
      transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1243', 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(38145386, 'TXID1244', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"56", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1245', 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));

      block = {
        refSteemBlockNumber: 38145386,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[0].logs)
      console.log(transactionsBlock2[1].logs)
      console.log(transactionsBlock2[2].logs)

      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'delegation already enabled');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('delegates and undelegates tokens', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      // fees: 2 ENG for NFT creation, 14 TKN (2 per token issued, total of 7 tokens)
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(38145386, 'TXID1234', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "1", "nftIssuanceFee": {"TKN":"1"}, "dataPropertyCreationFee": "1", "enableDelegationFee": "1" }'));
      transactions.push(new Transaction(38145386, 'TXID1235', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1236', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(38145386, 'TXID1237', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "200", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145386, 'TXID1238', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"3" }'));
      transactions.push(new Transaction(38145386, 'TXID1239', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST" }'));
      transactions.push(new Transaction(38145386, 'TXID1240', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145386, 'TXID1241', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145386, 'TXID1242', 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(38145386, 'TXID1243', 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(38145386, 'TXID1244', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5","TKN":"0.25"}, "properties": {"color":"white"} }`));
      transactions.push(new Transaction(38145386, 'TXID1245', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10","TKN":"0.5"}, "properties": {"color":"orange"} }`));
      transactions.push(new Transaction(38145386, 'TXID1246', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15","TKN":"0.75"}, "properties": {"color":"black"} }`));
      transactions.push(new Transaction(38145386, 'TXID1247', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","TKN":"0.001"}, "properties": {"color":"red"} }`));
      transactions.push(new Transaction(38145386, 'TXID1248', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.002","TKN":"0.01"}, "properties": {"color":"green"} }`));
      transactions.push(new Transaction(38145386, 'TXID1249', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.1"}, "properties": {"color":"blue"} }`));
      transactions.push(new Transaction(38145386, 'TXID1250', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "properties": {"color":"purple"} }`));

      // do some delegations
      // user -> user
      transactions.push(new Transaction(38145386, 'TXID1251', 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      // contract -> contract
      transactions.push(new Transaction(38145386, 'TXID1252', 'marc', 'testcontract', 'doDelegation', '{ "isSignedWithActiveKey": true, "fromType":"contract", "to":"contract2", "toType":"contract", "nfts": [ {"symbol":"TEST", "ids":["2","2","2","2","3","3","2","2"]} ] }'));
      // contract -> user
      transactions.push(new Transaction(38145386, 'TXID1253', 'marc', 'testcontract', 'doDelegation', '{ "isSignedWithActiveKey": true, "fromType":"contract", "to":"harpagon", "toType":"user", "nfts": [ {"symbol":"TEST", "ids":["4"]} ] }'));
      // user -> contract
      transactions.push(new Transaction(38145386, 'TXID1254', 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"testcontract", "toType":"contract", "nfts": [ {"symbol":"TSTNFT", "ids":["3"]}, {"symbol":"INVALID", "ids":["1","1","1"]} ] }'));

      // should not be able to delegate twice
      transactions.push(new Transaction(38145386, 'TXID1255', 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"marc", "nfts": [ {"symbol":"TSTNFT", "ids":["3"]}, {"symbol":"INVALID", "ids":["1","1","1"]} ] }'));

      // now start some undelegations
      transactions.push(new Transaction(38145386, 'TXID1256', 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["3"]}, {"symbol":"TEST", "ids":["1","1","1"]}, {"symbol":"INVALID", "ids":["1","1","1"]} ] }'));
      transactions.push(new Transaction(38145386, 'TXID1257', 'marc', 'testcontract', 'doUndelegation', '{ "isSignedWithActiveKey": true, "fromType":"contract", "nfts": [ {"symbol":"TSTNFT", "ids":["300","301"]}, {"symbol":"TEST", "ids":["2","3","4"]} ] }'));

      let block = {
        refSteemBlockNumber: 38145386,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[21].logs);
      console.log(transactionsBlock1[22].logs);
      console.log(transactionsBlock1[23].logs);
      console.log(transactionsBlock1[24].logs);
      console.log(transactionsBlock1[25].logs);
      console.log(transactionsBlock1[26].logs);
      console.log(transactionsBlock1[27].logs);

      res = await database1.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;
      console.log(instances);

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'testcontract');
      assert.equal(instances[0].ownedBy, 'c');
      assert.equal(instances[0].delegatedTo, undefined);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'aggroed');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].delegatedTo), '{"account":"cryptomancer","ownedBy":"u"}');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'aggroed');
      assert.equal(instances[2].ownedBy, 'u');
      assert.equal(instances[2].delegatedTo.account, 'testcontract');
      assert.equal(instances[2].delegatedTo.ownedBy, 'c');
      assert.equal(instances[2].delegatedTo.undelegateAt > 0, true);

      res = await database1.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;
      console.log(instances);

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(instances[0].delegatedTo.account, 'cryptomancer');
      assert.equal(instances[0].delegatedTo.ownedBy, 'u');
      assert.equal(instances[0].delegatedTo.undelegateAt > 0, true);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'testcontract');
      assert.equal(instances[1].ownedBy, 'c');
      assert.equal(instances[1].delegatedTo.account, 'contract2');
      assert.equal(instances[1].delegatedTo.ownedBy, 'c');
      assert.equal(instances[1].delegatedTo.undelegateAt > 0, true);
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'testcontract');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(instances[2].delegatedTo.account, 'contract2');
      assert.equal(instances[2].delegatedTo.ownedBy, 'c');
      assert.equal(instances[2].delegatedTo.undelegateAt > 0, true);
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'testcontract');
      assert.equal(instances[3].ownedBy, 'c');
      assert.equal(instances[3].delegatedTo.account, 'harpagon');
      assert.equal(instances[3].delegatedTo.ownedBy, 'u');
      assert.equal(instances[3].delegatedTo.undelegateAt > 0, true);

      res = await database1.find({
          contract: 'nft',
          table: 'pendingUndelegations',
          query: {}
        });

      let undelegations = res;
      console.log(undelegations);

      assert.equal(undelegations.length, 3);
      assert.equal(undelegations[0].symbol, 'TSTNFT');
      assert.equal(JSON.stringify(undelegations[0].ids), '[3]');
      assert.equal(undelegations[0].completeTimestamp > 0, true);
      assert.equal(undelegations[1].symbol, 'TEST');
      assert.equal(JSON.stringify(undelegations[1].ids), '[1]');
      assert.equal(undelegations[1].completeTimestamp > 0, true);
      assert.equal(undelegations[2].symbol, 'TEST');
      assert.equal(JSON.stringify(undelegations[2].ids), '[2,3,4]');
      assert.equal(undelegations[2].completeTimestamp > 0, true);

      transactions = [];
      // send whatever transaction, just need to generate a new block
      // so we can check that pending undelegations are processed
      transactions.push(new Transaction(38145387, 'TXID123810', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 38145387,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-04T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.find({
          contract: 'nft',
          table: 'pendingUndelegations',
          query: {}
        });

      // undelegations should still be pending as 5 days haven't passed yet
      undelegations = res;
      assert.equal(undelegations.length, 3);

      transactions = [];
      // send whatever transaction, just need to generate a new block
      // so we can check that pending undelegations are processed
      transactions.push(new Transaction(38145388, 'TXID123811', 'harpagon', 'whatever2', 'whatever2', ''));

      block = {
        refSteemBlockNumber: 38145388,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-06T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.find({
          contract: 'nft',
          table: 'pendingUndelegations',
          query: {}
        });

      // undelegations should be finished now
      undelegations = res;
      console.log(undelegations);
      assert.equal(undelegations.length, 0);

      res = await database1.getBlockInfo(3);

      let vtxs = res.virtualTransactions;
      const logs = JSON.parse(vtxs[0].logs);
      console.log(logs);
      console.log(logs.events[0].data);
      console.log(logs.events[1].data);
      console.log(logs.events[2].data);

      assert.equal(logs.events[0].contract, 'nft');
      assert.equal(logs.events[0].event, 'undelegateDone');
      assert.equal(logs.events[0].data.symbol, 'TSTNFT');
      assert.equal(JSON.stringify(logs.events[0].data.ids), '[3]');
      assert.equal(logs.events[1].contract, 'nft');
      assert.equal(logs.events[1].event, 'undelegateDone');
      assert.equal(logs.events[1].data.symbol, 'TEST');
      assert.equal(JSON.stringify(logs.events[1].data.ids), '[1]');
      assert.equal(logs.events[2].contract, 'nft');
      assert.equal(logs.events[2].event, 'undelegateDone');
      assert.equal(logs.events[2].data.symbol, 'TEST');
      assert.equal(JSON.stringify(logs.events[2].data.ids), '[2,3,4]');

      res = await database1.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      instances = res;
      console.log(instances);

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'testcontract');
      assert.equal(instances[0].ownedBy, 'c');
      assert.equal(instances[0].delegatedTo, undefined);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'aggroed');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].delegatedTo), '{"account":"cryptomancer","ownedBy":"u"}');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'aggroed');
      assert.equal(instances[2].ownedBy, 'u');
      assert.equal(instances[2].delegatedTo, undefined);      

      res = await database1.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;
      console.log(instances);

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(instances[0].delegatedTo, undefined);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'testcontract');
      assert.equal(instances[1].ownedBy, 'c');
      assert.equal(instances[1].delegatedTo, undefined);
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'testcontract');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(instances[2].delegatedTo, undefined);
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'testcontract');
      assert.equal(instances[3].ownedBy, 'c');
      assert.equal(instances[3].delegatedTo, undefined);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not undelegate tokens', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      // fees: 2 ENG for NFT creation, 14 TKN (2 per token issued, total of 7 tokens)
      transactions.push(new Transaction(38145388, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145388, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145388, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(38145388, 'TXID1233', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(38145388, 'TXID1234', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "1", "nftIssuanceFee": {"TKN":"1"}, "dataPropertyCreationFee": "1", "enableDelegationFee": "1" }'));
      transactions.push(new Transaction(38145388, 'TXID1235', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145388, 'TXID1236', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(38145388, 'TXID1237', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "200", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145388, 'TXID1238', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"3" }'));
      transactions.push(new Transaction(38145388, 'TXID1239', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST" }'));
      transactions.push(new Transaction(38145388, 'TXID1240', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 3", "symbol": "TESTER" }'));
      transactions.push(new Transaction(38145388, 'TXID1241', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145388, 'TXID1242', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145388, 'TXID1243', 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(38145388, 'TXID1244', 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "undelegationCooldown": 5 }'));
      transactions.push(new Transaction(38145388, 'TXID1245', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5","TKN":"0.25"}, "properties": {"color":"white"} }`));
      transactions.push(new Transaction(38145388, 'TXID1246', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10","TKN":"0.5"}, "properties": {"color":"orange"} }`));
      transactions.push(new Transaction(38145388, 'TXID1247', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15","TKN":"0.75"}, "properties": {"color":"black"} }`));
      transactions.push(new Transaction(38145388, 'TXID1248', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","TKN":"0.001"}, "properties": {"color":"red"} }`));
      transactions.push(new Transaction(38145388, 'TXID1249', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.002","TKN":"0.01"}, "properties": {"color":"green"} }`));
      transactions.push(new Transaction(38145388, 'TXID1250', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.1"}, "properties": {"color":"blue"} }`));
      transactions.push(new Transaction(38145388, 'TXID1251', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "properties": {"color":"purple"} }`));

      // do some delegations
      // user -> user
      transactions.push(new Transaction(38145388, 'TXID1252', 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      // contract -> contract
      transactions.push(new Transaction(38145388, 'TXID1253', 'marc', 'testcontract', 'doDelegation', '{ "isSignedWithActiveKey": true, "fromType":"contract", "to":"contract2", "toType":"contract", "nfts": [ {"symbol":"TEST", "ids":["2","2","2","2","3","3","2","2"]} ] }'));
      // contract -> user
      transactions.push(new Transaction(38145388, 'TXID1254', 'marc', 'testcontract', 'doDelegation', '{ "isSignedWithActiveKey": true, "fromType":"contract", "to":"harpagon", "toType":"user", "nfts": [ {"symbol":"TEST", "ids":["4"]} ] }'));
      // user -> contract
      transactions.push(new Transaction(38145388, 'TXID1255', 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"testcontract", "toType":"contract", "nfts": [ {"symbol":"TSTNFT", "ids":["3"]}, {"symbol":"INVALID", "ids":["1","1","1"]} ] }'));

      // validation errors
      transactions.push(new Transaction(38145388, 'TXID1256', 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TESTER", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145388, 'TXID1257', 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": false, "nfts": [ {"symbol":"TSTNFT", "ids":["2"]} ] }'));
      transactions.push(new Transaction(38145388, 'TXID1258', 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": true, "fromType":"contract", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]} ] }'));
      transactions.push(new Transaction(38145388, 'TXID1259', 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT"} ] }'));
      
      // is not the token owner
      transactions.push(new Transaction(38145388, 'TXID1260', 'marc', 'testcontract', 'doUndelegation', '{ "isSignedWithActiveKey": true, "fromType":"contract", "nfts": [ {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145388, 'TXID1261', 'aggroed', 'testcontract', 'doUndelegation', '{ "isSignedWithActiveKey": true, "fromType":"contract", "nfts": [ {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145388, 'TXID1262', 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TEST", "ids":["2"]} ] }'));

      // symbol does not exist
      transactions.push(new Transaction(38145388, 'TXID1263', 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"INVALID", "ids":["2"]} ] }'));

      // instances do not exist
      transactions.push(new Transaction(38145388, 'TXID1264', 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["200","201","202"]} ] }'));

      // instance is not being delegated
      transactions.push(new Transaction(38145388, 'TXID1265', 'marc', 'testcontract', 'doUndelegation', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["1"]} ] }'));

      let block = {
        refSteemBlockNumber: 38145388,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[26].logs);
      console.log(transactionsBlock1[27].logs);
      console.log(transactionsBlock1[28].logs);
      console.log(transactionsBlock1[29].logs);
      console.log(transactionsBlock1[30].logs);
      console.log(transactionsBlock1[31].logs);
      console.log(transactionsBlock1[32].logs);
      console.log(transactionsBlock1[33].logs);
      console.log(transactionsBlock1[34].logs);
      console.log(transactionsBlock1[35].logs);

      assert.equal(JSON.parse(transactionsBlock1[26].logs).errors[0], 'delegation not enabled for TESTER');
      assert.equal(JSON.parse(transactionsBlock1[27].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[28].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[29].logs).errors[0], 'invalid nft list');

      res = await database1.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'testcontract');
      assert.equal(instances[0].ownedBy, 'c');
      assert.equal(instances[0].delegatedTo, undefined);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'aggroed');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].delegatedTo), '{"account":"cryptomancer","ownedBy":"u"}');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'aggroed');
      assert.equal(instances[2].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[2].delegatedTo), '{"account":"testcontract","ownedBy":"c"}');

      res = await database1.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[0].delegatedTo), '{"account":"cryptomancer","ownedBy":"u"}');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'testcontract');
      assert.equal(instances[1].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[1].delegatedTo), '{"account":"contract2","ownedBy":"c"}');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'testcontract');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[2].delegatedTo), '{"account":"contract2","ownedBy":"c"}');
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'testcontract');
      assert.equal(instances[3].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[3].delegatedTo), '{"account":"harpagon","ownedBy":"u"}');

      res = await database1.find({
          contract: 'nft',
          table: 'pendingUndelegations',
          query: {}
        });

      let undelegations = res;

      assert.equal(undelegations.length, 0);

      // ensure we cannot undelegate something twice
      transactions = [];
      transactions.push(new Transaction(38145389, 'TXID1266', 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145389, 'TXID1267', 'aggroed', 'nft', 'undelegate', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TEST", "ids":["1"]} ] }'));

      block = {
        refSteemBlockNumber: 38145389,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[0].logs);
      console.log(transactionsBlock2[1].logs);

      res = await database1.find({
          contract: 'nft',
          table: 'pendingUndelegations',
          query: {}
        });

      undelegations = res;
      console.log(undelegations);

      assert.equal(undelegations[0].symbol, 'TEST');
      assert.equal(JSON.stringify(undelegations[0].ids), '[1]');
      assert.equal(undelegations[0].completeTimestamp > 0, true);
      assert.equal(undelegations.length, 1);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not delegate tokens', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      // fees: 2 ENG for NFT creation, 14 TKN (2 per token issued, total of 7 tokens)
      transactions.push(new Transaction(38145389, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145389, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145389, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(38145389, 'TXID1233', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(38145389, 'TXID1234', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "1", "nftIssuanceFee": {"TKN":"1"}, "dataPropertyCreationFee": "1", "enableDelegationFee": "1" }'));
      transactions.push(new Transaction(38145389, 'TXID1235', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145389, 'TXID1236', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(38145389, 'TXID1237', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "200", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145389, 'TXID1238', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"3" }'));
      transactions.push(new Transaction(38145389, 'TXID1239', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST" }'));
      transactions.push(new Transaction(38145389, 'TXID1240', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145389, 'TXID1241', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145389, 'TXID1242', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5","TKN":"0.25"}, "properties": {"color":"white"} }`));
      transactions.push(new Transaction(38145389, 'TXID1243', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10","TKN":"0.5"}, "properties": {"color":"orange"} }`));
      transactions.push(new Transaction(38145389, 'TXID1244', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15","TKN":"0.75"}, "properties": {"color":"black"} }`));
      transactions.push(new Transaction(38145389, 'TXID1245', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","TKN":"0.001"}, "properties": {"color":"red"} }`));
      transactions.push(new Transaction(38145389, 'TXID1246', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.002","TKN":"0.01"}, "properties": {"color":"green"} }`));
      transactions.push(new Transaction(38145389, 'TXID1247', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.1"}, "properties": {"color":"blue"} }`));
      transactions.push(new Transaction(38145389, 'TXID1248', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "properties": {"color":"purple"} }`));
      transactions.push(new Transaction(38145389, 'TXID1249', 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "undelegationCooldown": 5 }'));
      
      // symbol not enabled for delegation
      transactions.push(new Transaction(38145389, 'TXID1250', 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145389, 'TXID1251', 'cryptomancer', 'nft', 'enableDelegation', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "undelegationCooldown": 5 }'));

      // validation errors
      transactions.push(new Transaction(38145389, 'TXID1252', 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": false, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145389, 'TXID1253', 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "fromType":"contract", "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145389, 'TXID1254', 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"reeeeaaalllllllyyyyyyylllllllloooooooooonnnnnnnngggggggg", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145389, 'TXID1255', 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":" Aggroed ", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145389, 'TXID1256', 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"null", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145389, 'TXID1257', 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["-345"]}, {"symbol":"TEST", "ids":["1"]} ] }'));

      // is not the token owner
      transactions.push(new Transaction(38145389, 'TXID1258', 'harpagon', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145389, 'TXID1259', 'testcontract', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["1"]} ] }'));
      // symbol does not exist
      transactions.push(new Transaction(38145389, 'TXID1260', 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"INVALID", "ids":["2"]} ] }'));
      // instances do not exist
      transactions.push(new Transaction(38145389, 'TXID1261', 'aggroed', 'nft', 'delegate', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["200","201","202"]} ] }'));

      let block = {
        refSteemBlockNumber: 38145389,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[20].logs);
      console.log(transactionsBlock1[22].logs);
      console.log(transactionsBlock1[23].logs);
      console.log(transactionsBlock1[24].logs);
      console.log(transactionsBlock1[25].logs);
      console.log(transactionsBlock1[26].logs);
      console.log(transactionsBlock1[27].logs);
      console.log(transactionsBlock1[28].logs);
      console.log(transactionsBlock1[29].logs);
      console.log(transactionsBlock1[30].logs);
      console.log(transactionsBlock1[31].logs);

      assert.equal(JSON.parse(transactionsBlock1[20].logs).errors[0], 'delegation not enabled for TEST');
      assert.equal(JSON.parse(transactionsBlock1[22].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[23].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[24].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[25].logs).errors[0], 'cannot delegate to self');
      assert.equal(JSON.parse(transactionsBlock1[26].logs).errors[0], 'cannot delegate to null');
      assert.equal(JSON.parse(transactionsBlock1[27].logs).errors[0], 'invalid nft list');

      res = await database1.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;
      console.log(instances);

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'testcontract');
      assert.equal(instances[0].ownedBy, 'c');
      assert.equal(instances[0].delegatedTo, undefined);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'aggroed');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(instances[1].delegatedTo, undefined);
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'aggroed');
      assert.equal(instances[2].ownedBy, 'u');
      assert.equal(instances[2].delegatedTo, undefined);

      res = await database1.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;
      console.log(instances);

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(instances[0].delegatedTo, undefined);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'testcontract');
      assert.equal(instances[1].ownedBy, 'c');
      assert.equal(instances[1].delegatedTo, undefined);
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'testcontract');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(instances[2].delegatedTo, undefined);
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'testcontract');
      assert.equal(instances[3].ownedBy, 'c');
      assert.equal(instances[3].delegatedTo, undefined);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('transfers tokens', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      // fees: 2 ENG for NFT creation, 14 TKN (2 per token issued, total of 7 tokens)
      transactions.push(new Transaction(38145389, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145389, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145389, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(38145389, 'TXID1233', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(38145389, 'TXID1234', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "1", "nftIssuanceFee": {"TKN":"1"}, "dataPropertyCreationFee": "1" }'));
      transactions.push(new Transaction(38145389, 'TXID1235', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145389, 'TXID1236', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(38145389, 'TXID1237', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "200", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145389, 'TXID1238', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"3" }'));
      transactions.push(new Transaction(38145389, 'TXID1239', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST" }'));
      transactions.push(new Transaction(38145389, 'TXID1240', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145389, 'TXID1241', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145389, 'TXID1242', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5","TKN":"0.25"}, "properties": {"color":"white"} }`));
      transactions.push(new Transaction(38145389, 'TXID1243', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10","TKN":"0.5"}, "properties": {"color":"orange"} }`));
      transactions.push(new Transaction(38145389, 'TXID1244', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15","TKN":"0.75"}, "properties": {"color":"black"} }`));
      transactions.push(new Transaction(38145389, 'TXID1245', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","TKN":"0.001"}, "properties": {"color":"red"} }`));
      transactions.push(new Transaction(38145389, 'TXID1246', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.002","TKN":"0.01"}, "properties": {"color":"green"} }`));
      transactions.push(new Transaction(38145389, 'TXID1247', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.1"}, "properties": {"color":"blue"} }`));
      transactions.push(new Transaction(38145389, 'TXID1248', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "properties": {"color":"purple"} }`));

      // the actual transfers
      // user -> user
      transactions.push(new Transaction(38145389, 'TXID1249', 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      // contract -> contract
      transactions.push(new Transaction(38145389, 'TXID1250', 'marc', 'testcontract', 'doTransfer', '{ "isSignedWithActiveKey": true, "fromType":"contract", "to":"contract2", "toType":"contract", "nfts": [ {"symbol":"TEST", "ids":["2","2","2","2","3","3","2","2"]} ] }'));
      // contract -> user
      transactions.push(new Transaction(38145389, 'TXID1251', 'marc', 'testcontract', 'doTransfer', '{ "isSignedWithActiveKey": true, "fromType":"contract", "to":"harpagon", "toType":"user", "nfts": [ {"symbol":"TEST", "ids":["4"]} ] }'));
      // user -> contract
      transactions.push(new Transaction(38145389, 'TXID1252', 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":"testcontract", "toType":"contract", "nfts": [ {"symbol":"TSTNFT", "ids":["3"]}, {"symbol":"INVALID", "ids":["1","1","1"]} ] }'));

      let block = {
        refSteemBlockNumber: 38145389,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[19].logs);
      console.log(transactionsBlock1[20].logs);
      console.log(transactionsBlock1[21].logs);
      console.log(transactionsBlock1[22].logs);

      res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;

      // check NFT supply updates OK
      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].maxSupply, 3);
      assert.equal(tokens[0].supply, 3);
      assert.equal(tokens[0].circulatingSupply, 3);

      assert.equal(tokens[1].symbol, 'TEST');
      assert.equal(tokens[1].maxSupply, 0);
      assert.equal(tokens[1].supply, 4);
      assert.equal(tokens[1].circulatingSupply, 4);

      res = await database1.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;
      console.log(instances);

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'testcontract');
      assert.equal(instances[0].ownedBy, 'c');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'cryptomancer');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'testcontract');
      assert.equal(instances[2].ownedBy, 'c');

      res = await database1.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;
      console.log(instances);

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'cryptomancer');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'contract2');
      assert.equal(instances[1].ownedBy, 'c');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'contract2');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'harpagon');
      assert.equal(instances[3].ownedBy, 'u');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not transfer tokens', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      // fees: 2 ENG for NFT creation, 14 TKN (2 per token issued, total of 7 tokens)
      transactions.push(new Transaction(38145389, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145389, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145389, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(38145389, 'TXID1233', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(38145389, 'TXID1234', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "1", "nftIssuanceFee": {"TKN":"1"}, "dataPropertyCreationFee": "1" }'));
      transactions.push(new Transaction(38145389, 'TXID1235', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145389, 'TXID1236', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(38145389, 'TXID1237', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "200", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145389, 'TXID1238', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"3" }'));
      transactions.push(new Transaction(38145389, 'TXID1239', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST" }'));
      transactions.push(new Transaction(38145389, 'TXID1240', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145389, 'TXID1241', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145389, 'TXID1242', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5","TKN":"0.25"}, "properties": {"color":"white"} }`));
      transactions.push(new Transaction(38145389, 'TXID1243', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10","TKN":"0.5"}, "properties": {"color":"orange"} }`));
      transactions.push(new Transaction(38145389, 'TXID1244', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15","TKN":"0.75"}, "properties": {"color":"black"} }`));
      transactions.push(new Transaction(38145389, 'TXID1245', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","TKN":"0.001"}, "properties": {"color":"red"} }`));
      transactions.push(new Transaction(38145389, 'TXID1246', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.002","TKN":"0.01"}, "properties": {"color":"green"} }`));
      transactions.push(new Transaction(38145389, 'TXID1247', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.1"}, "properties": {"color":"blue"} }`));
      transactions.push(new Transaction(38145389, 'TXID1248', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "properties": {"color":"purple"} }`));

      // validation errors
      transactions.push(new Transaction(38145389, 'TXID1249', 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": false, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145389, 'TXID1250', 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "fromType":"contract", "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145389, 'TXID1251', 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":"reeeeaaalllllllyyyyyyylllllllloooooooooonnnnnnnngggggggg", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145389, 'TXID1252', 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":" Aggroed ", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145389, 'TXID1253', 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":"null", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145389, 'TXID1254', 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["-345"]}, {"symbol":"TEST", "ids":["1"]} ] }'));

      // is not the token owner
      transactions.push(new Transaction(38145389, 'TXID1255', 'harpagon', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["2"]}, {"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145389, 'TXID1256', 'testcontract', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["1"]} ] }'));
      // symbol does not exist
      transactions.push(new Transaction(38145389, 'TXID1257', 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"INVALID", "ids":["2"]} ] }'));
      // instances do not exist
      transactions.push(new Transaction(38145389, 'TXID1258', 'aggroed', 'nft', 'transfer', '{ "isSignedWithActiveKey": true, "to":"cryptomancer", "nfts": [ {"symbol":"TSTNFT", "ids":["200","201","202"]} ] }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[19].logs);
      console.log(transactionsBlock1[20].logs);
      console.log(transactionsBlock1[21].logs);
      console.log(transactionsBlock1[22].logs);
      console.log(transactionsBlock1[23].logs);
      console.log(transactionsBlock1[24].logs);
      console.log(transactionsBlock1[25].logs);
      console.log(transactionsBlock1[26].logs);
      console.log(transactionsBlock1[27].logs);
      console.log(transactionsBlock1[28].logs);

      assert.equal(JSON.parse(transactionsBlock1[19].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[20].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[21].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[22].logs).errors[0], 'cannot transfer to self');
      assert.equal(JSON.parse(transactionsBlock1[23].logs).errors[0], 'cannot transfer to null; use burn action instead');
      assert.equal(JSON.parse(transactionsBlock1[24].logs).errors[0], 'invalid nft list');

      res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;

      // check NFT supply updates OK
      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].maxSupply, 3);
      assert.equal(tokens[0].supply, 3);
      assert.equal(tokens[0].circulatingSupply, 3);

      assert.equal(tokens[1].symbol, 'TEST');
      assert.equal(tokens[1].maxSupply, 0);
      assert.equal(tokens[1].supply, 4);
      assert.equal(tokens[1].circulatingSupply, 4);

      res = await database1.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'testcontract');
      assert.equal(instances[0].ownedBy, 'c');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'aggroed');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'aggroed');
      assert.equal(instances[2].ownedBy, 'u');

      res = await database1.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'testcontract');
      assert.equal(instances[1].ownedBy, 'c');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'testcontract');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'testcontract');
      assert.equal(instances[3].ownedBy, 'c');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('burns tokens', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      // fees: 2 ENG for NFT creation, 14 TKN (2 per token issued, total of 7 tokens)
      transactions.push(new Transaction(38145389, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145389, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145389, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(38145389, 'TXID1233', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(38145389, 'TXID1234', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "1", "nftIssuanceFee": {"TKN":"1"}, "dataPropertyCreationFee": "1" }'));
      transactions.push(new Transaction(38145389, 'TXID1235', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145389, 'TXID1236', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(38145389, 'TXID1237', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "200", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145389, 'TXID1238', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"3" }'));
      transactions.push(new Transaction(38145389, 'TXID1239', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST" }'));
      transactions.push(new Transaction(38145389, 'TXID1240', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145389, 'TXID1241', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145389, 'TXID1242', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5","TKN":"0.25"}, "properties": {"color":"white"} }`));
      transactions.push(new Transaction(38145389, 'TXID1243', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10","TKN":"0.5"}, "properties": {"color":"orange"} }`));
      transactions.push(new Transaction(38145389, 'TXID1244', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15","TKN":"0.75"}, "properties": {"color":"black"} }`));
      transactions.push(new Transaction(38145389, 'TXID1245', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","TKN":"0.001"}, "properties": {"color":"red"} }`));
      transactions.push(new Transaction(38145389, 'TXID1246', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.002","TKN":"0.01"}, "properties": {"color":"green"} }`));
      transactions.push(new Transaction(38145389, 'TXID1247', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.1"}, "properties": {"color":"blue"} }`));
      transactions.push(new Transaction(38145389, 'TXID1248', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "properties": {"color":"purple"} }`));

      let block = {
        refSteemBlockNumber: 38145389,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;

      // check NFT supply updates OK
      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].maxSupply, 3);
      assert.equal(tokens[0].supply, 3);
      assert.equal(tokens[0].circulatingSupply, 3);

      assert.equal(tokens[1].symbol, 'TEST');
      assert.equal(tokens[1].maxSupply, 0);
      assert.equal(tokens[1].supply, 4);
      assert.equal(tokens[1].circulatingSupply, 4);

      res = await database1.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'testcontract');
      assert.equal(instances[0].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[0].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5","TKN":"0.25"}`);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'aggroed');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10","TKN":"0.5"}`);
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'aggroed');
      assert.equal(instances[2].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[2].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15","TKN":"0.75"}`);

      res = await database1.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[0].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","TKN":"0.001"}`);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'testcontract');
      assert.equal(instances[1].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[1].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.002","TKN":"0.01"}`);
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'testcontract');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[2].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.1"}`);
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'testcontract');
      assert.equal(instances[3].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[3].lockedTokens), '{}');

      res = await database1.find({
          contract: 'tokens',
          table: 'balances',
          query: { "account": { "$in" : ["cryptomancer","aggroed"] }}
        });

      let balances = res;

      // check issuance fees & locked tokens were subtracted from account balance
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '167.89700000');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, '184.389');
      assert.equal(balances.length, 2);

      res = await database1.find({
          contract: 'tokens',
          table: 'contractsBalances',
          query: {}
        });

      balances = res;

      // check nft contract has the proper amount of locked tokens
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '30.10300000');
      assert.equal(balances[0].account, 'nft');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, '1.611');
      assert.equal(balances[1].account, 'nft');
      assert.equal(balances.length, 2);

      // now burn the tokens
      transactions = [];
      transactions.push(new Transaction(38145390, 'TXID1249', 'aggroed', 'nft', 'burn', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["1","2","3"]},{"symbol":"TSTNFT", "ids":["2","3"]},{"symbol":"TEST", "ids":["1"]} ] }'));
      // here we try to spoof the calling contract name (which shouldn't be possible, it should just be ignored and reset to the correct name, in this case testcontract)
      transactions.push(new Transaction(38145390, 'TXID1250', 'marc', 'testcontract', 'doBurn', '{ "callingContractInfo": {"name":"otherContract", "version":1}, "fromType":"contract", "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":[]},{"symbol":"TSTNFT", "ids":["1","1","1","1"]},{"symbol":"TEST", "ids":["2","3","4","5","6","7","8","9","10"]} ] }'));

      block = {
        refSteemBlockNumber: 38145390,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[0].logs);
      console.log(transactionsBlock2[1].logs);

      res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      tokens = res;
      console.log(tokens);

      // check NFT supply updates OK
      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].maxSupply, 3);
      assert.equal(tokens[0].supply, 3);
      assert.equal(tokens[0].circulatingSupply, 0);

      assert.equal(tokens[1].symbol, 'TEST');
      assert.equal(tokens[1].maxSupply, 0);
      assert.equal(tokens[1].supply, 4);
      assert.equal(tokens[1].circulatingSupply, 0);

      res = await database1.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      instances = res;
      console.log(instances);

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'null');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[0].lockedTokens), '{}');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'null');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].lockedTokens), '{}');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'null');
      assert.equal(instances[2].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[2].lockedTokens), '{}');

      res = await database1.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;
      console.log(instances);

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'null');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[0].lockedTokens), '{}');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'null');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].lockedTokens), '{}');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'null');
      assert.equal(instances[2].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[2].lockedTokens), '{}');
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'null');
      assert.equal(instances[3].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[3].lockedTokens), '{}');

      res = await database1.find({
          contract: 'tokens',
          table: 'balances',
          query: { "account": { "$in" : ["cryptomancer","aggroed"] }}
        });

      balances = res;
      console.log(balances);

      // check issuance fees & locked tokens were subtracted from account balance
      assert.equal(balances[0].account, 'aggroed');
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '25.00100000');
      assert.equal(balances[1].account, 'aggroed');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, '1.251');
      assert.equal(balances[2].account, 'cryptomancer');
      assert.equal(balances[2].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[2].balance, '167.89700000');
      assert.equal(balances[3].account, 'cryptomancer');
      assert.equal(balances[3].symbol, 'TKN');
      assert.equal(balances[3].balance, '184.389');
      assert.equal(balances.length, 4);

      res = await database1.find({
          contract: 'tokens',
          table: 'contractsBalances',
          query: {}
        });

      balances = res;
      console.log(balances);

      // check nft contract has the proper amount of locked tokens
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '0.00000000');
      assert.equal(balances[0].account, 'nft');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, '0.000');
      assert.equal(balances[1].account, 'nft');
      assert.equal(balances[2].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[2].balance, '5.10200000');
      assert.equal(balances[2].account, 'testcontract');
      assert.equal(balances[3].symbol, 'TKN');
      assert.equal(balances[3].balance, '0.360');
      assert.equal(balances[3].account, 'testcontract');

      assert.equal(balances.length, 4);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not burn tokens', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      // fees: 2 ENG for NFT creation, 14 TKN (2 per token issued, total of 7 tokens)
      transactions.push(new Transaction(38145390, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145390, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145390, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(38145390, 'TXID1233', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(38145390, 'TXID1234', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "1", "nftIssuanceFee": {"TKN":"1"}, "dataPropertyCreationFee": "1" }'));
      transactions.push(new Transaction(38145390, 'TXID1235', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145390, 'TXID1236', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(38145390, 'TXID1237', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "200", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145390, 'TXID1238', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"3" }'));
      transactions.push(new Transaction(38145390, 'TXID1239', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST" }'));
      transactions.push(new Transaction(38145390, 'TXID1240', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145390, 'TXID1241', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145390, 'TXID1242', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5","TKN":"0.25"}, "properties": {"color":"white"} }`));
      transactions.push(new Transaction(38145390, 'TXID1243', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10","TKN":"0.5"}, "properties": {"color":"orange"} }`));
      transactions.push(new Transaction(38145390, 'TXID1244', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15","TKN":"0.75"}, "properties": {"color":"black"} }`));
      transactions.push(new Transaction(38145390, 'TXID1245', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "toType":"user", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","TKN":"0.001"}, "properties": {"color":"red"} }`));
      transactions.push(new Transaction(38145390, 'TXID1246', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.002","TKN":"0.01"}, "properties": {"color":"green"} }`));
      transactions.push(new Transaction(38145390, 'TXID1247', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.1"}, "properties": {"color":"blue"} }`));
      transactions.push(new Transaction(38145390, 'TXID1248', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"testcontract", "toType":"contract", "feeSymbol": "TKN", "properties": {"color":"purple"} }`));

      let block = {
        refSteemBlockNumber: 38145390,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(38145391, 'TXID1249', 'aggroed', 'nft', 'burn', '{ "isSignedWithActiveKey": false, "nfts": [ {"symbol":"TSTNFT", "ids":["2","3"]},{"symbol":"TSTNFT", "ids":["2","3"]},{"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1250', 'marc', 'testcontract', 'doBurn', '{ "fromType":"contract", "isSignedWithActiveKey": true, "nfts": {"bad":"format"} }'));
      transactions.push(new Transaction(38145391, 'TXID1251', 'marc', 'testcontract', 'doBurn', '{ "fromType":"contract", "isSignedWithActiveKey": true, "nfts": [] }'));
      transactions.push(new Transaction(38145391, 'TXID1252', 'aggroed', 'nft', 'burn', '{ "fromType":"contract", "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["2","3"]},{"symbol":"TSTNFT", "ids":["2","3"]},{"symbol":"TEST", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1253', 'marc', 'testcontract', 'doBurn', '{ "fromType":"contract", "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":[]},{"symbol":"TSTNFT", "ids":["1","1","1","1"]},{"symbol":"TEST", "ids":["a","b","c"] } ] }'));
      transactions.push(new Transaction(38145391, 'TXID1254', 'marc', 'testcontract', 'doBurn', '{ "fromType":"contract", "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":[]},{"symbol":"TSTNFT", "ids":["1","1","1","1"]},{"symbol":"TEST"} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1255', 'aggroed', 'nft', 'burn', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["1","2","3","4","5","6","7","8","9","10","1","2","3","4","5","6","7","8","9","10","1","2","3","4","5","6","7","8","9","10","1","2","3","4","5","6","7","8","9","10","1","2","3","4","5","6","7","8","9","10"]},{"symbol":"TEST", "ids":["1","2","3","4","5","6","7","8","9","10","1","2","3","4","5","6","7","8","9","10","1","2","3","4","5","6","7","8","9","10","1","2","3","4","5","6","7","8","9","10","1","2","3","4","5","6","7","8","9","10","1","2","3","4","5","6","7","8","9","10"]} ] }'));
      
      // these transactions are properly formed but should fail due to not being called from the owning account, invalid symbol, and invalid instance ID
      transactions.push(new Transaction(38145391, 'TXID1256', 'aggroed', 'nft', 'burn', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1257', 'marc', 'testcontract', 'doBurn', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["2"]} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1258', 'aggroed', 'nft', 'burn', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"BAD", "ids":["1"]} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1259', 'aggroed', 'nft', 'burn', '{ "isSignedWithActiveKey": true, "nfts": [ {"symbol":"TSTNFT", "ids":["100"]} ] }'));

      block = {
        refSteemBlockNumber: 38145391,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[0].logs);
      console.log(transactionsBlock2[1].logs);
      console.log(transactionsBlock2[2].logs);
      console.log(transactionsBlock2[3].logs);
      console.log(transactionsBlock2[4].logs);
      console.log(transactionsBlock2[5].logs);
      console.log(transactionsBlock2[6].logs);
      console.log(transactionsBlock2[7].logs);
      console.log(transactionsBlock2[8].logs);
      console.log(transactionsBlock2[9].logs);
      console.log(transactionsBlock2[10].logs);

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[3].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[4].logs).errors[0], 'invalid nft list');
      assert.equal(JSON.parse(transactionsBlock2[5].logs).errors[0], 'invalid nft list');
      assert.equal(JSON.parse(transactionsBlock2[6].logs).errors[0], 'cannot operate on more than 50 NFT instances at once');

      res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;

      // check NFT supply updates OK
      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].maxSupply, 3);
      assert.equal(tokens[0].supply, 3);
      assert.equal(tokens[0].circulatingSupply, 3);

      assert.equal(tokens[1].symbol, 'TEST');
      assert.equal(tokens[1].maxSupply, 0);
      assert.equal(tokens[1].supply, 4);
      assert.equal(tokens[1].circulatingSupply, 4);

      res = await database1.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'testcontract');
      assert.equal(instances[0].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[0].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5","TKN":"0.25"}`);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'aggroed');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10","TKN":"0.5"}`);
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'aggroed');
      assert.equal(instances[2].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[2].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"15","TKN":"0.75"}`);

      res = await database1.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[0].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.001","TKN":"0.001"}`);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'testcontract');
      assert.equal(instances[1].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[1].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.002","TKN":"0.01"}`);
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'testcontract');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[2].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.1"}`);
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'testcontract');
      assert.equal(instances[3].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[3].lockedTokens), '{}');

      res = await database1.find({
          contract: 'tokens',
          table: 'balances',
          query: { "account": { "$in" : ["cryptomancer","aggroed"] }}
        });

      let balances = res;

      // check issuance fees & locked tokens were subtracted from account balance
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '167.89700000');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, '184.389');
      assert.equal(balances.length, 2);

      res = await database1.find({
          contract: 'tokens',
          table: 'contractsBalances',
          query: {}
        });

      balances = res;

      // check nft contract has the proper amount of locked tokens
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '30.10300000');
      assert.equal(balances[0].account, 'nft');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, '1.611');
      assert.equal(balances[1].account, 'nft');
      assert.equal(balances.length, 2);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('issues nft instances', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145391, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1233', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(38145391, 'TXID1234', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.2"}, "dataPropertyCreationFee": "2" }`));
      transactions.push(new Transaction(38145391, 'TXID1235', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145391, 'TXID1236', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(38145391, 'TXID1237', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "0.903", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145391, 'TXID1238', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"3" }'));
      transactions.push(new Transaction(38145391, 'TXID1239', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST", "authorizedIssuingAccounts": ["cryptomancer","aggroed","harpagon"], "authorizedIssuingContracts": ["tokens","dice","testcontract"] }'));
      transactions.push(new Transaction(38145391, 'TXID1240', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145391, 'TXID1241', 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "TKN" }'));
      transactions.push(new Transaction(38145391, 'TXID1242', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"contract1", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"3.5","TKN":"0.003"} }`));
      transactions.push(new Transaction(38145391, 'TXID1243', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"dice", "toType":"contract", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10"} }`));
      transactions.push(new Transaction(38145391, 'TXID1244', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145391, 'TXID1245', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(38145391, 'TXID1246', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(38145391, 'TXID1247', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"contract2", "toType":"contract", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      
      // issue from contract to contract on behalf of a user
      transactions.push(new Transaction(38145391, 'TXID1248', 'cryptomancer', 'testcontract', 'doIssuance', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"contract3", "toType":"contract", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"4","TKN":"0.5"} }`));

      // issue from contract to contract
      transactions.push(new Transaction(38145391, 'TXID1249', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "0.5", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145391, 'TXID1250', 'cryptomancer', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "0.5", "to": "testcontract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145391, 'TXID1251', 'cryptomancer', 'tokens', 'transferToContract', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "4.4", "to": "testcontract", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(38145391, 'TXID1252', 'cryptomancer', 'testcontract', 'doIssuance', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "fromType":"contract", "to":"contract4", "toType":"contract", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"4","TKN":"0.5"} }`));

      // issue from contract to user
      transactions.push(new Transaction(38145391, 'TXID1253', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "0.8", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145391, 'TXID1254', 'cryptomancer', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "0.8", "to": "testcontract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145391, 'TXID1255', 'thecryptodrive', 'testcontract', 'doIssuance', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "fromType":"contract", "to":"null", "toType":"user", "feeSymbol": "TKN" }'));

      let block = {
        refSteemBlockNumber: 38145391,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[10].logs)
      console.log(transactionsBlock1[11].logs)
      console.log(transactionsBlock1[12].logs)
      console.log(transactionsBlock1[13].logs)
      console.log(transactionsBlock1[17].logs)
      console.log(transactionsBlock1[18].logs)
      console.log(transactionsBlock1[22].logs)
      console.log(transactionsBlock1[25].logs)

      res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      const tokens = res;
      console.log(tokens);

      // check NFT supply updates OK
      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(tokens[0].name, 'test NFT');
      assert.equal(tokens[0].maxSupply, 3);
      assert.equal(tokens[0].supply, 3);
      assert.equal(tokens[0].circulatingSupply, 3);

      assert.equal(tokens[1].symbol, 'TEST');
      assert.equal(tokens[1].issuer, 'cryptomancer');
      assert.equal(tokens[1].name, 'test NFT 2');
      assert.equal(tokens[1].maxSupply, 0);
      assert.equal(tokens[1].supply, 5);
      assert.equal(tokens[1].circulatingSupply, 4);

      res = await database1.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;
      console.log(instances);

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[0].lockedTokens), '{}');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'aggroed');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].lockedTokens), '{}');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'contract1');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[2].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"3.5","TKN":"0.003"}`);

      res = await database1.find({
          contract: 'nft',
          table: 'TESTinstances',
          query: {}
        });

      instances = res;
      console.log(instances);

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'dice');
      assert.equal(instances[0].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[0].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10"}`);
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'contract2');
      assert.equal(instances[1].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[1].lockedTokens), '{}');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'contract3');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[2].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"4","TKN":"0.5"}`);
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'contract4');
      assert.equal(instances[3].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[3].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"4","TKN":"0.5"}`);
      assert.equal(instances[4]._id, 5);
      assert.equal(instances[4].account, 'null');
      assert.equal(instances[4].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[4].lockedTokens), '{}');

      res = await database1.find({
          contract: 'tokens',
          table: 'balances',
          query: { account: 'cryptomancer' }
        });

      let balances = res;
      console.log(balances);

      // check issuance fees & locked tokens were subtracted from account balance
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '167.10000000');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, '0.000');

      res = await database1.find({
          contract: 'tokens',
          table: 'contractsBalances',
          query: {}
        });

      balances = res;
      console.log(balances);

      // check nft contract has the proper amount of locked tokens
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '21.50000000');
      assert.equal(balances[0].account, 'nft');
      assert.equal(balances[1].symbol, 'TKN');
      assert.equal(balances[1].balance, '1.003');
      assert.equal(balances[1].account, 'nft');
      assert.equal(balances[2].symbol, 'TKN');
      assert.equal(balances[2].balance, '0.000');
      assert.equal(balances[2].account, 'testcontract');
      assert.equal(balances[3].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[3].balance, '0.00000000');
      assert.equal(balances[3].account, 'testcontract');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not issue nft instances', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145391, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1233', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": "1" }'));
      transactions.push(new Transaction(38145391, 'TXID1234', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1","TKN":"0.2"}, "dataPropertyCreationFee": "2" }`));
      transactions.push(new Transaction(38145391, 'TXID1235', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145391, 'TXID1236', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(38145391, 'TXID1237', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "0.403", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145391, 'TXID1238', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"3" }'));
      transactions.push(new Transaction(38145391, 'TXID1239', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name": "test NFT 2", "symbol": "TEST", "authorizedIssuingAccounts": ["aggroed","harpagon"], "authorizedIssuingContracts": ["tokens","dice"] }'));
      transactions.push(new Transaction(38145391, 'TXID1240', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": false, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      
      // invalid params
      transactions.push(new Transaction(38145391, 'TXID1241', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fromType":"contract" }`));      
      transactions.push(new Transaction(38145391, 'TXID1242', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fromType":"dddd" }`));
      transactions.push(new Transaction(38145391, 'TXID1243', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "toType":"dddd" }`));
      transactions.push(new Transaction(38145391, 'TXID1244', 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "INVALID" }'));
      transactions.push(new Transaction(38145391, 'TXID1245', 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "TKN", "lockTokens":"bad format" }'));

      // invalid to
      transactions.push(new Transaction(38145391, 'TXID1246', 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"a", "feeSymbol": "TKN" }'));
      transactions.push(new Transaction(38145391, 'TXID1247', 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"toooooooolllllllllooooooooonnnnnnnggggggggg", "feeSymbol": "TKN" }'));

      // symbol does not exist
      transactions.push(new Transaction(38145391, 'TXID1248', 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "BADSYMBOL", "to":"aggroed", "feeSymbol": "TKN" }'));

      // not allowed to issue tokens
      transactions.push(new Transaction(38145391, 'TXID1249', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145391, 'TXID1250', 'aggroed', 'testcontract', 'doIssuance', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "fromType":"contract", "to":"contract4", "toType":"contract", "feeSymbol": "TKN" }'));

      // max supply limit reached
      transactions.push(new Transaction(38145391, 'TXID1251', 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "TKN" }'));
      transactions.push(new Transaction(38145391, 'TXID1252', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"contract1", "toType":"contract", "feeSymbol": "TKN", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"3.5","TKN":"0.003"} }`));
      transactions.push(new Transaction(38145391, 'TXID1253', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"dice", "toType":"contract", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "lockTokens": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10"} }`));
      transactions.push(new Transaction(38145391, 'TXID1254', 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "TKN" }'));

      // not enough balance for issuance fees
      transactions.push(new Transaction(38145391, 'TXID1255', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "0.3", "to": "cryptomancer", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145391, 'TXID1256', 'cryptomancer', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "0.1", "to": "testcontract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145391, 'TXID1257', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5", "nftIssuanceFee": {"TKN":"0.3"}, "dataPropertyCreationFee": "2" }'));
      transactions.push(new Transaction(38145391, 'TXID1258', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "contracts": ["testcontract"] }'));
      transactions.push(new Transaction(38145391, 'TXID1259', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "accounts": ["cryptomancer"] }'));
      transactions.push(new Transaction(38145391, 'TXID1260', 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "TKN" }'));
      transactions.push(new Transaction(38145391, 'TXID1261', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5", "nftIssuanceFee": {"TKN":"0.2"}, "dataPropertyCreationFee": "2" }'));
      transactions.push(new Transaction(38145391, 'TXID1262', 'aggroed', 'testcontract', 'doIssuance', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "fromType":"contract", "to":"contract4", "toType":"contract", "feeSymbol": "TKN" }'));

      // invalid locked token basket
      transactions.push(new Transaction(38145391, 'TXID1263', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5", "nftIssuanceFee": {"TKN":"0.001"}, "dataPropertyCreationFee": "2" }'));
      transactions.push(new Transaction(38145391, 'TXID1264', 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "TKN", "lockTokens": {"TKN":"100"} }'));
      transactions.push(new Transaction(38145391, 'TXID1265', 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "TKN", "lockTokens": {"AAA":"100"} }'));
      transactions.push(new Transaction(38145391, 'TXID1266', 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "TKN", "lockTokens": {"TKN":"0.1","BBB":"10"} }'));
      transactions.push(new Transaction(38145391, 'TXID1267', 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "TKN", "lockTokens": [1,2,3] }'));
      transactions.push(new Transaction(38145391, 'TXID1268', 'cryptomancer', 'nft', 'issue', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "TKN", "lockTokens": {"TKN":"0.0001"} }'));

      let block = {
        refSteemBlockNumber: 38145391,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[10].logs)
      console.log(transactionsBlock1[11].logs)
      console.log(transactionsBlock1[12].logs)
      console.log(transactionsBlock1[13].logs)
      console.log(transactionsBlock1[14].logs)
      console.log(transactionsBlock1[15].logs)
      console.log(transactionsBlock1[16].logs)
      console.log(transactionsBlock1[17].logs)
      console.log(transactionsBlock1[18].logs)
      console.log(transactionsBlock1[19].logs)
      console.log(transactionsBlock1[20].logs)
      console.log(transactionsBlock1[24].logs)
      console.log(transactionsBlock1[30].logs)
      console.log(transactionsBlock1[32].logs)
      console.log(transactionsBlock1[34].logs)
      console.log(transactionsBlock1[35].logs)
      console.log(transactionsBlock1[36].logs)
      console.log(transactionsBlock1[37].logs)
      console.log(transactionsBlock1[38].logs)

      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[17].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[18].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[19].logs).errors[0], 'not allowed to issue tokens');
      assert.equal(JSON.parse(transactionsBlock1[20].logs).errors[0], 'not allowed to issue tokens');
      assert.equal(JSON.parse(transactionsBlock1[24].logs).errors[0], 'max supply limit reached');
      assert.equal(JSON.parse(transactionsBlock1[30].logs).errors[0], 'you must have enough tokens to cover the issuance fees');
      assert.equal(JSON.parse(transactionsBlock1[32].logs).errors[0], 'you must have enough tokens to cover the issuance fees');
      assert.equal(JSON.parse(transactionsBlock1[34].logs).errors[0], 'invalid basket of tokens to lock (cannot lock more than 10 token types; issuing account must have enough balance)');
      assert.equal(JSON.parse(transactionsBlock1[35].logs).errors[0], 'invalid basket of tokens to lock (cannot lock more than 10 token types; issuing account must have enough balance)');
      assert.equal(JSON.parse(transactionsBlock1[36].logs).errors[0], 'invalid basket of tokens to lock (cannot lock more than 10 token types; issuing account must have enough balance)');
      assert.equal(JSON.parse(transactionsBlock1[37].logs).errors[0], 'invalid basket of tokens to lock (cannot lock more than 10 token types; issuing account must have enough balance)');
      assert.equal(JSON.parse(transactionsBlock1[38].logs).errors[0], 'invalid basket of tokens to lock (cannot lock more than 10 token types; issuing account must have enough balance)');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('issues multiple nft instances', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      const lockTokens = {};
      lockTokens[CONSTANTS.UTILITY_TOKEN_SYMBOL] = "5.75";

      const lockTokens2 = {};
      lockTokens2[CONSTANTS.UTILITY_TOKEN_SYMBOL] = "10";

      let instances1 = [
        { symbol: "TSTNFT", to:"aggroed", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },
        { symbol: "TSTNFT", to:"harpagon", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, lockTokens },
        { symbol: "TSTNFT", to:"cryptomancer", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, lockTokens: lockTokens2, properties:{"color":"red","frozen":true} },
        { symbol: "TSTNFT", to:"marc", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL },
      ];

      let instances2 = [
        { fromType: "user", symbol: "TSTNFT", to:"contract1", toType: "contract", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },   // won't issue this one because caller not authorized
        { fromType: "contract", symbol: "TSTNFT", to:"dice", toType: "contract", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, lockTokens },
        { fromType: "contract", symbol: "TSTNFT", to:"tokens", toType: "contract", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, lockTokens: lockTokens2, properties:{"color":"red","frozen":true} },
        { fromType: "contract", symbol: "TSTNFT", to:"market", toType: "contract", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, lockTokens:{}, properties:{} },
      ];

      console.log(instances2)

      let transactions = [];
      transactions.push(new Transaction(38145391, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1233', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "dataPropertyCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"1"} }`));
      transactions.push(new Transaction(38145391, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145391, 'TXID1235', 'cryptomancer', 'tokens', 'transferToContract', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "100", "to": "testcontract", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(38145391, 'TXID1236', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000", "authorizedIssuingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(38145391, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"id", "type":"string", "isReadOnly":true, "authorizedEditingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(38145391, 'TXID1238', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string", "authorizedEditingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(38145391, 'TXID1239', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number", "authorizedEditingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(38145391, 'TXID1240', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true, "authorizedEditingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(38145391, 'TXID1241', 'cryptomancer', 'nft', 'issueMultiple', `{ "isSignedWithActiveKey": true, "instances": ${JSON.stringify(instances1)} }`));
      transactions.push(new Transaction(38145391, 'TXID1242', 'aggroed', 'testcontract', 'doMultipleIssuance', `{ "isSignedWithActiveKey": true, "instances": ${JSON.stringify(instances2)} }`));

      let block = {
        refSteemBlockNumber: 38145391,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;
      console.log(instances);

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[0].properties), '{"level":0}');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'harpagon');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5.75"}`);
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'cryptomancer');
      assert.equal(instances[2].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[2].properties), '{"color":"red","frozen":true}');
      assert.equal(JSON.stringify(instances[2].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10"}`);
      assert.equal(instances[3]._id, 4);
      assert.equal(instances[3].account, 'marc');
      assert.equal(instances[3].ownedBy, 'u');

      assert.equal(instances[4]._id, 5);
      assert.equal(instances[4].account, 'dice');
      assert.equal(instances[4].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[4].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"5.75"}`);
      assert.equal(instances[5]._id, 6);
      assert.equal(instances[5].account, 'tokens');
      assert.equal(instances[5].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[5].properties), '{"color":"red","frozen":true}');
      assert.equal(JSON.stringify(instances[5].lockedTokens), `{"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"10"}`);
      assert.equal(instances[6]._id, 7);
      assert.equal(instances[6].account, 'market');
      assert.equal(instances[6].ownedBy, 'c');

      res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'not allowed to issue tokens');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not issue multiple nft instances', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      // can't issue this many at once
      let instances1 = [
        { symbol: "TSTNFT", to:"aggroed", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },
        { symbol: "TSTNFT", to:"marc", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL },
        { symbol: "TSTNFT", to:"aggroed", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },
        { symbol: "TSTNFT", to:"marc", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL },
        { symbol: "TSTNFT", to:"aggroed", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },
        { symbol: "TSTNFT", to:"marc", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL },
        { symbol: "TSTNFT", to:"aggroed", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },
        { symbol: "TSTNFT", to:"marc", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL },
        { symbol: "TSTNFT", to:"aggroed", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },
        { symbol: "TSTNFT", to:"marc", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL },
        { symbol: "TSTNFT", to:"aggroed", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },
      ];

      const lockTokens = {};
      lockTokens[CONSTANTS.UTILITY_TOKEN_SYMBOL] = "5.75";

      const lockTokens2 = {};
      lockTokens2[CONSTANTS.UTILITY_TOKEN_SYMBOL] = "10";

      let instances2 = [
        { fromType: "user", symbol: "TSTNFT", to:"contract1", toType: "contract", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, properties:{"level":0} },   // won't issue this one because caller not authorized
        { fromType: "contract", symbol: "BAD", to:"dice", toType: "contract", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, lockTokens },      // bad symbol
        { fromType: "contract", symbol: "TSTNFT", to:"tokens", toType: "contract", feeSymbol: CONSTANTS.UTILITY_TOKEN_SYMBOL, lockTokens: lockTokens2, properties:{"invalid":"red","frozen":true} },   // data property doesn't exist
        { fromType: "contract", symbol: "TSTNFT", to:"market", toType: "contract", lockTokens:{}, properties:{} },     // missing fee symbol, invalid params
      ];

      let transactions = [];
      transactions.push(new Transaction(38145391, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1233', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "dataPropertyCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"1"} }`));
      transactions.push(new Transaction(38145391, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145391, 'TXID1235', 'cryptomancer', 'tokens', 'transferToContract', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "quantity": "100", "to": "testcontract", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(38145391, 'TXID1236', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000", "authorizedIssuingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(38145391, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"id", "type":"string", "isReadOnly":true, "authorizedEditingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(38145391, 'TXID1238', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string", "authorizedEditingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(38145391, 'TXID1239', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number", "authorizedEditingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(38145391, 'TXID1240', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true, "authorizedEditingContracts": ["testcontract"] }'));
      transactions.push(new Transaction(38145391, 'TXID1241', 'cryptomancer', 'nft', 'issueMultiple', `{ "isSignedWithActiveKey": false, "instances": ${JSON.stringify(instances1)} }`));
      transactions.push(new Transaction(38145391, 'TXID1242', 'cryptomancer', 'nft', 'issueMultiple', '{ "isSignedWithActiveKey": true, "instances": {"bad":"formatting"} }'));
      transactions.push(new Transaction(38145391, 'TXID1243', 'cryptomancer', 'nft', 'issueMultiple', '{ "isSignedWithActiveKey": true, "instances": [1,2,3,4,5] }'));
      transactions.push(new Transaction(38145391, 'TXID1244', 'cryptomancer', 'nft', 'issueMultiple', `{ "isSignedWithActiveKey": true, "instances": ${JSON.stringify(instances1)} }`));
      transactions.push(new Transaction(38145391, 'TXID1245', 'aggroed', 'testcontract', 'doMultipleIssuance', `{ "isSignedWithActiveKey": true, "instances": ${JSON.stringify(instances2)} }`));

      let block = {
        refSteemBlockNumber: 38145391,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;

      console.log(transactionsBlock1[11].logs)
      console.log(transactionsBlock1[12].logs)
      console.log(transactionsBlock1[13].logs)
      console.log(transactionsBlock1[14].logs)
      console.log(transactionsBlock1[15].logs)

      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[1], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[2], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[3], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[4], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'cannot issue more than 10 NFT instances at once');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[0], 'not allowed to issue tokens');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[1], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[2], 'data property must exist');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[3], 'invalid params');

      res = await database1.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;
      console.log(instances);
      assert.equal(instances.length, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('sets the market group by list', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145391, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5", "dataPropertyCreationFee": "10" }'));
      transactions.push(new Transaction(38145391, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"25", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145391, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(38145391, 'TXID1235', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145391, 'TXID1236', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(38145391, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(38145391, 'TXID1238', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":false }'));
      transactions.push(new Transaction(38145391, 'TXID1239', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "properties": ["level","isFood"] }'));

      let block = {
        refSteemBlockNumber: 38145391,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
        contract: 'nft',
        table: 'nfts',
        query: {}
      });

      let tokens = res;
      console.log(tokens)

      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(JSON.stringify(tokens[0].groupBy), '["level","isFood"]');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not set the market group by list', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145391, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5", "dataPropertyCreationFee": "10" }'));
      transactions.push(new Transaction(38145391, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"25", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145391, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(38145391, 'TXID1235', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145391, 'TXID1236', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(38145391, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(38145391, 'TXID1238', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":false }'));
      
      // all these should fail
      transactions.push(new Transaction(38145391, 'TXID1239', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":false, "symbol":"TSTNFT", "properties": ["level","isFood"] }'));
      transactions.push(new Transaction(38145391, 'TXID1240', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "properties": ["level","isFood"] }'));
      transactions.push(new Transaction(38145391, 'TXID1241', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "properties": {"level":"isFood"} }'));
      transactions.push(new Transaction(38145391, 'TXID1242', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"BAD", "properties": ["level","isFood"] }'));
      transactions.push(new Transaction(38145391, 'TXID1243', 'aggroed', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "properties": ["level","isFood"] }'));
      transactions.push(new Transaction(38145391, 'TXID1244', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "properties": ["level","isFood","color","frozen","badproperty"] }'));
      transactions.push(new Transaction(38145391, 'TXID1245', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "properties": ["level","isFood","level"] }'));
      transactions.push(new Transaction(38145391, 'TXID1246', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "properties": ["level","Level"] }'));

      let block = {
        refSteemBlockNumber: 38145391,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[9].logs)
      console.log(transactionsBlock1[10].logs)
      console.log(transactionsBlock1[11].logs)
      console.log(transactionsBlock1[12].logs)
      console.log(transactionsBlock1[13].logs)
      console.log(transactionsBlock1[14].logs)
      console.log(transactionsBlock1[15].logs)
      console.log(transactionsBlock1[16].logs)

      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'cannot set more data properties than NFT has');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[0], 'list cannot contain duplicates');
      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'data property must exist');

      res = await database1.find({
        contract: 'nft',
        table: 'nfts',
        query: {}
      });

      let tokens = res;
      console.log(tokens)

      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(JSON.stringify(tokens[0].groupBy), '[]');

      // make sure the list cannot be set more than once
      transactions = [];
      transactions.push(new Transaction(38145392, 'TXID1247', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "properties": ["level","isFood"] }'));
      transactions.push(new Transaction(38145392, 'TXID1248', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "properties": ["color","frozen"] }'));

      block = {
        refSteemBlockNumber: 38145392,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[0].logs)
      console.log(transactionsBlock2[1].logs)

      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'list is already set');

      res = await database1.find({
        contract: 'nft',
        table: 'nfts',
        query: {}
      });

      tokens = res;

      // make sure list didn't change once set
      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(JSON.stringify(tokens[0].groupBy), '["level","isFood"]');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('adds data properties', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145391, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5", "dataPropertyCreationFee": "10" }'));
      transactions.push(new Transaction(38145391, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"25", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145391, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(38145391, 'TXID1235', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145391, 'TXID1236', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(38145391, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(38145391, 'TXID1238', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":false }'));

      let block = {
        refSteemBlockNumber: 38145391,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;
      console.log(tokens)

      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(tokens[0].name, 'test NFT');
      assert.equal(tokens[0].maxSupply, 1000);
      assert.equal(tokens[0].supply, 0);
      assert.equal(tokens[0].metadata, '{"url":"http://mynft.com"}');
      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer"]');
      assert.equal(tokens[0].circulatingSupply, 0);

      let properties = tokens[0].properties;
      console.log(properties);

      assert.equal(properties.color.type, "string");
      assert.equal(properties.color.isReadOnly, false);
      assert.equal(properties.level.type, "number");
      assert.equal(properties.level.isReadOnly, false);
      assert.equal(properties.frozen.type, "boolean");
      assert.equal(properties.frozen.isReadOnly, true);
      assert.equal(properties.isFood.type, "boolean");
      assert.equal(properties.isFood.isReadOnly, false);

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            symbol: `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`,
            account: "cryptomancer"
          }
        });

      console.log(res);
      assert.equal(res.balance, "10.00000000");

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not add data properties', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145391, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5", "dataPropertyCreationFee": "1000" }'));
      transactions.push(new Transaction(38145391, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"25", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145391, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(38145391, 'TXID1235', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145391, 'TXID1236', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(38145391, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(38145391, 'TXID1238', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":false }'));
      transactions.push(new Transaction(38145391, 'TXID1239', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":false, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":false }'));
      transactions.push(new Transaction(38145391, 'TXID1240', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":23 }'));
      transactions.push(new Transaction(38145391, 'TXID1241', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":1234, "type":"boolean", "isReadOnly":false }'));
      transactions.push(new Transaction(38145391, 'TXID1242', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "name":"isFood", "type":"boolean", "isReadOnly":false }'));
      transactions.push(new Transaction(38145391, 'TXID1243', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":[], "isReadOnly":false }'));
      transactions.push(new Transaction(38145391, 'TXID1244', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":" isFood ", "type":"boolean" }'));
      transactions.push(new Transaction(38145391, 'TXID1245', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"thisnameistootootootootootoolooooooooooooooooong", "type":"boolean" }'));
      transactions.push(new Transaction(38145391, 'TXID1246', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"invalidtype", "isReadOnly":false }'));
      transactions.push(new Transaction(38145391, 'TXID1247', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"boolean", "isReadOnly":false }'));
      transactions.push(new Transaction(38145391, 'TXID1248', 'aggroed', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":false }'));

      let block = {
        refSteemBlockNumber: 38145391,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[8].logs)
      console.log(transactionsBlock1[9].logs)
      console.log(transactionsBlock1[10].logs)
      console.log(transactionsBlock1[11].logs)
      console.log(transactionsBlock1[12].logs)
      console.log(transactionsBlock1[13].logs)
      console.log(transactionsBlock1[14].logs)
      console.log(transactionsBlock1[15].logs)
      console.log(transactionsBlock1[16].logs)
      console.log(transactionsBlock1[17].logs)
      console.log(transactionsBlock1[18].logs)

      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'you must have enough tokens to cover the creation fees');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'invalid name: letters & numbers only, max length of 25');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[0], 'invalid name: letters & numbers only, max length of 25');
      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'invalid type: must be number, string, or boolean');
      assert.equal(JSON.parse(transactionsBlock1[17].logs).errors[0], 'cannot add the same property twice');
      assert.equal(JSON.parse(transactionsBlock1[18].logs).errors[0], 'must be the issuer');

      res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;
      let properties = tokens[0].properties;
      assert.equal(Object.keys(properties).length, 3)

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('sets data properties', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145391, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1233', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "dataPropertyCreationFee": "1", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"} }`));
      transactions.push(new Transaction(38145391, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"7.5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145391, 'TXID1235', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000", "authorizedIssuingAccounts": ["aggroed","cryptomancer"] }'));
      transactions.push(new Transaction(38145391, 'TXID1236', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"id", "type":"string", "isReadOnly":true }'));
      transactions.push(new Transaction(38145391, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145391, 'TXID1238', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(38145391, 'TXID1239', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(38145391, 'TXID1240', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties":{"level":0} }`));
      transactions.push(new Transaction(38145391, 'TXID1241', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties":{} }`));
      transactions.push(new Transaction(38145391, 'TXID1242', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"testcontract", "toType":"contract", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties":{"level":1,"color":"yellow"} }`));
      transactions.push(new Transaction(38145391, 'TXID1243', 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "contracts":["testcontract"] }'));
      transactions.push(new Transaction(38145391, 'TXID1244', 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [ {"id":"1", "properties": {"color":"red","level":"2"}},{"id":"3", "properties": {"color":"black"}} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1245', 'jarunik', 'testcontract', 'doSetProperties', '{ "fromType":"contract", "symbol":"TSTNFT", "nfts": [ {"id":"2", "properties": {"frozen":true}} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1246', 'jarunik', 'testcontract', 'doSetProperties', '{ "fromType":"contract", "symbol":"TSTNFT", "nfts": [ {"id":"2", "properties": {"frozen":false}} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1247', 'jarunik', 'testcontract', 'doSetProperties', '{ "fromType":"contract", "symbol":"TSTNFT", "nfts": [ {"id":"2", "properties": {"level":"999"}} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1248', 'cryptomancer', 'nft', 'setProperties', '{ "fromType":"user", "symbol":"TSTNFT", "nfts": [ {"id":"1", "properties": {}},{"id":"2", "properties": {}},{"id":"3", "properties": {}} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1249', 'cryptomancer', 'nft', 'setProperties', '{ "fromType":"user", "symbol":"TSTNFT", "nfts": [{"id":"1", "properties": {}},{"id":"3", "properties": {"level":3,"level":3,"level":3}}] }'));
      transactions.push(new Transaction(38145391, 'TXID1250', 'cryptomancer', 'nft', 'setProperties', '{ "fromType":"user", "symbol":"TSTNFT", "nfts": [] }'));
      transactions.push(new Transaction(38145391, 'TXID1251', 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [{"id":"3", "properties": {"id":"NFT-XYZ-123"}}] }'));
      transactions.push(new Transaction(38145391, 'TXID1252', 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [{"id":"3", "properties": {"id":"NFT-ABC-666"}}] }'));

      let block = {
        refSteemBlockNumber: 38145391,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;
      console.log(instances);

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[0].properties), '{"level":2,"color":"red"}');
      assert.equal(instances[1]._id, 2);
      assert.equal(instances[1].account, 'marc');
      assert.equal(instances[1].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[1].properties), '{"frozen":true}');
      assert.equal(instances[2]._id, 3);
      assert.equal(instances[2].account, 'testcontract');
      assert.equal(instances[2].ownedBy, 'c');
      assert.equal(JSON.stringify(instances[2].properties), '{"level":3,"color":"black","id":"NFT-XYZ-123"}');
      assert.equal(instances.length, 3);

      res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'cannot edit read-only properties');
      assert.equal(JSON.parse(transactionsBlock1[17].logs).errors[0], 'not allowed to set data properties');
      assert.equal(JSON.parse(transactionsBlock1[22].logs).errors[0], 'cannot edit read-only properties');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not set data properties', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145391, 'TXID1229', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1230', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(testcontractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1232', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"} }`));
      transactions.push(new Transaction(38145391, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5.4", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145391, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000", "authorizedIssuingAccounts": ["aggroed","cryptomancer"] }'));
      transactions.push(new Transaction(38145391, 'TXID1235', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145391, 'TXID1236', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(38145391, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(38145391, 'TXID1238', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties":{"color":"blue", "level":"5", "frozen": true} }`));
      transactions.push(new Transaction(38145391, 'TXID1239', 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": { "symbol":"TSTNFT" } }'));
      transactions.push(new Transaction(38145391, 'TXID1240', 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "fromType":"user", "nfts": [ 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101 ] }'));
      transactions.push(new Transaction(38145391, 'TXID1241', 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "fromType":"contract", "nfts": [ 1, 2, 3 ] }'));
      transactions.push(new Transaction(38145391, 'TXID1242', 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"BAD", "nfts": [ {"id":"1", "properties": {"color":"red"}} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1243', 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [ {"id":"2", "properties": {"color":"red"}} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1244', 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [ {"id":"1", "properties": {"color":"red","frozen":false}} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1245', 'aggroed', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "properties":{"color":"green", "level":2, "frozen": false} }`));
      transactions.push(new Transaction(38145391, 'TXID1246', 'cryptomancer', 'testcontract', 'doSetProperties', '{ "fromType":"contract", "symbol":"TSTNFT", "nfts": [ {"id":"1", "properties": {"color":"red"}} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1247', 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [ {"id":"1", "properties": {"color":"red","color1":"red","color2":"red","color3":"red"}} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1248', 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [ {"id":"1", "properties": {"level":3,"&*#()*$":"red"}} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1249', 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [ {"id":"1", "properties": {"level":3,"vehicle":"car"}} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1250', 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [ {"id":"1", "properties": {"level":3,"color":3.14159}} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1251', 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [ {"id":"1", "properties": {"color":"yellow","level":"3.1415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679"}} ] }'));
      transactions.push(new Transaction(38145391, 'TXID1252', 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TSTNFT", "nfts": [ { "badkey": "badvalue" } ] }'));

      let block = {
        refSteemBlockNumber: 38145391,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getBlockInfo(1);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;
      console.log(transactionsBlock1[9].logs)
      console.log(transactionsBlock1[10].logs)
      console.log(transactionsBlock1[11].logs)
      console.log(transactionsBlock1[12].logs)
      console.log(transactionsBlock1[13].logs)
      console.log(transactionsBlock1[14].logs)
      console.log(transactionsBlock1[15].logs)
      console.log(transactionsBlock1[16].logs)
      console.log(transactionsBlock1[17].logs)
      console.log(transactionsBlock1[18].logs)
      console.log(transactionsBlock1[19].logs)
      console.log(transactionsBlock1[20].logs)
      console.log(transactionsBlock1[21].logs)
      console.log(transactionsBlock1[22].logs)
      console.log(transactionsBlock1[23].logs)

      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'cannot set properties on more than 50 NFT instances at once');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[13].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'nft instance does not exist');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[0], 'cannot edit read-only properties');
      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'not allowed to set data properties');
      assert.equal(JSON.parse(transactionsBlock1[17].logs).errors[0], 'not allowed to set data properties');
      assert.equal(JSON.parse(transactionsBlock1[18].logs).errors[0], 'cannot set more data properties than NFT has');
      assert.equal(JSON.parse(transactionsBlock1[19].logs).errors[0], 'invalid data property name: letters & numbers only, max length of 25');
      assert.equal(JSON.parse(transactionsBlock1[20].logs).errors[0], 'data property must exist');
      assert.equal(JSON.parse(transactionsBlock1[21].logs).errors[0], 'data property type mismatch: expected string but got number for property color');
      assert.equal(JSON.parse(transactionsBlock1[22].logs).errors[0], 'string property max length is 100 characters');
      assert.equal(JSON.parse(transactionsBlock1[23].logs).errors[0], 'invalid data properties');

      res = await database1.find({
          contract: 'nft',
          table: 'TSTNFTinstances',
          query: {}
        });

      let instances = res;
      console.log(instances);

      // check NFT instances are OK
      assert.equal(instances[0]._id, 1);
      assert.equal(instances[0].account, 'aggroed');
      assert.equal(instances[0].ownedBy, 'u');
      assert.equal(JSON.stringify(instances[0].properties), '{"color":"red","level":5,"frozen":true}');
      assert.equal(instances.length, 1);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('sets data property permissions', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145391, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145391, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5", "dataPropertyCreationFee": "10" }'));
      transactions.push(new Transaction(38145391, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"25", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145391, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(38145391, 'TXID1235', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string", "authorizedEditingContracts":["mycontract1","mycontract2","mycontract3","mycontract4"] }'));
      transactions.push(new Transaction(38145391, 'TXID1236', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number", "authorizedEditingAccounts":["bobbie"] }'));
      transactions.push(new Transaction(38145391, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(38145391, 'TXID1238', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":false, "authorizedEditingContracts":["mycontract1","mycontract2","mycontract3","mycontract4"], "authorizedEditingAccounts":["bobbie"] }'));

      let block = {
        refSteemBlockNumber: 38145391,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(38145392, 'TXID1239', 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "accounts":["  AGGroed","cryptomancer","marc"] }'));
      transactions.push(new Transaction(38145392, 'TXID1240', 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "contracts":["  tokens","market   "] }'));
      transactions.push(new Transaction(38145392, 'TXID1241', 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "contracts":["contract1","  contract2  ","contract3"], "accounts":["Harpagon"] }'));
      transactions.push(new Transaction(38145392, 'TXID1242', 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "contracts":[], "accounts":[] }'));

      block = {
        refSteemBlockNumber: 38145392,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;
      console.log(tokens)

      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(tokens[0].name, 'test NFT');
      assert.equal(tokens[0].maxSupply, 1000);
      assert.equal(tokens[0].supply, 0);
      assert.equal(tokens[0].metadata, '{"url":"http://mynft.com"}');
      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer"]');
      assert.equal(tokens[0].circulatingSupply, 0);

      let properties = tokens[0].properties;
      console.log(properties);

      assert.equal(properties.color.type, "string");
      assert.equal(properties.color.isReadOnly, false);
      assert.equal(JSON.stringify(properties.color.authorizedEditingAccounts), '["aggroed","cryptomancer","marc"]');
      assert.equal(JSON.stringify(properties.color.authorizedEditingContracts), '["mycontract1","mycontract2","mycontract3","mycontract4"]');
      assert.equal(properties.level.type, "number");
      assert.equal(properties.level.isReadOnly, false);
      assert.equal(JSON.stringify(properties.level.authorizedEditingAccounts), '["bobbie"]');
      assert.equal(JSON.stringify(properties.level.authorizedEditingContracts), '["tokens","market"]');
      assert.equal(properties.frozen.type, "boolean");
      assert.equal(properties.frozen.isReadOnly, true);
      assert.equal(JSON.stringify(properties.frozen.authorizedEditingAccounts), '["harpagon"]');
      assert.equal(JSON.stringify(properties.frozen.authorizedEditingContracts), '["contract1","contract2","contract3"]');
      assert.equal(properties.isFood.type, "boolean");
      assert.equal(properties.isFood.isReadOnly, false);
      assert.equal(JSON.stringify(properties.isFood.authorizedEditingAccounts), '[]');
      assert.equal(JSON.stringify(properties.isFood.authorizedEditingContracts), '[]');

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            symbol: `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`,
            account: "cryptomancer"
          }
        });

      console.log(res);
      assert.equal(res.balance, "10.00000000");

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not set data property permissions', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145392, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145392, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145392, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5", "dataPropertyCreationFee": "10" }'));
      transactions.push(new Transaction(38145392, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"25", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145392, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(38145392, 'TXID1235', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "type":"string", "authorizedEditingContracts":["mycontract1","mycontract2","mycontract3","mycontract4"] }'));
      transactions.push(new Transaction(38145392, 'TXID1236', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "type":"number", "authorizedEditingAccounts":["bobbie"] }'));
      transactions.push(new Transaction(38145392, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "type":"boolean", "isReadOnly":true }'));
      transactions.push(new Transaction(38145392, 'TXID1238', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "type":"boolean", "isReadOnly":false, "authorizedEditingContracts":["mycontract1","mycontract2","mycontract3","mycontract4"], "authorizedEditingAccounts":["bobbie"] }'));

      let block = {
        refSteemBlockNumber: 38145392,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(38145393, 'TXID1239', 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":false, "symbol":"TSTNFT", "name":"color", "accounts":["  AGGroed","cryptomancer","marc"] }'));
      transactions.push(new Transaction(38145393, 'TXID1240', 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"level", "contracts":{ "market":true } }'));
      transactions.push(new Transaction(38145393, 'TXID1241', 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "accounts": 3 }'));
      transactions.push(new Transaction(38145393, 'TXID1242', 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"is Food", "contracts":[], "accounts":[] }'));
      transactions.push(new Transaction(38145393, 'TXID1243', 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "contracts":[], "accounts":["acc1","acc2","acc3","acc4","acc5","acc6","acc7","acc8","acc9","acc10","acc11"] }'));
      transactions.push(new Transaction(38145393, 'TXID1244', 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"isFood", "accounts":[], "contracts":["acc1","acc2","acc3","acc4","acc5","acc6","acc7","acc8","acc9","acc10","acc11"] }'));
      transactions.push(new Transaction(38145393, 'TXID1245', 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "accounts":[1,2,3] }'));
      transactions.push(new Transaction(38145393, 'TXID1246', 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"frozen", "contracts":[true,"contract1"] }'));
      transactions.push(new Transaction(38145393, 'TXID1247', 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"rarity", "accounts":["  AGGroed","cryptomancer","marc"] }'));
      transactions.push(new Transaction(38145393, 'TXID1248', 'aggroed', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "accounts":["  AGGroed","cryptomancer","marc"] }'));
      transactions.push(new Transaction(38145393, 'TXID1249', 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "accounts":["cryptomancer","cryptomancer","marc"] }'));
      transactions.push(new Transaction(38145393, 'TXID1250', 'cryptomancer', 'nft', 'setPropertyPermissions', '{ "isSignedWithActiveKey":true, "symbol":"TSTNFT", "name":"color", "contracts":["contract1","tokens","market","tokens"] }'));

      block = {
        refSteemBlockNumber: 38145393,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;
      console.log(tokens)

      assert.equal(tokens[0].symbol, 'TSTNFT');
      assert.equal(tokens[0].issuer, 'cryptomancer');
      assert.equal(tokens[0].name, 'test NFT');
      assert.equal(tokens[0].maxSupply, 1000);
      assert.equal(tokens[0].supply, 0);
      assert.equal(tokens[0].metadata, '{"url":"http://mynft.com"}');
      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer"]');
      assert.equal(tokens[0].circulatingSupply, 0);

      let properties = tokens[0].properties;
      console.log(properties);

      assert.equal(properties.color.type, "string");
      assert.equal(properties.color.isReadOnly, false);
      assert.equal(JSON.stringify(properties.color.authorizedEditingAccounts), '["cryptomancer"]');
      assert.equal(JSON.stringify(properties.color.authorizedEditingContracts), '["mycontract1","mycontract2","mycontract3","mycontract4"]');
      assert.equal(properties.level.type, "number");
      assert.equal(properties.level.isReadOnly, false);
      assert.equal(JSON.stringify(properties.level.authorizedEditingAccounts), '["bobbie"]');
      assert.equal(JSON.stringify(properties.level.authorizedEditingContracts), '[]');
      assert.equal(properties.frozen.type, "boolean");
      assert.equal(properties.frozen.isReadOnly, true);
      assert.equal(JSON.stringify(properties.frozen.authorizedEditingAccounts), '["cryptomancer"]');
      assert.equal(JSON.stringify(properties.frozen.authorizedEditingContracts), '[]');
      assert.equal(properties.isFood.type, "boolean");
      assert.equal(properties.isFood.isReadOnly, false);
      assert.equal(JSON.stringify(properties.isFood.authorizedEditingAccounts), '["bobbie"]');
      assert.equal(JSON.stringify(properties.isFood.authorizedEditingContracts), '["mycontract1","mycontract2","mycontract3","mycontract4"]');

      res = await database1.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[0].logs)
      console.log(transactionsBlock2[1].logs)
      console.log(transactionsBlock2[2].logs)
      console.log(transactionsBlock2[3].logs)
      console.log(transactionsBlock2[4].logs)
      console.log(transactionsBlock2[5].logs)
      console.log(transactionsBlock2[6].logs)
      console.log(transactionsBlock2[7].logs)
      console.log(transactionsBlock2[8].logs)
      console.log(transactionsBlock2[9].logs)
      console.log(transactionsBlock2[10].logs)
      console.log(transactionsBlock2[11].logs)

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[3].logs).errors[0], 'invalid name: letters & numbers only, max length of 25');
      assert.equal(JSON.parse(transactionsBlock2[4].logs).errors[0], 'cannot have more than 10 authorized accounts');
      assert.equal(JSON.parse(transactionsBlock2[5].logs).errors[0], 'cannot have more than 10 authorized contracts');
      assert.equal(JSON.parse(transactionsBlock2[6].logs).errors[0], 'invalid account list');
      assert.equal(JSON.parse(transactionsBlock2[7].logs).errors[0], 'invalid contract list');
      assert.equal(JSON.parse(transactionsBlock2[8].logs).errors[0], 'property must exist');
      assert.equal(JSON.parse(transactionsBlock2[9].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(transactionsBlock2[10].logs).errors[0], 'cannot add the same account twice');
      assert.equal(JSON.parse(transactionsBlock2[11].logs).errors[0], 'cannot add the same contract twice');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('adds to the list of authorized issuing contracts', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145392, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145392, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145392, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145392, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145392, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(38145392, 'TXID1235', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["tokens"] }'));
      transactions.push(new Transaction(38145392, 'TXID1236', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["market"] }'));
      transactions.push(new Transaction(38145392, 'TXID1237', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["contract1","contract2"] }'));
      transactions.push(new Transaction(38145392, 'TXID1238', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["contract1","contract2","dice"] }'));
      transactions.push(new Transaction(38145392, 'TXID1239', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": [] }'));

      let block = {
        refSteemBlockNumber: 38145392,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;
      console.log(tokens)

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingContracts), '["tokens","market","contract1","contract2","dice"]');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('adds to the list of authorized issuing accounts', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145392, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145392, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145392, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145392, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145392, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(38145392, 'TXID1235', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["cryptomancer"] }'));
      transactions.push(new Transaction(38145392, 'TXID1236', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["harpagon"] }'));
      transactions.push(new Transaction(38145392, 'TXID1237', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["satoshi","aggroed"] }'));
      transactions.push(new Transaction(38145392, 'TXID1238', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["satoshi","aggroed","marc"] }'));
      transactions.push(new Transaction(38145392, 'TXID1239', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": [] }'));

      let block = {
        refSteemBlockNumber: 38145392,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;
      console.log(tokens)

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer","harpagon","satoshi","aggroed","marc"]');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not add to the list of authorized issuing accounts', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145392, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145392, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145392, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145392, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145392, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(38145392, 'TXID1235', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["acc1","acc2","acc3","acc4","acc5","acc6","acc7"] }'));
      transactions.push(new Transaction(38145392, 'TXID1236', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": false, "symbol": "TSTNFT", "accounts": ["harpagon"] }'));
      transactions.push(new Transaction(38145392, 'TXID1237', 'harpagon', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["satoshi","aggroed"] }'));
      transactions.push(new Transaction(38145392, 'TXID1238', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": [1, 2, 3] }'));
      transactions.push(new Transaction(38145392, 'TXID1239', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": {"account": "aggroed"} }'));
      transactions.push(new Transaction(38145392, 'TXID1240', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["dup1","dup2"," DUP2","dup3"] }'));
      transactions.push(new Transaction(38145392, 'TXID1241', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["acc8","acc9","acc10","acc11"] }'));
      transactions.push(new Transaction(38145392, 'TXID1242', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["a","aggroed"] }'));
      transactions.push(new Transaction(38145392, 'TXID1243', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["tooooooooolooooooooong","aggroed"] }'));

      let block = {
        refSteemBlockNumber: 38145392,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getBlockInfo(1);

      const block1 = res;
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
        database1.close();
        done();
      });
  });

  it('does not add to the list of authorized issuing contracts', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145392, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145392, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145392, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145392, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145392, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(38145392, 'TXID1235', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["acc1","acc2","acc3","acc4","acc5","acc6","acc7"] }'));
      transactions.push(new Transaction(38145392, 'TXID1236', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": false, "symbol": "TSTNFT", "contracts": ["tokens"] }'));
      transactions.push(new Transaction(38145392, 'TXID1237', 'harpagon', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["tokens","market"] }'));
      transactions.push(new Transaction(38145392, 'TXID1238', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": [1, 2, 3] }'));
      transactions.push(new Transaction(38145392, 'TXID1239', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": {"contract": "tokens"} }'));
      transactions.push(new Transaction(38145392, 'TXID1240', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["dup1","dup2"," dup2","dup3"] }'));
      transactions.push(new Transaction(38145392, 'TXID1241', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["acc8","acc9","acc10","acc11"] }'));
      transactions.push(new Transaction(38145392, 'TXID1242', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["a","tokens"] }'));
      transactions.push(new Transaction(38145392, 'TXID1243', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["tooooooooolooooooooooooooooooooooooooooooooooooooooooong","tokens"] }'));

      let block = {
        refSteemBlockNumber: 38145392,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.getBlockInfo(1);

      const block1 = res;
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
      assert.equal(JSON.parse(transactionsBlock[8].logs).errors[0], 'invalid contract list');
      assert.equal(JSON.parse(transactionsBlock[9].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock[10].logs).errors[0], 'cannot add the same contract twice');
      assert.equal(JSON.parse(transactionsBlock[11].logs).errors[0], 'cannot have more than 10 authorized issuing contracts');
      assert.equal(JSON.parse(transactionsBlock[12].logs).errors[0], 'invalid contract list');
      assert.equal(JSON.parse(transactionsBlock[13].logs).errors[0], 'invalid contract list');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('removes from the list of authorized issuing accounts', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145392, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145392, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145392, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145392, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145392, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(38145392, 'TXID1235', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["cryptomancer"] }'));
      transactions.push(new Transaction(38145392, 'TXID1236', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["harpagon"] }'));
      transactions.push(new Transaction(38145392, 'TXID1237', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["satoshi","aggroed"] }'));
      transactions.push(new Transaction(38145392, 'TXID1238', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["satoshi","aggroed","marc"] }'));
      transactions.push(new Transaction(38145392, 'TXID1239', 'cryptomancer', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": [] }'));

      let block = {
        refSteemBlockNumber: 38145392,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer","harpagon","satoshi","aggroed","marc"]');

      transactions = [];
      transactions.push(new Transaction(38145393, 'TXID1240', 'cryptomancer', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["aggroed"] }'));
      transactions.push(new Transaction(38145393, 'TXID1241', 'cryptomancer', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["missingaccount","satoshi","satoshi"," Harpagon "] }'));

      block = {
        refSteemBlockNumber: 38145393,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      tokens = res;
      console.log(tokens)

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer","marc"]');

      transactions = [];
      transactions.push(new Transaction(38145394, 'TXID1242', 'cryptomancer', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["marc","nothere","cryptomancer"] }'));
      transactions.push(new Transaction(38145394, 'TXID1243', 'cryptomancer', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["marc","nothere","cryptomancer"] }'));

      block = {
        refSteemBlockNumber: 38145394,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      tokens = res;
      console.log(tokens)

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '[]');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('removes from the list of authorized issuing contracts', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145394, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145394, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145394, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145394, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145394, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(38145394, 'TXID1235', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["tokens"] }'));
      transactions.push(new Transaction(38145394, 'TXID1236', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["market"] }'));
      transactions.push(new Transaction(38145394, 'TXID1237', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["contract1","contract2"] }'));
      transactions.push(new Transaction(38145394, 'TXID1238', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["contract1","contract2","dice"] }'));
      transactions.push(new Transaction(38145394, 'TXID1239', 'cryptomancer', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": [] }'));

      let block = {
        refSteemBlockNumber: 38145394,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingContracts), '["tokens","market","contract1","contract2","dice"]');

      transactions = [];
      transactions.push(new Transaction(38145395, 'TXID1240', 'cryptomancer', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["dice"] }'));
      transactions.push(new Transaction(38145395, 'TXID1241', 'cryptomancer', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["missingcontract","contract1","contract1"," tokens "] }'));

      block = {
        refSteemBlockNumber: 38145395,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      tokens = res;
      console.log(tokens)

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingContracts), '["market","contract2"]');

      transactions = [];
      transactions.push(new Transaction(38145396, 'TXID1242', 'cryptomancer', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["contract2","nothere","market"] }'));
      transactions.push(new Transaction(38145396, 'TXID1243', 'cryptomancer', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["contract2","nothere","market"] }'));

      block = {
        refSteemBlockNumber: 38145396,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      tokens = res;
      console.log(tokens)

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingContracts), '[]');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not remove from the list of authorized issuing accounts', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145397, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145397, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145397, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145397, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145397, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(38145397, 'TXID1235', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["cryptomancer"] }'));
      transactions.push(new Transaction(38145397, 'TXID1236', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["harpagon"] }'));
      transactions.push(new Transaction(38145397, 'TXID1237', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["satoshi","aggroed"] }'));
      transactions.push(new Transaction(38145397, 'TXID1238', 'cryptomancer', 'nft', 'addAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["satoshi","aggroed","marc"] }'));
      transactions.push(new Transaction(38145397, 'TXID1239', 'cryptomancer', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": [] }'));

      let block = {
        refSteemBlockNumber: 38145397,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer","harpagon","satoshi","aggroed","marc"]');

      transactions = [];
      transactions.push(new Transaction(38145398, 'TXID1240', 'cryptomancer', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": false, "symbol": "TSTNFT", "accounts": ["aggroed"] }'));
      transactions.push(new Transaction(38145398, 'TXID1241', 'cryptomancer', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": { "aggroed": true } }'));
      transactions.push(new Transaction(38145398, 'TXID1242', 'cryptomancer', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["aggroed", 2, 3 ] }'));
      transactions.push(new Transaction(38145398, 'TXID1243', 'harpagon', 'nft', 'removeAuthorizedIssuingAccounts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "accounts": ["aggroed"] }'));

      block = {
        refSteemBlockNumber: 38145398,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      tokens = res;

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingAccounts), '["cryptomancer","harpagon","satoshi","aggroed","marc"]');

      res = await database1.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[0].logs);
      console.log(transactionsBlock2[1].logs);
      console.log(transactionsBlock2[2].logs);
      console.log(transactionsBlock2[3].logs);

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'invalid account list');
      assert.equal(JSON.parse(transactionsBlock2[3].logs).errors[0], 'must be the issuer');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not remove from the list of authorized issuing contracts', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145398, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145398, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145398, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145398, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145398, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));
      transactions.push(new Transaction(38145398, 'TXID1235', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["tokens"] }'));
      transactions.push(new Transaction(38145398, 'TXID1236', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["market"] }'));
      transactions.push(new Transaction(38145398, 'TXID1237', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["contract1","contract2"] }'));
      transactions.push(new Transaction(38145398, 'TXID1238', 'cryptomancer', 'nft', 'addAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["contract1","contract2","dice"] }'));
      transactions.push(new Transaction(38145398, 'TXID1239', 'cryptomancer', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": [] }'));

      let block = {
        refSteemBlockNumber: 38145398,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      let tokens = res;

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingContracts), '["tokens","market","contract1","contract2","dice"]');

      transactions = [];
      transactions.push(new Transaction(38145399, 'TXID1240', 'cryptomancer', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": false, "symbol": "TSTNFT", "contracts": ["tokens"] }'));
      transactions.push(new Transaction(38145399, 'TXID1241', 'cryptomancer', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": { "tokens": true } }'));
      transactions.push(new Transaction(38145399, 'TXID1242', 'cryptomancer', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["tokens", 2, 3 ] }'));
      transactions.push(new Transaction(38145399, 'TXID1243', 'harpagon', 'nft', 'removeAuthorizedIssuingContracts', '{ "isSignedWithActiveKey": true, "symbol": "TSTNFT", "contracts": ["tokens"] }'));

      block = {
        refSteemBlockNumber: 38145399,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.find({
          contract: 'nft',
          table: 'nfts',
          query: {}
        });

      tokens = res;

      assert.equal(JSON.stringify(tokens[0].authorizedIssuingContracts), '["tokens","market","contract1","contract2","dice"]');

      res = await database1.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[0].logs);
      console.log(transactionsBlock2[1].logs);
      console.log(transactionsBlock2[2].logs);
      console.log(transactionsBlock2[3].logs);

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'invalid contract list');
      assert.equal(JSON.parse(transactionsBlock2[3].logs).errors[0], 'must be the issuer');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('updates the product name of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145399, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145399, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145399, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145399, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145399, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "productName":"Pet Rocks", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 38145399,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(38145400, 'TXID1235', 'cryptomancer', 'nft', 'updateProductName', '{ "symbol": "TSTNFT", "productName": "Crypto Rocks" }'));

      block = {
        refSteemBlockNumber: 38145400,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      console.log(token);

      assert.equal(token.name, 'test NFT');
      assert.equal(token.orgName, '');
      assert.equal(token.productName, 'Crypto Rocks');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not update the product name of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145399, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145399, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145399, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145399, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145399, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "productName":"Pet Rocks", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 38145399,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(38145400, 'TXID1235', 'harpagon', 'nft', 'updateProductName', '{ "symbol": "TSTNFT", "name": "Crypto Rocks" }'));
      transactions.push(new Transaction(38145400, 'TXID1236', 'harpagon', 'nft', 'updateProductName', '{ "symbol": "TSTNFT", "productName": "Crypto Rocks" }'));
      transactions.push(new Transaction(38145400, 'TXID1237', 'cryptomancer', 'nft', 'updateProductName', '{ "symbol": "TSTNFT", "productName": "&%^#" }'));
      transactions.push(new Transaction(38145400, 'TXID1238', 'cryptomancer', 'nft', 'updateProductName', '{ "symbol": "TSTNFT", "productName": "toolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolong" }'));

      block = {
        refSteemBlockNumber: 38145400,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      console.log(token);

      assert.equal(token.name, 'test NFT');
      assert.equal(token.orgName, '');
      assert.equal(token.productName, 'Pet Rocks');

      res = await database1.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[0].logs);
      console.log(transactionsBlock2[1].logs);
      console.log(transactionsBlock2[2].logs);
      console.log(transactionsBlock2[3].logs);

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'invalid product name: letters, numbers, whitespaces only, max length of 50');
      assert.equal(JSON.parse(transactionsBlock2[3].logs).errors[0], 'invalid product name: letters, numbers, whitespaces only, max length of 50');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('updates the organization name of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145399, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145399, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145399, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145399, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145399, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "orgName":"Evil Inc", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 38145399,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(38145400, 'TXID1235', 'cryptomancer', 'nft', 'updateOrgName', '{ "symbol": "TSTNFT", "orgName": "Angels R Us" }'));

      block = {
        refSteemBlockNumber: 38145400,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      console.log(token);

      assert.equal(token.name, 'test NFT');
      assert.equal(token.orgName, 'Angels R Us');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not update the organization name of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145399, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145399, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145399, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145399, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145399, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "orgName":"Evil Inc", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 38145399,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(38145400, 'TXID1235', 'harpagon', 'nft', 'updateOrgName', '{ "symbol": "TSTNFT", "name": "Angels R Us" }'));
      transactions.push(new Transaction(38145400, 'TXID1236', 'harpagon', 'nft', 'updateOrgName', '{ "symbol": "TSTNFT", "orgName": "Angels R Us" }'));
      transactions.push(new Transaction(38145400, 'TXID1237', 'cryptomancer', 'nft', 'updateOrgName', '{ "symbol": "TSTNFT", "orgName": "&%^#" }'));
      transactions.push(new Transaction(38145400, 'TXID1238', 'cryptomancer', 'nft', 'updateOrgName', '{ "symbol": "TSTNFT", "orgName": "toolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolong" }'));

      block = {
        refSteemBlockNumber: 38145400,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      console.log(token);

      assert.equal(token.name, 'test NFT');
      assert.equal(token.orgName, 'Evil Inc');

      res = await database1.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[0].logs);
      console.log(transactionsBlock2[1].logs);
      console.log(transactionsBlock2[2].logs);
      console.log(transactionsBlock2[3].logs);

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(transactionsBlock2[2].logs).errors[0], 'invalid org name: letters, numbers, whitespaces only, max length of 50');
      assert.equal(JSON.parse(transactionsBlock2[3].logs).errors[0], 'invalid org name: letters, numbers, whitespaces only, max length of 50');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('updates the name of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145399, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145399, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145399, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145399, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145399, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 38145399,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(38145400, 'TXID1235', 'cryptomancer', 'nft', 'updateName', '{ "symbol": "TSTNFT", "name": "Cool Test NFT" }'));

      block = {
        refSteemBlockNumber: 38145400,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      console.log(token);

      assert.equal(token.name, 'Cool Test NFT');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not update the name of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145399, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145399, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145399, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145399, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145399, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 38145399,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(38145400, 'TXID1235', 'harpagon', 'nft', 'updateName', '{ "symbol": "TSTNFT", "name": "Cool Test NFT" }'));
      transactions.push(new Transaction(38145400, 'TXID1236', 'cryptomancer', 'nft', 'updateName', '{ "symbol": "TSTNFT", "name": "&%^#" }'));
      transactions.push(new Transaction(38145400, 'TXID1237', 'cryptomancer', 'nft', 'updateName', '{ "symbol": "TSTNFT", "name": "toolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolongtoolong" }'));

      block = {
        refSteemBlockNumber: 38145400,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      console.log(token);

      assert.equal(token.name, 'test NFT');

      res = await database1.getBlockInfo(2);

      const block2 = res;
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
        database1.close();
        done();
      });
  });

  it('updates the url of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145400, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145400, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145400, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145400, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145400, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 38145400,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(38145401, 'TXID1235', 'cryptomancer', 'nft', 'updateMetadata', '{"symbol":"TSTNFT", "metadata": { "url": "https://url.token.com", "image":"https://image.token.com"}}'));
      transactions.push(new Transaction(38145401, 'TXID1236', 'cryptomancer', 'nft', 'updateUrl', '{ "symbol": "TSTNFT", "url": "https://new.token.com" }'));

      block = {
        refSteemBlockNumber: 38145401,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      console.log(token);

      assert.equal(JSON.parse(token.metadata).url, 'https://new.token.com');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not update the url of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145401, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145401, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145401, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145401, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145401, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 38145401,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(38145402, 'TXID1235', 'harpagon', 'nft', 'updateUrl', '{ "symbol": "TSTNFT", "url": "https://new.token.com" }'));

      block = {
        refSteemBlockNumber: 38145402,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      console.log(token);

      assert.equal(JSON.parse(token.metadata).url, 'http://mynft.com');

      res = await database1.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[0].logs);

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'must be the issuer');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('updates the metadata of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145402, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145402, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145402, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145402, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145402, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 38145402,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(38145403, 'TXID1235', 'cryptomancer', 'nft', 'updateMetadata', '{"symbol":"TSTNFT", "metadata": { "url": "https://url.token.com", "image":"https://image.token.com"}}'));

      block = {
        refSteemBlockNumber: 38145403,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      console.log(token);

      const metadata = JSON.parse(token.metadata);
      assert.equal(metadata.url, 'https://url.token.com');
      assert.equal(metadata.image, 'https://image.token.com');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not update the metadata of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145403, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145403, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145403, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145403, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145403, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 38145403,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(38145404, 'TXID1235', 'harpagon', 'nft', 'updateMetadata', '{"symbol":"TSTNFT", "metadata": { "url": "https://url.token.com", "image":"https://image.token.com"}}'));

      block = {
        refSteemBlockNumber: 38145404,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      const token = res;
      console.log(token);

      const metadata = JSON.parse(token.metadata);
      assert.equal(metadata.url, 'http://mynft.com');

      res = await database1.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[0].logs);

      assert.equal(JSON.parse(transactionsBlock2[0].logs).errors[0], 'must be the issuer');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('transfers the ownership of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145403, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145403, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145403, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145403, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145403, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 38145403,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      let token = res;

      assert.equal(token.issuer, 'cryptomancer');
      assert.equal(token.symbol, 'TSTNFT');

      transactions = [];
      transactions.push(new Transaction(38145404, 'TXID1235', 'cryptomancer', 'nft', 'transferOwnership', '{ "symbol":"TSTNFT", "to": "satoshi", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 38145404,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      token = res;
      console.log(token)

      assert.equal(token.issuer, 'satoshi');
      assert.equal(token.symbol, 'TSTNFT');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not transfer the ownership of an nft', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145404, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145404, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145404, 'TXID1232', 'steemsc', 'nft', 'updateParams', '{ "nftCreationFee": "5" }'));
      transactions.push(new Transaction(38145404, 'TXID1233', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"5", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145404, 'TXID1234', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey":true, "name":"test NFT", "symbol":"TSTNFT", "url":"http://mynft.com", "maxSupply":"1000" }'));

      let block = {
        refSteemBlockNumber: 38145404,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      let token = res;

      assert.equal(token.issuer, 'cryptomancer');
      assert.equal(token.symbol, 'TSTNFT');

      transactions = [];
      transactions.push(new Transaction(38145405, 'TXID1235', 'harpagon', 'nft', 'transferOwnership', '{ "symbol":"TSTNFT", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(38145405, 'TXID1236', 'cryptomancer', 'nft', 'transferOwnership', '{ "symbol":"TSTNFT", "to": "satoshi", "isSignedWithActiveKey": false }'));
      transactions.push(new Transaction(38145405, 'TXID1237', 'cryptomancer', 'nft', 'transferOwnership', '{ "symbol":"TSTNFT", "to": "s", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 38145405,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'nft',
          table: 'nfts',
          query: {
            symbol: 'TSTNFT'
          }
        });

      token = res;
      console.log(token)

      assert.equal(token.issuer, 'cryptomancer');
      assert.equal(token.symbol, 'TSTNFT');

      res = await database1.getBlockInfo(2);

      const block2 = res;
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
        database1.close();
        done();
      });
  });
});
