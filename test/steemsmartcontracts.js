/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const { Base64 } = require('js-base64');
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

// Database
describe('Database', () => {

  it('should get the genesis block', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

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
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', ''));

      let block = new Block(
        '2018-06-01T00:00:00',
        transactions,
        123456788,
        'PREV_HASH',
      );

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.ADD_BLOCK, payload: block });

      transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', ''));

      block = new Block(
        '2018-06-01T00:00:00',
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
describe('Smart Contracts', () => {
  it('should deploy a basic smart contract', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

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
        name: 'test_contract',
        params: '',
        code: base64SmartContractCode,
      };

      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      const res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_CONTRACT, payload: { name: 'test_contract' } });
      const contract = res.payload;

      assert.equal(contract.name, 'test_contract');
      assert.equal(contract.owner, 'Harpagon');
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
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          await db.createTable('test_table');
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'test_contract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_CONTRACT, payload: { name: 'test_contract' } });
      const contract = res.payload;
      
      assert.equal(contract.tables.includes('test_contract_test_table'), true);

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GET_TABLE_DETAILS, payload: { contract: 'test_contract', table: 'test_table'} });
      
      assert.notEqual(res.payload, null);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should create a table with indexes during the smart contract deployment', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          await db.createTable('test_table', ['index1', 'index2']);
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'test_contract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GET_TABLE_DETAILS, payload: { contract: 'test_contract', table: 'test_table'} });
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
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          await db.createTable('users');
        }

        actions.addUser = async (payload) => {
          const newUser = {
            'id': sender
          };

          await db.insert('users', newUser);
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'users_contract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', ''));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: 'users_contract', table: 'users', query: { "id": "Harpagon" }} });
      const user = res.payload;

      assert.equal(user.id, 'Harpagon');

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
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          await db.createTable('users');
        }

        actions.addUser = async (payload) => {
          const newUser = {
            'id': sender,
            'username': sender
          };

          await db.insert('users', newUser);
        }

        actions.updateUser = async (payload) => {
          const { username } = payload;
          
          let user = await db.findOne('users', { 'id': sender });

          user.username = username;

          await db.update('users', user);
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'users_contract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon', 'users_contract', 'updateUser', '{ "username": "MyUsernameUpdated" }'));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: 'users_contract', table: 'users', query: { "id": "Harpagon" }} });
      const user = res.payload;

      assert.equal(user.id, 'Harpagon');
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
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          await db.createTable('users');
        }

        actions.addUser = async (payload) => {
          const newUser = {
            'id': sender,
            'username': sender
          };

          await db.insert('users', newUser);
        }

        actions.removeUser = async (payload) => {
          let user = await db.findOne('users', { 'id': sender });

          await db.remove('users', user);
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'users_contract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon', 'users_contract', 'removeUser', ''));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: 'users_contract', table: 'users', query: { "id": "Harpagon" }} });
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
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          await db.createTable('users');
        }

        actions.addUser = async (payload) => {
          const newUser = {
            'id': sender,
            'username': sender
          };

          await db.insert('users', newUser);
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'users_contract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon1', 'users_contract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon2', 'users_contract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon3', 'users_contract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon4', 'users_contract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon5', 'users_contract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon6', 'users_contract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon7', 'users_contract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon8', 'users_contract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon9', 'users_contract', 'addUser', ''));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      let payload = { 
        contract: 'users_contract',
        table: 'users',
        query: { },
        limit: 5
      };

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND, payload });
      let users = res.payload;

      assert.equal(users[0].$loki, 1);
      assert.equal(users[4].$loki, 5);

      payload = { 
        contract: 'users_contract',
        table: 'users',
        query: { },
        limit: 5,
        offset: 5,
      };

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND, payload });
      users = res.payload;

      assert.equal(users[0].$loki, 6);
      assert.equal(users[4].$loki, 10);

      payload = { 
        contract: 'users_contract',
        table: 'users',
        query: { },
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
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          await db.createTable('users', ['age']);
        }

        actions.addUser = async (payload) => {
          const { age } = payload;

          const newUser = {
            'id': sender,
            age
          };

          await db.insert('users', newUser);
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'users_contract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', '{ "age": 2 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon1', 'users_contract', 'addUser', '{ "age": 10 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon2', 'users_contract', 'addUser', '{ "age": 3 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon3', 'users_contract', 'addUser', '{ "age": 199 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon4', 'users_contract', 'addUser', '{ "age": 200 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon5', 'users_contract', 'addUser', '{ "age": 1 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon6', 'users_contract', 'addUser', '{ "age": 89 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon7', 'users_contract', 'addUser', '{ "age": 2 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon8', 'users_contract', 'addUser', '{ "age": 34 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon9', 'users_contract', 'addUser', '{ "age": 20 }'));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      let payload = { 
        contract: 'users_contract',
        table: 'users',
        query: { },
        limit: 5,
        index: 'age',
      };

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND, payload });
      let users = res.payload;

      assert.equal(users[0].$loki, 6);
      assert.equal(users[4].$loki, 2);

      payload = { 
        contract: 'users_contract',
        table: 'users',
        query: { },
        limit: 5,
        offset: 5,
        index: 'age',
      };

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND, payload });
      users = res.payload;

      assert.equal(users[0].$loki, 10);
      assert.equal(users[4].$loki, 5);

      payload = { 
        contract: 'users_contract',
        table: 'users',
        query: { },
        limit: 5,
        offset: 10,
        index: 'age',
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
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          await db.createTable('users', ['age']);
        }

        actions.addUser = async (payload) => {
          const { age } = payload;

          const newUser = {
            'id': sender,
            age
          };

          await db.insert('users', newUser);
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'users_contract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', '{ "age": 2 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon1', 'users_contract', 'addUser', '{ "age": 10 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon2', 'users_contract', 'addUser', '{ "age": 3 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon3', 'users_contract', 'addUser', '{ "age": 199 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon4', 'users_contract', 'addUser', '{ "age": 200 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon5', 'users_contract', 'addUser', '{ "age": 1 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon6', 'users_contract', 'addUser', '{ "age": 89 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon7', 'users_contract', 'addUser', '{ "age": 2 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon8', 'users_contract', 'addUser', '{ "age": 34 }'));
      transactions.push(new Transaction(123456789, 'TXID1236', 'Harpagon9', 'users_contract', 'addUser', '{ "age": 20 }'));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      let payload = { 
        contract: 'users_contract',
        table: 'users',
        query: { },
        limit: 5,
        index: 'age',
        descending: true,
      };

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND, payload });
      let users = res.payload;

      assert.equal(users[0].$loki, 5);
      assert.equal(users[4].$loki, 10);

      payload = { 
        contract: 'users_contract',
        table: 'users',
        query: { },
        limit: 5,
        offset: 5,
        index: 'age',
        descending: true,
      };

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND, payload });
      users = res.payload;

      assert.equal(users[0].$loki, 2);
      assert.equal(users[4].$loki, 6);

      payload = { 
        contract: 'users_contract',
        table: 'users',
        query: { },
        limit: 5,
        offset: 10,
        index: 'age',
        descending: true,
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
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          await db.createTable('users');
        }

        actions.addUser = async (payload) => {
          if (sender !== owner) return;

          const { userId } = payload;
  
          const newUser = {
            'id': userId
          };

          await db.insert('users', newUser);
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'users_contract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Dan', 'users_contract', 'addUser', '{ "userId": "Dan" }'));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: 'users_contract', table: 'users', query: { "id": "Dan" }} });
      let user = res.payload;

      assert.equal(user, null);

      transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', '{ "userId": "Dan" }'));

      block = {
        timestamp: '2018-06-01T00:00:03',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: 'users_contract', table: 'users', query: { "id": "Dan" }} });
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
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const usersSmartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          await db.createTable('users');
        }

        actions.addUser = async (payload) => {
          const newUser = {
            'id': sender,
            'username': sender
          };

          await db.insert('users', newUser);
        }
      `;

      const booksSmartContractCode = `
      actions.createSSC = async (payload) => {
        // Initialize the smart contract via the create action
        await db.createTable('books');
      }
      
      actions.addBook = async (payload) => {

        const { title } = payload;

        let user = await db.findOneInTable('users_contract', 'users', { "id": sender });

        if (user) {
          const newBook = {
            'userId': user.id,
            title
          };
  
          await db.insert('books', newBook);
        }
      }
    `;

    const base64UsersSmartContractCode = Base64.encode(usersSmartContractCode);
    const base64BooksSmartContractCode = Base64.encode(booksSmartContractCode);

    const usersContractPayload = {
      name: 'users_contract',
      params: '',
      code: base64UsersSmartContractCode,
    };

    const booksContractPayload = {
      name: 'books_contract',
      params: '',
      code: base64BooksSmartContractCode,
    };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(usersContractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(booksContractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', ''));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Harpagon', 'books_contract', 'addBook', '{ "title": "The Awesome Book" }'));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      const res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: 'books_contract', table: 'books', query: { "userId": "Harpagon" }} });
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
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const usersSmartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
          await db.createTable('users');
        }

        actions.addUser = async (payload) => {
          const newUser = {
            'id': sender,
            'username': sender
          };

          const user = await db.insert('users', newUser);

          await executeSmartContract('books_contract', 'addBook', { "title": "The Awesome Book" })
        }
      `;

      const booksSmartContractCode = `
      actions.createSSC = async (payload) => {
        // Initialize the smart contract via the create action
        await db.createTable('books');
      }
      
      actions.addBook = async (payload) => {
        const { title } = payload;
        
        let user = await db.findOneInTable('users_contract', 'users', { "id": sender });

        if (user) {
          const newBook = {
            'userId': user.id,
            title
          };

          const book = await db.insert('books', newBook);
        }
      }
    `;

    const base64UsersSmartContractCode = Base64.encode(usersSmartContractCode);
    const base64BooksSmartContractCode = Base64.encode(booksSmartContractCode);

    const usersContractPayload = {
      name: 'users_contract',
      params: '',
      code: base64UsersSmartContractCode,
    };

    const booksContractPayload = {
      name: 'books_contract',
      params: '',
      code: base64BooksSmartContractCode,
    };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(usersContractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(booksContractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', ''));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      const res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.FIND_ONE, payload: { contract: 'books_contract', table: 'books', query: { "userId": "Harpagon" }} });
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
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const smartContractCode = `
        actions.createSSC = function (payload) {
          // Initialize the smart contract via the create action
          emit('contract_create', { "contractName": "test_contract" })
        }
      `;

      const base64SmartContractCode = Base64.encode(smartContractCode);

      const contractPayload = {
        name: 'test_contract',
        params: '',
        code: base64SmartContractCode,
      };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO });
      const latestBlock = res.payload;
      
      const txs = latestBlock.transactions.filter(transaction => transaction.transactionId === 'TXID1234');

      const logs = JSON.parse(txs[0].logs);

      assert.equal(logs.events[0].event, 'contract_create');
      assert.equal(logs.events[0].data.contractName, 'test_contract');

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
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const usersSmartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
        }

        actions.addUser = async (payload) => {
          await executeSmartContract('books_contract', 'addBook', { })
        }
      `;

      const booksSmartContractCode = `
      actions.createSSC = async (payload) => {
        // Initialize the smart contract via the create action
      }
      
      actions.addBook = async (payload) => {
        emit('contract_create', { "contractName": "test_contract" });
      }
    `;

    const base64UsersSmartContractCode = Base64.encode(usersSmartContractCode);
    const base64BooksSmartContractCode = Base64.encode(booksSmartContractCode);

    const usersContractPayload = {
      name: 'users_contract',
      params: '',
      code: base64UsersSmartContractCode,
    };

    const booksContractPayload = {
      name: 'books_contract',
      params: '',
      code: base64BooksSmartContractCode,
    };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(usersContractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(booksContractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', ''));

      let block = {
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO });
      const latestBlock = res.payload;
      
      const txs = latestBlock.transactions.filter(transaction => transaction.transactionId === 'TXID1235');

      const logs = JSON.parse(txs[0].logs);

      assert.equal(logs.events[0].event, 'contract_create');
      assert.equal(logs.events[0].data.contractName, 'test_contract');

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
      cleanDataFolder();

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
        name: 'test_contract',
        params: '',
        code: base64SmartContractCode,
      };

      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));

      let block = {
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
      cleanDataFolder();

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
        name: 'test_contract',
        params: '',
        code: base64SmartContractCode,
      };

      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Harpagon', 'test_contract', 'addUser', ''));

      let block = {
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
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);
      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const usersSmartContractCode = `
        actions.createSSC = async (payload) => {
          // Initialize the smart contract via the create action
        }

        actions.addUser = async (payload) => {
          await executeSmartContract('books_contract', 'addBook', { })
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
      name: 'users_contract',
      params: '',
      code: base64UsersSmartContractCode,
    };

    const booksContractPayload = {
      name: 'books_contract',
      params: '',
      code: base64BooksSmartContractCode,
    };


      let transactions = [];
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(usersContractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(booksContractPayload)));
      transactions.push(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', ''));

      let block = {
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
});
