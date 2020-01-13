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

// tokens
describe('Tokens smart contract', function () {
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

  it('creates a token', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": "0.001" }'));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'sscstore', 'buy', '{ "recipient": "steemsc", "amountSTEEMSBD": "0.001 STEEM", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        });

      const token = res;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.name, 'token');
      assert.equal(JSON.parse(token.metadata).url, 'https://token.com');
      assert.equal(token.maxSupply, 1000);
      assert.equal(token.supply, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('generates error when trying to create a token with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID12341', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "T.KN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12342', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKNNNNNNNNN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12343', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 3.3, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123445', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": -1, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12344', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 9, "maxSupply": "1000", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12345', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "-2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12346', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "&é", "symbol": "TKN", "precision": 8, "maxSupply": "-2", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12347', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "qsdqsdqsdqsqsdqsdqsdqsdqsdsdqsdqsdqsdqsdqsdqsdqsdqsd", "symbol": "TKN", "precision": 8, "maxSupply": "-2", "isSignedWithActiveKey": true }'));

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

      assert.equal(JSON.parse(transactionsBlock1[2].logs).errors[0], 'invalid symbol: uppercase letters only, max length of 10');
      assert.equal(JSON.parse(transactionsBlock1[3].logs).errors[0], 'invalid symbol: uppercase letters only, max length of 10');
      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'invalid precision');
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'invalid precision');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'invalid precision');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'maxSupply must be positive');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'invalid name: letters, numbers, whitespaces only, max length of 50');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'invalid name: letters, numbers, whitespaces only, max length of 50');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('updates the url of a token', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(30896501, 'TXID1236', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": 0.001 }'));
      transactions.push(new Transaction(30896501, 'TXID1235', 'harpagon', 'sscstore', 'buy', '{ "recipient": "steemsc", "amountSTEEMSBD": "0.001 STEEM", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30896501, 'TXID1234', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));

      let block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(30896502, 'TXID1237', 'harpagon', 'tokens', 'updateUrl', '{ "symbol": "TKN", "url": "https://new.token.com" }'));

      block = {
        refSteemBlockNumber: 30896502,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        });

      const token = res;

      assert.equal(JSON.parse(token.metadata).url, 'https://new.token.com');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not update the url of a token', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(30896501, 'TXID1236', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": 0.001 }'));
      transactions.push(new Transaction(30896501, 'TXID1235', 'harpagon', 'sscstore', 'buy', '{ "recipient": "steemsc", "amountSTEEMSBD": "0.001 STEEM", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30896501, 'TXID1234', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));

      let block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(30896502, 'TXID1237', 'satoshi', 'tokens', 'updateUrl', '{ "symbol": "TKN", "url": "https://new.token.com" }'));

      block = {
        refSteemBlockNumber: 30896502,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        });

      const token = res;

      assert.equal(JSON.parse(token.metadata).url, 'https://token.com');

      res = await database1.getBlockInfo(2);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[0].logs).errors[0], 'must be the issuer');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('updates the metadata of a token', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(30896501, 'TXID1236', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": 0.001 }'));
      transactions.push(new Transaction(30896501, 'TXID1235', 'harpagon', 'sscstore', 'buy', '{ "recipient": "steemsc", "amountSTEEMSBD": "0.001 STEEM", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30896501, 'TXID1234', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));

      let block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(30896502, 'TXID1237', 'harpagon', 'tokens', 'updateMetadata', '{"symbol":"TKN", "metadata": { "url": "https://url.token.com", "image":"https://image.token.com"}}'));

      block = {
        refSteemBlockNumber: 30896502,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        });

      const token = res;

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

  it('transfers the ownership of a token', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(30896501, 'TXID1236', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": 0.001 }'));
      transactions.push(new Transaction(30896501, 'TXID1235', 'harpagon', 'sscstore', 'buy', '{ "recipient": "steemsc", "amountSTEEMSBD": "0.001 STEEM", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30896501, 'TXID1234', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));

      let block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        });

      let token = res;

      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.symbol, 'TKN');

      transactions = [];
      transactions.push(new Transaction(30896502, 'TXID1237', 'harpagon', 'tokens', 'transferOwnership', '{ "symbol":"TKN", "to": "satoshi", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 30896502,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        });

      token = res;

      assert.equal(token.issuer, 'satoshi');
      assert.equal(token.symbol, 'TKN');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('does not transfer the ownership of a token', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(30896501, 'TXID1236', 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": 0.001 }'));
      transactions.push(new Transaction(30896501, 'TXID1235', 'harpagon', 'sscstore', 'buy', '{ "recipient": "steemsc", "amountSTEEMSBD": "0.001 STEEM", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(30896501, 'TXID1234', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "url": "https://token.com", "symbol": "TKN", "precision": 3, "maxSupply": "1000", "isSignedWithActiveKey": true  }'));

      let block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        });

      let token = res;

      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.symbol, 'TKN');

      transactions = [];
      transactions.push(new Transaction(30896502, 'TXID1237', 'satoshi', 'tokens', 'transferOwnership', '{ "symbol":"TKN", "to": "satoshi", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 30896502,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        });

      token = res;

      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.symbol, 'TKN');

      res = await database1.getBlockInfo(2);

      const block1 = res;
      const transactionsBlock1 = block1.transactions;

      assert.equal(JSON.parse(transactionsBlock1[0].logs).errors[0], 'must be the issuer');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('issues tokens', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 0, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // check if the tokens have been accounted as supplied
      let res = await database1.findOne({
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: "TKN"
          }
        });

      const token = res;

      assert.equal(token.supply, 100);

      // check if the "to" received the tokens
      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: "TKN"
          }
        });

      const balance = res;

      assert.equal(balance.balance, 100);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('generates error when trying to issue tokens with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 0, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'issue', '{ "symbol": "NTK", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100.1", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12310', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "-100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12311', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "1001", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12312', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "1000", "to": "az", "isSignedWithActiveKey": true }'));

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

      assert.equal(JSON.parse(transactionsBlock1[3].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'not allowed to issue tokens');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'must issue positive quantity');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'quantity exceeds available supply');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'invalid to');

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
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": "3e-8", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": "0.1", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'harpagon', 'tokens', 'create', `{ "isSignedWithActiveKey": true, "name": "token", "symbol": "NTK", "precision": 8, "maxSupply": "${Number.MAX_SAFE_INTEGER}" }`));
      transactions.push(new Transaction(12345678901, 'TXID12310', 'harpagon', 'tokens', 'issue', `{ "symbol": "NTK", "quantity": "${Number.MAX_SAFE_INTEGER}", "to": "satoshi", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID12311', 'satoshi', 'tokens', 'transfer', '{ "symbol": "NTK", "quantity": "0.00000001", "to": "vitalik", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: "TKN"
          }
        });

      const balancesatoshi = res;

      assert.equal(balancesatoshi.balance, 99.89999997);

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'vitalik',
            symbol: "TKN"
          }
        });

      const balancevitalik = res;

      assert.equal(balancevitalik.balance, 0.10000003);

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: "NTK"
          }
        });

      const balNTKsatoshi = res;

      assert.equal(balNTKsatoshi.balance, BigNumber(Number.MAX_SAFE_INTEGER).minus("0.00000001").toFixed(8));

      res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'vitalik',
            symbol: "NTK"
          }
        });

      const balNTKvitalik = res;

      assert.equal(balNTKvitalik.balance, "0.00000001");

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('generates errors when trying to transfer tokens with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 0, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": "7.99999999", "to": "vitalik" }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": "7.99999999", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": "7.99999999", "to": "aa", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12310', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TNK", "quantity": "7.99999999", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12311', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": "7.999999999", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123612', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": "-1", "to": "vitalik", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123613', 'vitalik', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": "101", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123614', 'satoshi', 'tokens', 'transfer', '{ "symbol": "TKN", "quantity": "101", "to": "vitalik", "isSignedWithActiveKey": true }'));

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

      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'cannot transfer to self');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'must transfer positive quantity');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'balance does not exist');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'overdrawn balance');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('transfers tokens to a contract', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      const smartContractCode = `
        actions.createSSC = function (payload) {
          // Initialize the smart contract via the create action
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testContract',
        params: '',
        code: base64SmartContractCode,
      };

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(30896501, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));

      let block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(12345678902, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678902, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, 'TXID1237', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "7.99999999", "to": "testContract", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678902,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.findOne({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: "TKN"
          }
        });

      const balancesatoshi = res;

      assert.equal(balancesatoshi.balance, 92.00000001);

      res = await database1.findOne({
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            account: 'testContract',
            symbol: "TKN"
          }
        });

      const testContract = res;

      assert.equal(testContract.balance, 7.99999999);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('generates errors when trying to transfer tokens to a contract with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 0, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "7.99999999", "to": "testContract" }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "7.99999999", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "7.99999999", "to": "ah", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12310', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TNK", "quantity": "7.99999999", "to": "testContract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12311', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "7.999999999", "to": "testContract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12312', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "-1", "to": "testContract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12313', 'vitalik', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "101", "to": "testContract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12314', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "101", "to": "testContract", "isSignedWithActiveKey": true }'));

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

      assert.equal(JSON.parse(transactionsBlock1[4].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'cannot transfer to self');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'must transfer positive quantity');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'balance does not exist');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'overdrawn balance');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('transfers tokens from a contract to a user', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      const smartContractCode = `
        actions.createSSC = function (payload) {
          // Initialize the smart contract via the create action
        }

        actions.sendRewards = async function (payload) {
          const { to, quantity } = payload;
          await api.transferTokens(to, 'TKN', quantity, 'user');
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testContract',
        params: '',
        code: base64SmartContractCode,
      };

      let transactions = [];
      transactions.push(new Transaction(12345678902, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678902, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));

      let block = {
        refSteemBlockNumber: 12345678902,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(12345678903, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678903, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678903, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678903, 'TXID1237', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "7.99999999", "to": "testContract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678903, 'TXID1238', 'satoshi', 'testContract', 'sendRewards', '{ "quantity": "5.99999999", "to": "vitalik", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678903,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: { $in: ['satoshi', 'vitalik'] },
            symbol: "TKN"
          }
        });

      const balances = res;

      assert.equal(balances[0].balance, 92.00000001);
      assert.equal(balances[1].balance, 5.99999999);

      res = await database1.findOne({
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            account: 'testContract',
            symbol: "TKN"
          }
        });

      const testContract = res;

      assert.equal(testContract.balance, 2);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('generates errors when trying to transfer tokens from a contract to a user with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      const smartContractCode = `
        actions.createSSC = async function (payload) {
          // Initialize the smart contract via the create action
        }

        actions.notSigned = async function (payload) {
          await api.transferTokens('to', 'TKN', '2.02', 'user');
        }

        actions.toNotExist = async function (payload) {
          await api.transferTokens('df', 'TKN', '2.02', 'user');
        }

        actions.symbolNotExist = async function (payload) {
          await api.transferTokens('satoshi', 'TNK', '2.02', 'user');
        }

        actions.wrongPrecision = async function (payload) {
          await api.transferTokens('satoshi', 'TKN', '2.02', 'user');
        }

        actions.negativeQty = async function (payload) {
          await api.transferTokens('satoshi', 'TKN', '-2', 'user');
        }

        actions.balanceNotExist = async function (payload) {
          await api.transferTokens('satoshi', 'TKN', '2', 'user');
        }

        actions.overdrawnBalance = async function (payload) {
          await api.transferTokens('satoshi', 'TKN', '2', 'user');
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testContract',
        params: '',
        code: base64SmartContractCode,
      };

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 0, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'testContract', 'notSigned', '{ }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'testContract', 'toNotExist', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'testContract', 'symbolNotExist', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12310', 'satoshi', 'testContract', 'wrongPrecision', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123611', 'satoshi', 'testContract', 'negativeQty', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123612', 'satoshi', 'testContract', 'balanceNotExist', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123713', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "1", "to": "testContract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123614', 'satoshi', 'testContract', 'overdrawnBalance', '{ "isSignedWithActiveKey": true }'));

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

      assert.equal(JSON.parse(transactionsBlock1[5].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'must transfer positive quantity');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'balance does not exist');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'overdrawn balance');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('transfers tokens from a contract to a contract', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      const smartContractCode = `
        actions.createSSC = function (payload) {
          // Initialize the smart contract via the create action
        }

        actions.sendRewards = async function (payload) {
          const { to, quantity } = payload;
          await api.transferTokens(to, 'TKN', quantity, 'contract');
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testContract',
        params: '',
        code: base64SmartContractCode,
      };

      const smartContractCode2 = `
        actions.createSSC = function (payload) {
          // Initialize the smart contract via the create action
        }
      `;

      const base64SmartContractCode2 = Base64.encode(smartContractCode2);

      const contractPayload2 = {
        name: 'testContract2',
        params: '',
        code: base64SmartContractCode2,
      };

      let transactions = [];
      transactions.push(new Transaction(12345678901, '123', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(30896501, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(30896501, 'TXID1233', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload2)));

      let block = {
        refSteemBlockNumber: 30896501,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(12345678902, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678902, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678902, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, 'TXID1237', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "7.99999999", "to": "testContract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678902, 'TXID1238', 'satoshi', 'testContract', 'sendRewards', '{ "quantity": "5.99999999", "to": "testContract2", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678902,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await database1.find({
          contract: 'tokens',
          table: 'balances',
          query: {
            account: { $in: ['satoshi'] },
            symbol: "TKN"
          }
        });

      const balances = res;

      assert.equal(balances[0].balance, 92.00000001);

      res = await database1.find({
          contract: 'tokens',
          table: 'contractsBalances',
          query: {
            symbol: "TKN"
          }
        });

      const contractsBalances = res;

      assert.equal(contractsBalances[0].balance, 2);
      assert.equal(contractsBalances[1].balance, 5.99999999);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });

  it('generates errors when trying to transfer tokens from a contract to another contract with wrong parameters', (done) => {
    new Promise(async (resolve) => {
      
      await loadPlugin(blockchain);
      database1 = new Database();
      await database1.init(conf.databaseURL, conf.databaseName);

      const smartContractCode = `
        actions.createSSC = async function (payload) {
          // Initialize the smart contract via the create action
        }

        actions.notSigned = async function (payload) {
          await api.transferTokens('to', 'TKN', '2.02', 'contract');
        }

        actions.notToSelf = async function (payload) {
          await api.transferTokens('testContract', 'TKN', '2.02', 'contract');
        }

        actions.toNotExist = async function (payload) {
          await api.transferTokens('sd', 'TKN', '2.02', 'contract');
        }

        actions.symbolNotExist = async function (payload) {
          await api.transferTokens('testContract2', 'TNK', '2.02', 'contract');
        }

        actions.wrongPrecision = async function (payload) {
          await api.transferTokens('testContract2', 'TKN', '2.02', 'contract');
        }

        actions.negativeQty = async function (payload) {
          await api.transferTokens('testContract2', 'TKN', '-2', 'contract');
        }

        actions.balanceNotExist = async function (payload) {
          await api.transferTokens('testContract2', 'TKN', '2', 'contract');
        }

        actions.overdrawnBalance = async function (payload) {
          await api.transferTokens('testContract2', 'TKN', '2', 'contract');
        }

        actions.invalidParams = async function (payload) {
          await api.transferTokens('testContract2', 'TKN', '2', 'invalid');
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testContract',
        params: '',
        code: base64SmartContractCode,
      };

      const smartContractCode2 = `
        actions.createSSC = function (payload) {
          // Initialize the smart contract via the create action
        }
      `;

      const base64SmartContractCode2 = Base64.encode(smartContractCode2);

      const contractPayload2 = {
        name: 'testContract2',
        params: '',
        code: base64SmartContractCode2,
      };

      let transactions = [];
      transactions.push(new Transaction(12345678901, '456', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload2)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "isSignedWithActiveKey": true,  "name": "token", "symbol": "TKN", "precision": 0, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'testContract', 'notSigned', '{ }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'testContract', 'notToSelf', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'testContract', 'toNotExist', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123610', 'satoshi', 'testContract', 'symbolNotExist', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123611', 'satoshi', 'testContract', 'wrongPrecision', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123612', 'satoshi', 'testContract', 'negativeQty', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123613', 'satoshi', 'testContract', 'balanceNotExist', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123714', 'satoshi', 'tokens', 'transferToContract', '{ "symbol": "TKN", "quantity": "1", "to": "testContract", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123615', 'satoshi', 'testContract', 'overdrawnBalance', '{ "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123616', 'satoshi', 'testContract', 'invalidParams', '{ "isSignedWithActiveKey": true }'));

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

      assert.equal(JSON.parse(transactionsBlock1[6].logs).errors[0], 'you must use a custom_json signed with your active key');
      assert.equal(JSON.parse(transactionsBlock1[7].logs).errors[0], 'cannot transfer to self');
      assert.equal(JSON.parse(transactionsBlock1[8].logs).errors[0], 'invalid to');
      assert.equal(JSON.parse(transactionsBlock1[9].logs).errors[0], 'symbol does not exist');
      assert.equal(JSON.parse(transactionsBlock1[10].logs).errors[0], 'symbol precision mismatch');
      assert.equal(JSON.parse(transactionsBlock1[11].logs).errors[0], 'must transfer positive quantity');
      assert.equal(JSON.parse(transactionsBlock1[12].logs).errors[0], 'balance does not exist');
      assert.equal(JSON.parse(transactionsBlock1[14].logs).errors[0], 'overdrawn balance');
      assert.equal(JSON.parse(transactionsBlock1[15].logs).errors[0], 'invalid params');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        database1.close();
        done();
      });
  });
});
