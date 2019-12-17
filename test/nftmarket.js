/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const fs = require('fs-extra');
const BigNumber = require('bignumber.js');
const { Base64 } = require('js-base64');
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

// prepare nftmarket contract for deployment
contractCode = fs.readFileSync('./contracts/nftmarket.js');
contractCode = contractCode.toString();
contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, CONSTANTS.UTILITY_TOKEN_SYMBOL);
base64ContractCode = Base64.encode(contractCode);

let nftmarketContractPayload = {
  name: 'nftmarket',
  params: '',
  code: base64ContractCode,
};
console.log(nftmarketContractPayload);

// nftmarket 
describe('nftmarket', function() {
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

  it('enables a market', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(38145386, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, 'TXID1236', 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

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
      console.log(transactionsBlock1[6].logs);

      // check if the market tables were created
      let exists = await database1.tableExists({
        contract: 'nftmarket',
        table: 'TESTsellBook'
      });

      console.log(exists);
      assert.equal(exists, true);

      exists = await database1.tableExists({
        contract: 'nftmarket',
        table: 'TESTopenInterest'
      });

      console.log(exists);
      assert.equal(exists, true);

      exists = await database1.tableExists({
        contract: 'nftmarket',
        table: 'TESTtradesHistory'
      });

      console.log(exists);
      assert.equal(exists, true);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not enable a market', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(38145386, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, 'TXID1236', 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": false, "symbol": "TEST" }'));
      transactions.push(new Transaction(38145386, 'TXID1237', 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "badparam": "error" }'));
      transactions.push(new Transaction(38145386, 'TXID1238', 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "INVALID" }'));
      transactions.push(new Transaction(38145386, 'TXID1239', 'aggroed', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

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
      console.log(transactionsBlock1[6].logs);
      console.log(transactionsBlock1[7].logs);
      console.log(transactionsBlock1[8].logs);
      console.log(transactionsBlock1[9].logs);

      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'must be the issuer');

      // check if the market tables were created
      let exists = await database1.tableExists({
        contract: 'nftmarket',
        table: 'TESTsellBook'
      });

      console.log(exists);
      assert.equal(exists, false);

      exists = await database1.tableExists({
        contract: 'nftmarket',
        table: 'TESTopenInterest'
      });

      console.log(exists);
      assert.equal(exists, false);

      exists = await database1.tableExists({
        contract: 'nftmarket',
        table: 'TESTtradesHistory'
      });

      console.log(exists);
      assert.equal(exists, false);

      // test that market cannot be enabled twice
      transactions = [];
      transactions.push(new Transaction(38145387, 'TXID1240', 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));
      transactions.push(new Transaction(38145387, 'TXID1241', 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      block = {
        refSteemBlockNumber: 38145387,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.getBlockInfo(2);

      const block2 = res;
      const transactionsBlock2 = block2.transactions;
      console.log(transactionsBlock2[1].logs);

      assert.equal(JSON.parse(transactionsBlock2[1].logs).errors[0], 'market already enabled');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('allows buyers to hit many sell orders', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      // setup environment
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(38145386, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, 'TXID1236', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145386, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(38145386, 'TXID1238', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      for (let i = 39; i < 39+50; i += 1) {
        const txId = 'TXID12' + i.toString();
        const accountNum = i - 39;
        const accountName = 'account' + accountNum.toString();
        transactions.push(new Transaction(38145386, txId, 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "properties": {"level":${i-38}, "color": "red"}, "to":"${accountName}", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      }
      transactions.push(new Transaction(38145386, 'TXID1289', 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      let block = {
        refSteemBlockNumber: 38145386,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // do 50 sell orders (the maximum allowed)
      transactions = [];
      for (let i = 90; i < 90+50; i += 1) {
        const txId = 'TXID12' + i.toString();
        const accountNum = i - 90;
        const accountName = 'account' + accountNum.toString();
        transactions.push(new Transaction(38145387, txId, accountName, 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol":"TEST", "nfts": ["${i-89}"], "price": "0.1", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 100 }`));
      }

      block = {
        refSteemBlockNumber: 38145387,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // check if the NFT instances were sent to the market
      let instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 50);

      instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'cryptomancer' }
      });

      assert.equal(instances.length, 0);

      // check if orders were created
      let orders = await database1.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      assert.equal(orders.length, 50);

      // check that open interest was recorded
      openInterest = await database1.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });

      assert.equal(openInterest.length, 50);
      assert.equal(openInterest[0].count, 1);

      // now buy all the orders
      transactions = [];
      transactions.push(new Transaction(38145388, 'TXID12140', 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50"] }'));

      block = {
        refSteemBlockNumber: 38145388,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // check if the NFT instances were sent to the buyer
      instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 0);

      instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'cryptomancer' }
      });

      assert.equal(instances.length, 50);

      // check if orders have been removed
      orders = await database1.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });
      console.log(orders);
      assert.equal(orders.length, 0);

      // check that payment + fees were subtracted from buyer's account
      let balances = await database1.find({
        contract: 'tokens',
        table: 'balances',
        query: { account: 'cryptomancer' }
      });
      console.log(balances);
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '175.00000000');

      // check that fees were sent to market account
      balances = await database1.find({
        contract: 'tokens',
        table: 'balances',
        query: { account: 'peakmonsters' }
      });
      console.log(balances);
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '0.05000000');

      // check that payments were sent to sellers
      for (let i = 0; i < 50; i += 1) {
        const accountName = 'account' + i.toString();
        balances = await database1.find({
          contract: 'tokens',
          table: 'balances',
          query: { account: accountName }
        });
        assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
        assert.equal(balances[0].balance, '0.09900000');
        assert.equal(balances[0].account, accountName);
      }

      // check that open interest was recorded
      openInterest = await database1.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });

      console.log(openInterest);
      assert.equal(openInterest.length, 50);
      assert.equal(openInterest[0].count, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not allow buyers to hit sell orders', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      // setup environment
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(38145386, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"yabapmatt", "quantity":"3.14158999", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1236', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(38145386, 'TXID1237', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, 'TXID1238', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145386, 'TXID1239', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(38145386, 'TXID1240', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      transactions.push(new Transaction(38145386, 'TXID1241', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1242', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1243', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1244', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1245', 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      // do a few sell orders
      transactions.push(new Transaction(38145386, 'TXID1246', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3"], "price": "3.14159", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(38145386, 'TXID1247', 'marc', 'nftmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["4"], "price": "8.000", "priceSymbol": "TKN", "fee": 500 }'));

      // all these buys should fail
      transactions.push(new Transaction(38145386, 'TXID1248', 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "BUSTED", "nfts": ["1","2","3","4"] }'));
      transactions.push(new Transaction(38145386, 'TXID1249', 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": false, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["1","2","3","4"] }'));
      transactions.push(new Transaction(38145386, 'TXID1250', 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "nfts": ["1","2","3","4"] }'));
      transactions.push(new Transaction(38145386, 'TXID1251', 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3","4"] }'));
      transactions.push(new Transaction(38145386, 'TXID1252', 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonstersssssssssssssssssssssssssssssssssssssssssssss", "symbol": "TEST", "nfts": ["1","2","3","4"] }'));
      transactions.push(new Transaction(38145386, 'TXID1253', 'aggroed', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["1","2","3","4"] }'));
      transactions.push(new Transaction(38145386, 'TXID1254', 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["1","2","3","4"] }'));
      transactions.push(new Transaction(38145386, 'TXID1255', 'yabapmatt', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["1"] }'));
      transactions.push(new Transaction(38145386, 'TXID1256', 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50","51"] }'));

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
      console.log(transactionsBlock1[18].logs);
      console.log(transactionsBlock1[19].logs);
      console.log(transactionsBlock1[20].logs);
      console.log(transactionsBlock1[21].logs);
      console.log(transactionsBlock1[22].logs);
      console.log(transactionsBlock1[23].logs);
      console.log(transactionsBlock1[24].logs);
      console.log(transactionsBlock1[25].logs);
      console.log(transactionsBlock1[26].logs);

      assert.equal(JSON.parse(transactionsBlock1[18].logs).errors[0], 'market not enabled for symbol');
      assert.equal(JSON.parse(transactionsBlock1[19].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[20].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[21].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[22].logs).errors[0], 'invalid market account');
      assert.equal(JSON.parse(transactionsBlock1[23].logs).errors[0], 'cannot fill your own orders');
      assert.equal(JSON.parse(transactionsBlock1[24].logs).errors[0], 'all orders must have the same price symbol');
      assert.equal(JSON.parse(transactionsBlock1[25].logs).errors[0], 'you must have enough tokens for payment');
      assert.equal(JSON.parse(transactionsBlock1[26].logs).errors[0], 'cannot act on more than 50 IDs at once');

      // check if the NFT instances are still owned by the market
      let instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: { "$in" : ["aggroed","marc","cryptomancer"] } }
      });

      assert.equal(instances.length, 0);

      instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 4);

      // check if orders still exist
      let orders = await database1.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });
      console.log(orders);
      assert.equal(orders.length, 4);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('allows buyers to hit sell orders', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      // setup environment
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(38145386, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, 'TXID1236', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145386, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(38145386, 'TXID1238', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      transactions.push(new Transaction(38145386, 'TXID1239', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1240', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1241', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1242', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1243', 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      // do a few sell orders
      transactions.push(new Transaction(38145386, 'TXID1244', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3"], "price": "3.14159", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(38145386, 'TXID1245', 'marc', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["4"], "price": "8.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));

      // now buy the orders
      transactions.push(new Transaction(38145386, 'TXID1246', 'cryptomancer', 'nftmarket', 'buy', '{ "isSignedWithActiveKey": true, "marketAccount": "peakmonsters", "symbol": "TEST", "nfts": ["1","2","2","3","4","4"] }'));

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
      console.log(transactionsBlock1[16].logs);

      // check if the NFT instances were sent to the buyer
      let instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: { "$in" : ["aggroed","marc","nftmarket"] } }
      });

      assert.equal(instances.length, 0);

      instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'cryptomancer' }
      });

      assert.equal(instances.length, 4);

      // check if orders have been removed
      let orders = await database1.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });
      console.log(orders);
      assert.equal(orders.length, 0);

      // check that payment + fees were subtracted from buyer's account
      let balances = await database1.find({
        contract: 'tokens',
        table: 'balances',
        query: { account: 'cryptomancer' }
      });
      console.log(balances);
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '176.37523000');

      // check that fees were sent to market account
      balances = await database1.find({
        contract: 'tokens',
        table: 'balances',
        query: { account: 'peakmonsters' }
      });
      console.log(balances);
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '0.87123850');

      // check that payments were sent to sellers
      balances = await database1.find({
        contract: 'tokens',
        table: 'balances',
        query: { account: { "$in" : ["aggroed","marc"] } }
      });
      console.log(balances);
      assert.equal(balances[0].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[0].balance, '8.95353150');
      assert.equal(balances[0].account, 'aggroed');
      assert.equal(balances[1].symbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(balances[1].balance, '7.60000000');
      assert.equal(balances[1].account, 'marc');

      // check that trade history table was updated
      let history = await database1.find({
        contract: 'nftmarket',
        table: 'TESTtradesHistory',
        query: {}
      });
      console.log(history);
      assert.equal(history.length, 1);
      console.log(history[0].counterparties);

      // check that open interest was recorded
      openInterest = await database1.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });

      console.log(openInterest);
      assert.equal(openInterest.length, 1);
      assert.equal(openInterest[0].count, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('changes the price of sell orders', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      // setup environment
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(38145386, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, 'TXID1236', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145386, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(38145386, 'TXID1238', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      transactions.push(new Transaction(38145386, 'TXID1239', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1240', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1241', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1242', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1243', 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      // do a few sell orders
      transactions.push(new Transaction(38145386, 'TXID1244', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3"], "price": "3.14159", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(38145386, 'TXID1245', 'marc', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["4"], "price": "8.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));

      // change the price on some orders
      transactions.push(new Transaction(38145386, 'TXID1246', 'aggroed', 'nftmarket', 'changePrice', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","2","2","5","5"], "price": "15.666" }`));

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
      console.log(transactionsBlock1[16].logs);

      // check if the NFT instances were sent to the market
      let instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: { "$in" : ["aggroed","marc"] } }
      });

      console.log(instances);
      assert.equal(instances.length, 0);

      instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      console.log(instances);
      assert.equal(instances.length, 4);

      // check if orders have the correct price
      let orders = await database1.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      console.log(orders);
      assert.equal(orders.length, 4);
      assert.equal(orders[0].account, 'aggroed');
      assert.equal(orders[0].ownedBy, 'u');
      assert.equal(orders[0].nftId, '1');
      assert.equal(orders[0].price, '15.66600000');
      assert.equal(orders[0].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(orders[0].timestamp, 1527811200000);
      assert.equal(orders[0].fee, 500);
      assert.equal(orders[1].account, 'aggroed');
      assert.equal(orders[1].ownedBy, 'u');
      assert.equal(orders[1].nftId, '2');
      assert.equal(orders[1].price, '15.66600000');
      assert.equal(orders[1].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(orders[1].timestamp, 1527811200000);
      assert.equal(orders[1].fee, 500);
      assert.equal(orders[2].account, 'aggroed');
      assert.equal(orders[2].ownedBy, 'u');
      assert.equal(orders[2].nftId, '3');
      assert.equal(orders[2].price, '3.14159000');
      assert.equal(orders[2].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(orders[2].timestamp, 1527811200000);
      assert.equal(orders[2].fee, 500);
      assert.equal(orders[3].account, 'marc');
      assert.equal(orders[3].ownedBy, 'u');
      assert.equal(orders[3].nftId, '4');
      assert.equal(orders[3].price, '8.00000000');
      assert.equal(orders[3].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(orders[3].timestamp, 1527811200000);
      assert.equal(orders[3].fee, 500);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not change the price of sell orders', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      // setup environment
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(38145386, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));
      transactions.push(new Transaction(38145386, 'TXID1236', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145386, 'TXID1238', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(38145386, 'TXID1239', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      transactions.push(new Transaction(38145386, 'TXID1240', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1241', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1242', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1243', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1244', 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      // do a few sell orders
      transactions.push(new Transaction(38145386, 'TXID1245', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2"], "price": "3.14159", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(38145386, 'TXID1246', 'aggroed', 'nftmarket', 'sell', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["3"], "price": "5.123", "priceSymbol": "TKN", "fee": 500 }'));
      transactions.push(new Transaction(38145386, 'TXID1247', 'marc', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["4"], "price": "8.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));

      // try to change the price on some orders - these should all fail
      transactions.push(new Transaction(38145386, 'TXID1248', 'aggroed', 'nftmarket', 'changePrice', '{ "isSignedWithActiveKey": true, "symbol": "INVALID", "nfts": ["1","2"], "price": "15.666" }'));
      transactions.push(new Transaction(38145386, 'TXID1249', 'aggroed', 'nftmarket', 'changePrice', '{ "isSignedWithActiveKey": false, "symbol": "TEST", "nfts": ["1","2"], "price": "15.666" }'));
      transactions.push(new Transaction(38145386, 'TXID1250', 'aggroed', 'nftmarket', 'changePrice', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50","51"], "price": "15.666" }'));
      transactions.push(new Transaction(38145386, 'TXID1251', 'aggroed', 'nftmarket', 'changePrice', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "price": "15.666" }'));
      transactions.push(new Transaction(38145386, 'TXID1252', 'aggroed', 'nftmarket', 'changePrice', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1",2], "price": "15.666" }'));
      transactions.push(new Transaction(38145386, 'TXID1253', 'aggroed', 'nftmarket', 'changePrice', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2"], "price": 15.666 }'));
      transactions.push(new Transaction(38145386, 'TXID1254', 'aggroed', 'nftmarket', 'changePrice', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2"], "price": "15.6666666666666666666666" }'));
      transactions.push(new Transaction(38145386, 'TXID1255', 'aggroed', 'nftmarket', 'changePrice', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3"], "price": "15.666" }'));
      transactions.push(new Transaction(38145386, 'TXID1256', 'aggroed', 'nftmarket', 'changePrice', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","4"], "price": "15.666" }'));

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
      console.log(transactionsBlock1[18].logs);
      console.log(transactionsBlock1[19].logs);
      console.log(transactionsBlock1[20].logs);
      console.log(transactionsBlock1[21].logs);
      console.log(transactionsBlock1[22].logs);
      console.log(transactionsBlock1[23].logs);
      console.log(transactionsBlock1[24].logs);
      console.log(transactionsBlock1[25].logs);
      console.log(transactionsBlock1[26].logs);

      assert.equal(JSON.parse(transactionsBlock1[18].logs).errors[0], 'market not enabled for symbol');
      assert.equal(JSON.parse(transactionsBlock1[19].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[20].logs).errors[0], 'cannot act on more than 50 IDs at once');
      assert.equal(JSON.parse(transactionsBlock1[21].logs).errors[0], 'invalid id list');
      assert.equal(JSON.parse(transactionsBlock1[22].logs).errors[0], 'invalid id list');
      assert.equal(JSON.parse(transactionsBlock1[23].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[24].logs).errors[0], 'invalid price');
      assert.equal(JSON.parse(transactionsBlock1[25].logs).errors[0], 'all orders must have the same price symbol');
      assert.equal(JSON.parse(transactionsBlock1[26].logs).errors[0], 'all orders must be your own');

      // check if the NFT instances were sent to the market
      let instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: { "$in" : ["aggroed","marc"] } }
      });

      assert.equal(instances.length, 0);

      instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 4);

      // check if orders have the correct price
      let orders = await database1.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      console.log(orders);
      assert.equal(orders.length, 4);
      assert.equal(orders[0].account, 'aggroed');
      assert.equal(orders[0].ownedBy, 'u');
      assert.equal(orders[0].nftId, '1');
      assert.equal(orders[0].price, '3.14159000');
      assert.equal(orders[0].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(orders[0].timestamp, 1527811200000);
      assert.equal(orders[0].fee, 500);
      assert.equal(orders[1].account, 'aggroed');
      assert.equal(orders[1].ownedBy, 'u');
      assert.equal(orders[1].nftId, '2');
      assert.equal(orders[1].price, '3.14159000');
      assert.equal(orders[1].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(orders[1].timestamp, 1527811200000);
      assert.equal(orders[1].fee, 500);
      assert.equal(orders[2].account, 'aggroed');
      assert.equal(orders[2].ownedBy, 'u');
      assert.equal(orders[2].nftId, '3');
      assert.equal(orders[2].price, '5.123');
      assert.equal(orders[2].priceSymbol, 'TKN');
      assert.equal(orders[2].timestamp, 1527811200000);
      assert.equal(orders[2].fee, 500);
      assert.equal(orders[3].account, 'marc');
      assert.equal(orders[3].ownedBy, 'u');
      assert.equal(orders[3].nftId, '4');
      assert.equal(orders[3].price, '8.00000000');
      assert.equal(orders[3].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(orders[3].timestamp, 1527811200000);
      assert.equal(orders[3].fee, 500);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not cancel sell orders', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      // setup environment
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(38145386, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, 'TXID1236', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145386, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(38145386, 'TXID1238', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      transactions.push(new Transaction(38145386, 'TXID1239', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1240', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1241', 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      // do a couple sell orders
      transactions.push(new Transaction(38145386, 'TXID1242', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(38145386, 'TXID1243', 'marc', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["2"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));

      // try to cancel the orders - all of these should fail
      transactions.push(new Transaction(38145386, 'TXID1244', 'aggroed', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": true, "symbol": "INVALID", "nfts": ["1"] }'));
      transactions.push(new Transaction(38145386, 'TXID1245', 'aggroed', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": false, "symbol": "TEST", "nfts": ["1"] }'));
      transactions.push(new Transaction(38145386, 'TXID1246', 'aggroed', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50","51"] }'));
      transactions.push(new Transaction(38145386, 'TXID1247', 'aggroed', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": {"id": "1"} }'));
      transactions.push(new Transaction(38145386, 'TXID1248', 'aggroed', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","notanumber"] }'));
      transactions.push(new Transaction(38145386, 'TXID1249', 'aggroed', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": true, "nfts": ["1"] }'));
      transactions.push(new Transaction(38145386, 'TXID1250', 'aggroed', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2"] }'));

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
      console.log(transactionsBlock1[14].logs);
      console.log(transactionsBlock1[15].logs);
      console.log(transactionsBlock1[16].logs);
      console.log(transactionsBlock1[17].logs);
      console.log(transactionsBlock1[18].logs);
      console.log(transactionsBlock1[19].logs);
      console.log(transactionsBlock1[20].logs);

      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'market not enabled for symbol');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'cannot act on more than 50 IDs at once');
      assert.equal(JSON.parse(transactionsBlock1[17].logs).errors[0], 'invalid id list');
      assert.equal(JSON.parse(transactionsBlock1[18].logs).errors[0], 'invalid id list');
      assert.equal(JSON.parse(transactionsBlock1[19].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[20].logs).errors[0], 'all orders must be your own');

      // check if the NFT instances were sent to the market
      let instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: { "$in" : ["aggroed","marc"] } }
      });

      assert.equal(instances.length, 0);

      instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 2);

      // verify no orders were canceled
      let orders = await database1.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      assert.equal(orders.length, 2);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('cancels multiple sell orders', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      // setup environment
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(38145386, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, 'TXID1236', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145386, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(38145386, 'TXID1238', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      for (let i = 39; i < 39+50; i += 1) {
        const txId = 'TXID12' + i.toString();
        transactions.push(new Transaction(38145386, txId, 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      }
      transactions.push(new Transaction(38145386, 'TXID1289', 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      let block = {
        refSteemBlockNumber: 38145386,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // do 50 sell orders (the maximum allowed)
      transactions = [];
      transactions.push(new Transaction(38145387, 'TXID1290', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));

      block = {
        refSteemBlockNumber: 38145387,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // check if the NFT instances were sent to the market
      let instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'aggroed' }
      });

      assert.equal(instances.length, 0);

      instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 50);

      // check if orders were created
      let orders = await database1.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      assert.equal(orders.length, 50);

      // now cancel all the orders
      transactions = [];
      transactions.push(new Transaction(38145388, 'TXID1291', 'aggroed', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50"] }'));

      block = {
        refSteemBlockNumber: 38145388,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // check if the NFT instances were sent back to the owner
      instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'aggroed' }
      });

      assert.equal(instances.length, 50);

      instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 0);

      // check if orders were removed
      orders = await database1.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      assert.equal(orders.length, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('cancels a sell order', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      // setup environment
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(38145386, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, 'TXID1236', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145386, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(38145386, 'TXID1238', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      transactions.push(new Transaction(38145386, 'TXID1239', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1240', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1241', 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      // do a couple sell orders
      transactions.push(new Transaction(38145386, 'TXID1242', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));

      let block = {
        refSteemBlockNumber: 38145386,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // check if the NFT instances were sent to the market
      let instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'aggroed' }
      });

      assert.equal(instances.length, 0);

      instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 2);

      // check if orders were created
      let orders = await database1.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      assert.equal(orders.length, 2);

      // check that open interest was recorded
      let openInterest = await database1.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });

      console.log(openInterest);
      assert.equal(openInterest.length, 1);
      assert.equal(openInterest[0].count, 2);

      // cancel an order
      transactions = [];
      transactions.push(new Transaction(38145387, 'TXID1243', 'aggroed', 'nftmarket', 'cancel', '{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["5", "500", "1"] }'));

      block = {
        refSteemBlockNumber: 38145387,
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

      // check if the NFT instances were sent back to the user who placed the order
      instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'aggroed' }
      });

      assert.equal(instances.length, 1);

      instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 1);

      // check if orders were removed
      orders = await database1.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      assert.equal(orders.length, 1);
      console.log(orders);

      // check that open interest was recorded
      openInterest = await database1.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });

      console.log(openInterest);
      assert.equal(openInterest.length, 1);
      assert.equal(openInterest[0].count, 1);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('creates a sell order', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      // setup environment
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(38145386, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, 'TXID1236', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145386, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(38145386, 'TXID1238', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"isRare", "type":"boolean" }'));
      transactions.push(new Transaction(38145386, 'TXID1239', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","isRare"] }'));
      transactions.push(new Transaction(38145386, 'TXID1240', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      transactions.push(new Transaction(38145386, 'TXID1241', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"marc", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));      
      transactions.push(new Transaction(38145386, 'TXID1242', 'cryptomancer', 'nft', 'setProperties', '{ "symbol":"TEST", "nfts": [{"id":"1", "properties": {"level":3, "color":"red", "isRare": true}}] }'));
      transactions.push(new Transaction(38145386, 'TXID1243', 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));

      // do a sell order
      transactions.push(new Transaction(38145386, 'TXID1244', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","1","2"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));

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
      console.log(transactionsBlock1[14].logs);

      // check if the NFT instances were sent to the market
      let instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'aggroed' }
      });

      console.log(instances);
      assert.equal(instances.length, 0);

      instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      console.log(instances);
      assert.equal(instances.length, 1);

      // check if orders were created
      let orders = await database1.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      console.log(orders);
      assert.equal(orders.length, 1);
      assert.equal(orders[0].account, 'aggroed');
      assert.equal(orders[0].ownedBy, 'u');
      assert.equal(JSON.stringify(orders[0].grouping), '{"level":"3","isRare":"true"}');
      assert.equal(orders[0].nftId, '1');
      assert.equal(orders[0].price, '2.00000000');
      assert.equal(orders[0].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
      assert.equal(orders[0].timestamp, 1527811200000);
      assert.equal(orders[0].fee, 500);

      // check that open interest was recorded
      let openInterest = await database1.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });

      console.log(openInterest);
      assert.equal(openInterest.length, 1);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not create a sell order', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      // setup environment
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(38145386, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, 'TXID1236', 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));

      // all sell orders below here should fail      
      transactions.push(new Transaction(38145386, 'TXID1237', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(38145386, 'TXID1238', 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));
      transactions.push(new Transaction(38145386, 'TXID1239', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": false, "symbol": "TEST", "nfts": ["1"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(38145386, 'TXID1240', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50","51"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(38145386, 'TXID1241', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "price": "2.123456789123456789", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(38145386, 'TXID1242', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145386, 'TXID1243', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(38145386, 'TXID1244', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      transactions.push(new Transaction(38145386, 'TXID1245', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "price": "2.123456789123456789", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(38145386, 'TXID1246', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "price": "notanumber", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(38145386, 'TXID1247', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 10001 }`));
      transactions.push(new Transaction(38145386, 'TXID1248', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "price": "2.000", "priceSymbol": "INVALID", "fee": 500 }`));
      transactions.push(new Transaction(38145386, 'TXID1249', 'marc', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(38145386, 'TXID1250', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "NOEXIST", "nfts": ["1"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(38145386, 'TXID1251', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "nfts": ["1"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));
      transactions.push(new Transaction(38145386, 'TXID1252', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["notanumber"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));

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
      console.log(transactionsBlock1[7].logs);
      console.log(transactionsBlock1[9].logs);
      console.log(transactionsBlock1[10].logs);
      console.log(transactionsBlock1[11].logs);
      console.log(transactionsBlock1[15].logs);
      console.log(transactionsBlock1[16].logs);
      console.log(transactionsBlock1[17].logs);
      console.log(transactionsBlock1[18].logs);
      console.log(transactionsBlock1[19].logs);
      console.log(transactionsBlock1[20].logs);
      console.log(transactionsBlock1[21].logs);
      console.log(transactionsBlock1[22].logs);

      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'market not enabled for symbol');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'cannot sell more than 50 NFT instances at once');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'market grouping not set');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[0], 'invalid price');
      assert.equal(JSON.parse(transactionsBlock1[16].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[17].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[18].logs).errors[0], 'invalid price');
      assert.equal(JSON.parse(transactionsBlock1[20].logs).errors[0], 'market not enabled for symbol');
      assert.equal(JSON.parse(transactionsBlock1[21].logs).errors[0], 'invalid params');
      assert.equal(JSON.parse(transactionsBlock1[22].logs).errors[0], 'invalid nft list');

      // make sure no tokens were sent to the market
      instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 0);

      // verify no orders were created
      let orders = await database1.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      assert.equal(orders.length, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('creates multiple sell orders', (done) => {
    new Promise(async (resolve) => {

      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      // setup environment
      transactions.push(new Transaction(38145386, 'TXID1230', 'steemsc', 'contract', 'update', JSON.stringify(tknContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1231', 'steemsc', 'contract', 'deploy', JSON.stringify(nftContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(nftmarketContractPayload)));
      transactions.push(new Transaction(38145386, 'TXID1233', 'steemsc', 'nft', 'updateParams', `{ "nftCreationFee": "5", "nftIssuanceFee": {"${CONSTANTS.UTILITY_TOKEN_SYMBOL}":"0.1"}, "dataPropertyCreationFee": "1" }`));
      transactions.push(new Transaction(38145386, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to":"cryptomancer", "quantity":"200", "isSignedWithActiveKey":true }`));
      transactions.push(new Transaction(38145386, 'TXID1235', 'cryptomancer', 'nft', 'create', '{ "isSignedWithActiveKey": true, "name":"test NFT", "symbol":"TEST", "url":"http://mynft.com" }'));
      transactions.push(new Transaction(38145386, 'TXID1236', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"color", "type":"string" }'));
      transactions.push(new Transaction(38145386, 'TXID1237', 'cryptomancer', 'nft', 'addProperty', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "name":"level", "type":"number" }'));
      transactions.push(new Transaction(38145386, 'TXID1238', 'cryptomancer', 'nft', 'setGroupBy', '{ "isSignedWithActiveKey":true, "symbol":"TEST", "properties": ["level","color"] }'));
      for (let i = 39; i < 39+50; i += 1) {
        const txId = 'TXID12' + i.toString();
        transactions.push(new Transaction(38145386, txId, 'cryptomancer', 'nft', 'issue', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "to":"aggroed", "feeSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}" }`));
      }
      for (let i = 89; i < 89+50; i += 1) {
        const txId = 'TXID12' + i.toString();
        transactions.push(new Transaction(38145386, txId, 'cryptomancer', 'nft', 'setProperties', `{ "symbol":"TEST", "nfts": [{"id":"${i-88}", "properties": {"level":${i-88}}}] }`));
      }
      transactions.push(new Transaction(38145386, 'TXID12139', 'cryptomancer', 'nftmarket', 'enableMarket', '{ "isSignedWithActiveKey": true, "symbol": "TEST" }'));
      
      let block = {
        refSteemBlockNumber: 38145386,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // do 50 sell orders (the maximum allowed)
      transactions = [];
      transactions.push(new Transaction(38145387, 'TXID12140', 'aggroed', 'nftmarket', 'sell', `{ "isSignedWithActiveKey": true, "symbol": "TEST", "nfts": ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50"], "price": "2.000", "priceSymbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "fee": 500 }`));

      block = {
        refSteemBlockNumber: 38145387,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // check if the NFT instances were sent to the market
      let instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'aggroed' }
      });

      assert.equal(instances.length, 0);

      instances = await database1.find({
        contract: 'nft',
        table: 'TESTinstances',
        query: { account: 'nftmarket' }
      });

      assert.equal(instances.length, 50);

      // check if orders were created
      let orders = await database1.find({
        contract: 'nftmarket',
        table: 'TESTsellBook',
        query: {}
      });

      assert.equal(orders.length, 50);
      for (let j = 0; j < 50; j += 1) {
        const nftId = j + 1;
        assert.equal(orders[j].account, 'aggroed');
        assert.equal(orders[j].ownedBy, 'u');
        assert.equal(JSON.stringify(orders[j].grouping), `{"level":"${nftId}","color":""}`);
        assert.equal(orders[j].nftId, nftId.toString());
        assert.equal(orders[j].price, '2.00000000');
        assert.equal(orders[j].priceSymbol, `${CONSTANTS.UTILITY_TOKEN_SYMBOL}`);
        assert.equal(orders[j].timestamp, 1527811200000);
        assert.equal(orders[j].fee, 500);
      }

      // check that open interest was recorded
      let openInterest = await database1.find({
        contract: 'nftmarket',
        table: 'TESTopenInterest',
        query: {}
      });

      console.log(openInterest);
      assert.equal(openInterest.length, 50);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });
});
