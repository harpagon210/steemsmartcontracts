/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const { Base64 } = require('js-base64');
const fs = require('fs-extra');
const { MongoClient } = require('mongodb');

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
  databaseURL: "mongodb://localhost:27017",
  databaseName: "testssc",
};

let plugins = {};
let jobs = new Map();
let currentJobId = 0;

function cleanDataFolder() {
  fs.emptyDirSync(conf.dataDirectory);
}

async function cleanDatabase() {
  const client = await MongoClient.connect(conf.databaseURL, { useNewUrlParser: true });
  let db = await client.db(conf.databaseName);
  db.dropDatabase();
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

let client;
let db;

// Database
describe('Database', function() {
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

  it('should get the genesis block', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });
      const res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GET_BLOCK_INFO, payload: 0 });

      assert.equal(res.payload.blockNumber, 0);
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should get the latest block', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', ''));

      let block = new Block(
        '2018-06-01T00:00:00',
        0,
        '',
        '',
        transactions,
        123456788,
        'PREV_HASH',
      );

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.ADD_BLOCK, payload: block });

      transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1235', 'steemsc', 'contract', 'deploy', ''));

      block = new Block(
        '2018-06-01T00:00:00',
        0,
        '',
        '',
        transactions,
        123456789,
        'PREV_HASH',
      );

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.ADD_BLOCK, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO });
      assert.equal(res.payload.blockNumber, 123456790);
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
});

// smart contracts
describe('Smart Contracts', function () {
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

  it('should deploy a basic smart contract', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

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
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_CONTRACT, payload: { name: 'testContract' } });
      const contract = res.payload;

      assert.equal(contract._id, 'testContract');
      assert.equal(contract.owner, 'steemsc');
      resolve()
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should create a table during the smart contract deployment', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          await api.db.createTable('testTable');
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testContract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_CONTRACT, payload: { name: 'testContract' } });
      const contract = res.payload;

      assert.notEqual(contract.tables['testContract_testTable'], undefined);

      /*
      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GET_TABLE_DETAILS, payload: { contract: 'testContract', table: 'testTable' } });

      assert.notEqual(res.payload, null);
      */

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it.skip('should create a table with indexes during the smart contract deployment', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          await api.db.createTable('testTable', ['index1', 'index2']);
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testContract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GET_TABLE_DETAILS, payload: { contract: 'testContract', table: 'testTable' } });
      const table = res.payload;
      const { binaryIndices } = table;

      assert.notEqual(binaryIndices['index1'], undefined);
      assert.notEqual(binaryIndices['index2'], undefined);
      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should add a record into a smart contract table', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          await api.db.createTable('users');
        }

        actions.addUser = async (payload) => {
          const newUser = {
            'id': api.sender
          };

          await api.db.insert('users', newUser);
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'usersContract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'steemsc', 'usersContract', 'addUser', ''));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: 'usersContract', table: 'users', query: { "id": "steemsc" } } });
      const user = res.payload;

      assert.equal(user.id, 'steemsc');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should update a record from a smart contract table', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          await api.db.createTable('users');
        }

        actions.addUser = async (payload) => {
          const newUser = {
            'id': api.sender,
            'username': api.sender
          };

          await api.db.insert('users', newUser);
        }

        actions.updateUser = async (payload) => {
          const { username } = payload;
          
          let user = await api.db.findOne('users', { 'id': api.sender });

          user.username = username;

          await api.db.update('users', user);
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'usersContract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'steemsc', 'usersContract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'usersContract', 'updateUser', '{ "username": "MyUsernameUpdated" }'));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: 'usersContract', table: 'users', query: { "id": "steemsc" } } });
      const user = res.payload;

      assert.equal(user.id, 'steemsc');
      assert.equal(user.username, 'MyUsernameUpdated');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should remove a record from a smart contract table', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          await api.db.createTable('users');
        }

        actions.addUser = async (payload) => {
          const newUser = {
            'id': api.sender,
            'username': api.sender
          };

          await api.db.insert('users', newUser);
        }

        actions.removeUser = async (payload) => {
          let user = await api.db.findOne('users', { 'id': api.sender });

          await api.db.remove('users', user);
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'usersContract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'steemsc', 'usersContract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'usersContract', 'removeUser', ''));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: 'usersContract', table: 'users', query: { "id": "steemsc" } } });
      const user = res.payload;

      assert.equal(user, null);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should read the records from a smart contract table via pagination', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          await api.db.createTable('users');
        }

        actions.addUser = async (payload) => {
          const newUser = {
            'id': api.sender,
            'username': api.sender
          };

          await api.db.insert('users', newUser);
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'usersContract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'steemsc', 'usersContract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc1', 'usersContract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1237', 'steemsc2', 'usersContract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1238', 'steemsc3', 'usersContract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1239', 'steemsc4', 'usersContract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID12310', 'steemsc5', 'usersContract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID12311', 'steemsc6', 'usersContract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID12312', 'steemsc7', 'usersContract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID12313', 'steemsc8', 'usersContract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID12314', 'steemsc9', 'usersContract', 'addUser', ''));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let payload = {
        contract: 'usersContract',
        table: 'users',
        query: {},
        limit: 5
      };

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND, payload });
      let users = res.payload;

      assert.equal(users[0]._id, 1);
      assert.equal(users[4]._id, 5);

      payload = {
        contract: 'usersContract',
        table: 'users',
        query: {},
        limit: 5,
        offset: 5,
      };

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND, payload });
      users = res.payload;

      assert.equal(users[0]._id, 6);
      assert.equal(users[4]._id, 10);

      payload = {
        contract: 'usersContract',
        table: 'users',
        query: {},
        limit: 5,
        offset: 10,
      };

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND, payload });
      users = res.payload;

      assert.equal(users.length, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should read the records from a smart contract table using an index ascending', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          await api.db.createTable('users', ['age']);
        }

        actions.addUser = async (payload) => {
          const { age } = payload;

          const newUser = {
            'id': api.sender,
            age
          };

          await api.db.insert('users', newUser);
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'usersContract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'steemsc', 'usersContract', 'addUser', '{ "age": 2 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc1', 'usersContract', 'addUser', '{ "age": 10 }'));
      transactions.push(new Transaction(123456789, 'TXID1237', 'steemsc2', 'usersContract', 'addUser', '{ "age": 3 }'));
      transactions.push(new Transaction(123456789, 'TXID1238', 'steemsc3', 'usersContract', 'addUser', '{ "age": 199 }'));
      transactions.push(new Transaction(123456789, 'TXID1239', 'steemsc4', 'usersContract', 'addUser', '{ "age": 200 }'));
      transactions.push(new Transaction(123456789, 'TXID12310', 'steemsc5', 'usersContract', 'addUser', '{ "age": 1 }'));
      transactions.push(new Transaction(123456789, 'TXID12311', 'steemsc6', 'usersContract', 'addUser', '{ "age": 89 }'));
      transactions.push(new Transaction(123456789, 'TXID12312', 'steemsc7', 'usersContract', 'addUser', '{ "age": 2 }'));
      transactions.push(new Transaction(123456789, 'TXID12313', 'steemsc8', 'usersContract', 'addUser', '{ "age": 34 }'));
      transactions.push(new Transaction(123456789, 'TXID12314', 'steemsc9', 'usersContract', 'addUser', '{ "age": 20 }'));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let payload = {
        contract: 'usersContract',
        table: 'users',
        query: {},
        limit: 5,
        offset: 0,
        indexes: [{ index: 'age', descending: false }],
      };

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND, payload });
      let users = res.payload;

      assert.equal(users[0]._id, 6);
      assert.equal(users[4]._id, 2);

      payload = {
        contract: 'usersContract',
        table: 'users',
        query: {},
        limit: 5,
        offset: 5,
        indexes: [{ index: 'age', descending: false }],
      };

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND, payload });
      users = res.payload;

      assert.equal(users[0]._id, 10);
      assert.equal(users[4]._id, 5);

      payload = {
        contract: 'usersContract',
        table: 'users',
        query: {},
        limit: 5,
        offset: 10,
        indexes: [{ index: 'age', descending: false }],
      };

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND, payload });
      users = res.payload;

      assert.equal(users.length, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should read the records from a smart contract table using an index descending', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          await api.db.createTable('users', ['age']);
        }

        actions.addUser = async (payload) => {
          const { age } = payload;

          const newUser = {
            'id': api.sender,
            age
          };

          await api.db.insert('users', newUser);
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'usersContract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'steemsc', 'usersContract', 'addUser', '{ "age": 2 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc1', 'usersContract', 'addUser', '{ "age": 10 }'));
      transactions.push(new Transaction(123456789, 'TXID1237', 'steemsc2', 'usersContract', 'addUser', '{ "age": 3 }'));
      transactions.push(new Transaction(123456789, 'TXID1238', 'steemsc3', 'usersContract', 'addUser', '{ "age": 199 }'));
      transactions.push(new Transaction(123456789, 'TXID1239', 'steemsc4', 'usersContract', 'addUser', '{ "age": 200 }'));
      transactions.push(new Transaction(123456789, 'TXID12310', 'steemsc5', 'usersContract', 'addUser', '{ "age": 1 }'));
      transactions.push(new Transaction(123456789, 'TXID12311', 'steemsc6', 'usersContract', 'addUser', '{ "age": 89 }'));
      transactions.push(new Transaction(123456789, 'TXID12312', 'steemsc7', 'usersContract', 'addUser', '{ "age": 2 }'));
      transactions.push(new Transaction(123456789, 'TXID12313', 'steemsc8', 'usersContract', 'addUser', '{ "age": 34 }'));
      transactions.push(new Transaction(123456789, 'TXID12314', 'steemsc9', 'usersContract', 'addUser', '{ "age": 20 }'));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let payload = {
        contract: 'usersContract',
        table: 'users',
        query: {},
        limit: 5,
        indexes: [{ index: 'age', descending: true }],
      };

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND, payload });
      let users = res.payload;

      assert.equal(users[0]._id, 5);
      assert.equal(users[4]._id, 10);

      payload = {
        contract: 'usersContract',
        table: 'users',
        query: {},
        limit: 5,
        offset: 5,
        indexes: [{ index: 'age', descending: true }],
      };

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND, payload });
      users = res.payload;

      assert.equal(users[0]._id, 2);
      assert.equal(users[4]._id, 6);

      payload = {
        contract: 'usersContract',
        table: 'users',
        query: {},
        limit: 5,
        offset: 10,
        indexes: [{ index: 'age', descending: true }],
      };

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND, payload });
      users = res.payload;

      assert.equal(users.length, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should allow only the owner of the smart contract to perform certain actions', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          await api.db.createTable('users');
        }

        actions.addUser = async (payload) => {
          if (api.sender !== api.owner) return;

          const { userId } = payload;
  
          const newUser = {
            'id': userId
          };

          await api.db.insert('users', newUser);
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'usersContract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Dan', 'usersContract', 'addUser', '{ "userId": "Dan" }'));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: 'usersContract', table: 'users', query: { "id": "Dan" } } });
      let user = res.payload;

      assert.equal(user, null);

      transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'usersContract', 'addUser', '{ "userId": "Dan" }'));

      block = {
        refSteemBlockNumber: 123456789,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:03',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: 'usersContract', table: 'users', query: { "id": "Dan" } } });
      user = res.payload;

      assert.equal(user.id, "Dan");

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should perform a search in a smart contract table from another smart contract', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const usersSmartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          await api.db.createTable('users');
        }

        actions.addUser = async (payload) => {
          const newUser = {
            'id': api.sender,
            'username': api.sender
          };

          await api.db.insert('users', newUser);
        }
      `;

      const booksSmartContractCode = `
      actions.createSSC = async (payload) => {
        // Initialize the smart contract via the create action
        await api.db.createTable('books');
      }
      
      actions.addBook = async (payload) => {

        const { title } = payload;

        let user = await api.db.findOneInTable('usersContract', 'users', { "id": api.sender });

        if (user) {
          const newBook = {
            'userId': user.id,
            title
          };
  
          await api.db.insert('books', newBook);
        }
      }
    `;

      const base64UsersSmartContractCode = Base64.encode(usersSmartContractCode);
      const base64BooksSmartContractCode = Base64.encode(booksSmartContractCode);

      const usersContractPayload = {
        name: 'usersContract',
        params: '',
        code: base64UsersSmartContractCode,
      };

      const booksContractPayload = {
        name: 'booksContract',
        params: '',
        code: base64BooksSmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1233', 'steemsc', 'contract', 'deploy', JSON.stringify(usersContractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', JSON.stringify(booksContractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'steemsc', 'usersContract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'booksContract', 'addBook', '{ "title": "The Awesome Book" }'));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: 'booksContract', table: 'books', query: { "userId": "steemsc" } } });
      const book = res.payload;

      assert.equal(book.title, "The Awesome Book");

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should execute a smart contract from another smart contract', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const usersSmartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          await api.db.createTable('users');
        }

        actions.addUser = async (payload) => {
          const newUser = {
            'id': api.sender,
            'username': api.sender
          };

          const user = await api.db.insert('users', newUser);

          await api.executeSmartContract('booksContract', 'addBook', { "title": "The Awesome Book" })
        }
      `;

      const booksSmartContractCode = `
      actions.createSSC = async (payload) => {
        // Initialize the smart contract via the create action
        await api.db.createTable('books');
      }
      
      actions.addBook = async (payload) => {
        const { title } = payload;
        
        let user = await api.db.findOneInTable('usersContract', 'users', { "id": api.sender });

        if (user) {
          const newBook = {
            'userId': user.id,
            title
          };

          const book = await api.db.insert('books', newBook);
        }
      }
    `;

      const base64UsersSmartContractCode = Base64.encode(usersSmartContractCode);
      const base64BooksSmartContractCode = Base64.encode(booksSmartContractCode);

      const usersContractPayload = {
        name: 'usersContract',
        params: '',
        code: base64UsersSmartContractCode,
      };

      const booksContractPayload = {
        name: 'booksContract',
        params: '',
        code: base64BooksSmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1233', 'steemsc', 'contract', 'deploy', JSON.stringify(usersContractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', JSON.stringify(booksContractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'steemsc', 'usersContract', 'addUser', ''));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: 'booksContract', table: 'books', query: { "userId": "steemsc" } } });
      const book = res.payload;

      assert.equal(book.title, "The Awesome Book");

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should emit an event from a smart contract', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = function (payload) {
          // Initialize the smart contract via the create action
          api.emit('contract_create', { "contractName": "testContract" })
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testContract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO });
      const latestBlock = res.payload;

      const txs = latestBlock.transactions.filter(transaction => transaction.transactionId === 'TXID1234');

      const logs = JSON.parse(txs[0].logs);

      assert.equal(logs.events[0].event, 'contract_create');
      assert.equal(logs.events[0].data.contractName, 'testContract');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should emit an event from another smart contract', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const usersSmartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
        }

        actions.addUser = async (payload) => {
          await api.executeSmartContract('booksContract', 'addBook', { })
        }
      `;

      const booksSmartContractCode = `
      actions.createSSC = async (payload) => {
        // Initialize the smart contract via the create action
      }
      
      actions.addBook = async (payload) => {
        api.emit('contract_create', { "contractName": "testContract" });
      }
    `;

      const base64UsersSmartContractCode = Base64.encode(usersSmartContractCode);
      const base64BooksSmartContractCode = Base64.encode(booksSmartContractCode);

      const usersContractPayload = {
        name: 'usersContract',
        params: '',
        code: base64UsersSmartContractCode,
      };

      const booksContractPayload = {
        name: 'booksContract',
        params: '',
        code: base64BooksSmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1233', 'steemsc', 'contract', 'deploy', JSON.stringify(usersContractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', JSON.stringify(booksContractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'steemsc', 'usersContract', 'addUser', ''));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO });
      const latestBlock = res.payload;

      const txs = latestBlock.transactions.filter(transaction => transaction.transactionId === 'TXID1235');

      const logs = JSON.parse(txs[0].logs);

      assert.equal(logs.events[0].event, 'contract_create');
      assert.equal(logs.events[0].data.contractName, 'testContract');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });


  it('should log an error during the deployment of a smart contract if an error is thrown', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          
          THIS CODE CRASHES :)
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testContract',
        params: '',
        code: base64SmartContractCode,
      };

      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO });
      const latestBlock = res.payload;

      const txs = latestBlock.transactions.filter(transaction => transaction.transactionId === 'TXID1234');

      const logs = JSON.parse(txs[0].logs);

      assert.equal(logs.errors[0], "SyntaxError: Unexpected identifier");

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should log an error during the execution of a smart contract if an error is thrown', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
        }

        actions.addUser = async (payload) => {
          let test = test.crash
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'testContract',
        params: '',
        code: base64SmartContractCode,
      };

      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'steemsc', 'testContract', 'addUser', ''));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO });
      const latestBlock = res.payload;

      const txs = latestBlock.transactions.filter(transaction => transaction.transactionId === 'TXID1235');

      const logs = JSON.parse(txs[0].logs);

      assert.equal(logs.errors[0], "ReferenceError: test is not defined");

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should log an error from another smart contract', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const usersSmartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
        }

        actions.addUser = async (payload) => {
          await api.executeSmartContract('booksContract', 'addBook', { })
        }
      `;

      const booksSmartContractCode = `
      actions.createSSC = async (payload) => {
        // Initialize the smart contract via the create action
      }
      
      actions.addBook = async (payload) => {
        let test = test.crash
      }
    `;

      const base64UsersSmartContractCode = Base64.encode(usersSmartContractCode);
      const base64BooksSmartContractCode = Base64.encode(booksSmartContractCode);

      const usersContractPayload = {
        name: 'usersContract',
        params: '',
        code: base64UsersSmartContractCode,
      };

      const booksContractPayload = {
        name: 'booksContract',
        params: '',
        code: base64BooksSmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1233', 'steemsc', 'contract', 'deploy', JSON.stringify(usersContractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', JSON.stringify(booksContractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'steemsc', 'usersContract', 'addUser', ''));

      let block = {
        refSteemBlockNumber: 1,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO });
      const latestBlock = res.payload;

      const txs = latestBlock.transactions.filter(transaction => transaction.transactionId === 'TXID1235');

      const logs = JSON.parse(txs[0].logs);

      assert.equal(logs.errors[0], "ReferenceError: test is not defined");

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should generate random numbers in a deterministic way', (done) => {
    new Promise(async (resolve) => {
      

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
        }

        actions.generateRandomNumbers = async (payload) => {
          let generatedRandom = api.random();

          api.emit('random_generated', { generatedRandom })

          generatedRandom = api.random();

          api.emit('random_generated', { generatedRandom })
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'random',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'steemsc', 'random', 'generateRandomNumbers', ''));

      let block = {
        refSteemBlockNumber: 123456789,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO });
      let latestBlock = res.payload;

      let txs = latestBlock.transactions.filter(transaction => transaction.transactionId === 'TXID1235');

      let logs = JSON.parse(txs[0].logs);

      assert.equal(logs.events[0].event, 'random_generated');
      assert.equal(logs.events[0].data.generatedRandom, 0.04779785670324099);
      assert.equal(logs.events[1].event, 'random_generated');
      assert.equal(logs.events[1].data.generatedRandom, 0.8219068960473853);

      transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1236', 'steemsc', 'random', 'generateRandomNumbers', ''));

      block = {
        refSteemBlockNumber: 123456789,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO });
      latestBlock = res.payload;

      txs = latestBlock.transactions.filter(transaction => transaction.transactionId === 'TXID1236');

      logs = JSON.parse(txs[0].logs);

      assert.equal(logs.events[0].event, 'random_generated');
      assert.equal(logs.events[0].data.generatedRandom, 0.02979556650325206);
      assert.equal(logs.events[1].event, 'random_generated');
      assert.equal(logs.events[1].data.generatedRandom, 0.8985215841304178);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });
});
