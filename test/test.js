/* eslint-disable */
const assert = require('assert');
const { Base64 } = require('js-base64');
const { Blockchain, Transaction } = require('../libs/Blockchain');
const fs = require('fs-extra');

function cleanDataFolder() {
  fs.emptyDirSync('./test/data');
}

// Blockchain
describe('Blockchain', function () {
  it('should be a valid blockchain', function () {
    cleanDataFolder();

    const smartContractCode = `
      actions.create = function (payload) {
        // Initialize the smart contract via the create action
        db.createTable('users');
      }

      actions.addUser = function (payload) {
        let users = db.getTable('users');

        const newUser = {
          'id': sender
        };

        users.insert(newUser);
      }
    `;

    const base64SmartContractCode = Base64.encode(smartContractCode);

    const contractPayload = {
      name: 'users_contract',
      params: '',
      code: base64SmartContractCode,
    };

    // all the variables that we needed are now ready, we can deploy the smart contract
    const steemSmartContracts = new Blockchain();

    steemSmartContracts.loadBlockchain('./test/data/', (error) => {
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', ''));
      steemSmartContracts.producePendingTransactions('2018-06-01T00:00:00');

      assert.equal(steemSmartContracts.isChainValid(), true);
    })
  });

  it('should be invalid when blocks have been corrupted', function () {
    cleanDataFolder();

    const smartContractCode = `
      actions.create = function (payload) {
        // Initialize the smart contract via the create action
        db.createTable('users');
      }

      actions.addUser = function (payload) {
        let users = db.getTable('users');

        const newUser = {
          'id': sender
        };

        users.insert(newUser);
      }
    `;

    const base64SmartContractCode = Base64.encode(smartContractCode);

    const contractPayload = {
      name: 'users_contract',
      params: '',
      code: base64SmartContractCode,
    };

    // all the variables that we needed are now ready, we can deploy the smart contract
    const steemSmartContracts = new Blockchain();

    steemSmartContracts.loadBlockchain('./test/data/', (error) => {
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', ''));
      steemSmartContracts.producePendingTransactions('2018-06-01T00:00:00');
  
      steemSmartContracts.chain[1].transactions[0].sender = 'azerty';
  
      assert.equal(steemSmartContracts.isChainValid(), false);
    });
  });

  it('should be valid after a replay', function () {
    cleanDataFolder();

    const smartContractCode = `
      actions.create = function (payload) {
        // Initialize the smart contract via the create action
        db.createTable('users');
      }

      actions.addUser = function (payload) {
        let users = db.getTable('users');

        const newUser = {
          'id': sender
        };

        users.insert(newUser);
      }
    `;

    const base64SmartContractCode = Base64.encode(smartContractCode);

    const contractPayload = {
      name: 'users_contract',
      params: '',
      code: base64SmartContractCode,
    };

    // all the variables that we needed are now ready, we can deploy the smart contract
    const steemSmartContracts = new Blockchain();

    steemSmartContracts.loadBlockchain('./test/data/', (error) => {
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', ''));
      steemSmartContracts.producePendingTransactions('2018-06-01T00:00:00');

      steemSmartContracts.replayBlockchain();

      assert.equal(steemSmartContracts.isChainValid(), true);
    });
  });

  it('should give the same result after a replay', function () {
    cleanDataFolder();

    const smartContractCode = `
      actions.create = function (payload) {
        // Initialize the smart contract via the create action
        db.createTable('users');
      }

      actions.addUser = function (payload) {
        let users = db.getTable('users');

        const newUser = {
          'id': sender
        };

        users.insert(newUser);
      }
    `;

    const base64SmartContractCode = Base64.encode(smartContractCode);

    const contractPayload = {
      name: 'users_contract',
      params: '',
      code: base64SmartContractCode,
    };

    // all the variables that we needed are now ready, we can deploy the smart contract
    const steemSmartContracts = new Blockchain();

    steemSmartContracts.loadBlockchain('./test/data/', (error) => {

      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', ''));
      steemSmartContracts.producePendingTransactions('2018-06-01T00:00:00');

      let user = steemSmartContracts.findOneInTable('users_contract', 'users', { "id": "Harpagon" });

      assert.equal(user.id, 'Harpagon');

      steemSmartContracts.replayBlockchain();

      user = steemSmartContracts.findOneInTable('users_contract', 'users', { "id": "Harpagon" });

      assert.equal(user.id, 'Harpagon');
    });
  });
  
});

// smart contracts
describe('Smart Contracts', function () {
  it('should deploy a basic smart contract', function () {
    cleanDataFolder();

    const smartContractCode = `
      actions.create = function (payload) {
        // Initialize the smart contract via the create action
      }
    `;

    const base64SmartContractCode = Base64.encode(smartContractCode);

    // the code template is added to the smart contract code by the blockchain
    // so in order to make sure that the code deployed is equal to the code we deployed we need to apply this template
    let codeTemplate = `
      let actions = {};

      ###ACTIONS###

      if (typeof actions[action] === 'function')
        actions[action](payload);
    `;

    codeTemplate = codeTemplate.replace('###ACTIONS###', smartContractCode);

    const contractPayload = {
      name: 'test_contract',
      params: '',
      code: base64SmartContractCode,
    };

    // all the variables that we needed are now ready, we can deploy the smart contract
    const steemSmartContracts = new Blockchain();

    steemSmartContracts.loadBlockchain('./test/data/', (error) => {
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      steemSmartContracts.producePendingTransactions('2018-06-01T00:00:00');

      const contract = steemSmartContracts.getContract('test_contract');

      assert.equal(contract.name, 'test_contract');
      assert.equal(contract.owner, 'Harpagon');
    });
  });

  it('should create a table during the smart contract deployment', function () {
    cleanDataFolder();

    const smartContractCode = `
      actions.create = function (payload) {
        // Initialize the smart contract via the create action
        db.createTable('test_table');
      }
    `;

    const base64SmartContractCode = Base64.encode(smartContractCode);

    const contractPayload = {
      name: 'test_contract',
      params: '',
      code: base64SmartContractCode,
    };

    // all the variables that we needed are now ready, we can deploy the smart contract
    const steemSmartContracts = new Blockchain();

    steemSmartContracts.loadBlockchain('./test/data/', (error) => {
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      steemSmartContracts.producePendingTransactions('2018-06-01T00:00:00');

      const contract = steemSmartContracts.getContract('test_contract');

      // the name of a table starts by the name of the contract and is separated by _
      assert.equal(contract.tables.includes('test_contract_test_table'), true);
    });
  });

  it('should add a record into a smart contract table', function () {
    cleanDataFolder();

    const smartContractCode = `
      actions.create = function (payload) {
        // Initialize the smart contract via the create action
        db.createTable('users');
      }

      actions.addUser = function (payload) {
        let users = db.getTable('users');

        const newUser = {
          'id': sender
        };

        users.insert(newUser);
      }
    `;

    const base64SmartContractCode = Base64.encode(smartContractCode);

    const contractPayload = {
      name: 'users_contract',
      params: '',
      code: base64SmartContractCode,
    };

    // all the variables that we needed are now ready, we can deploy the smart contract
    const steemSmartContracts = new Blockchain();

    steemSmartContracts.loadBlockchain('./test/data/', (error) => {
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', ''));
      steemSmartContracts.producePendingTransactions('2018-06-01T00:00:00');

      const user = steemSmartContracts.findOneInTable('users_contract', 'users', { "id": "Harpagon" });

      assert.equal(user.id, 'Harpagon');
    });
  });

  it('should update a record from a smart contract table', function () {
    cleanDataFolder();

    const smartContractCode = `
      actions.create = function (payload) {
        // Initialize the smart contract via the create action
        db.createTable('users');
      }

      actions.addUser = function (payload) {
        const { username } = payload;

        let users = db.getTable('users');

        const newUser = {
          'id': sender,
          'username': username
        };

        users.insert(newUser);
      }
  
      actions.updateUser = function (payload) {
        const { username } = payload;
        
        let users = db.getTable('users');
        let user = users.findOne({ 'id': sender });

        user.username = username;
        users.update(user);
      }
    `;

    const base64SmartContractCode = Base64.encode(smartContractCode);

    const contractPayload = {
      name: 'users_contract',
      params: '',
      code: base64SmartContractCode,
    };

    // all the variables that we needed are now ready, we can deploy the smart contract
    const steemSmartContracts = new Blockchain();
    steemSmartContracts.loadBlockchain('./test/data/', (error) => {
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', '{ "username": "MyUsername" }'));
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1236', 'Harpagon', 'users_contract', 'updateUser', '{ "username": "MyUsernameUpdated" }'));
      steemSmartContracts.producePendingTransactions('2018-06-01T00:00:00');

      const user = steemSmartContracts.findOneInTable('users_contract', 'users', { "id": "Harpagon" });

      assert.equal(user.username, 'MyUsernameUpdated');
    });
  });

  it('should remove a record from a smart contract table', function () {
    cleanDataFolder();
    const smartContractCode = `
      actions.create = function (payload) {
        // Initialize the smart contract via the create action
        db.createTable('users');
      }
      
      actions.addUser = function (payload) {
        const { username } = payload;

        let users = db.getTable('users');

        const newUser = {
          'id': sender,
          'username': username
        };

        users.insert(newUser);
      }
  
      actions.removeUser = function (payload) {
  
        let users = db.getTable('users');
        let user = users.findOne({ 'id': sender });
        users.remove(user);
      }
    `;

    const base64SmartContractCode = Base64.encode(smartContractCode);

    const contractPayload = {
      name: 'users_contract',
      params: '',
      code: base64SmartContractCode,
    };

    // all the variables that we needed are now ready, we can deploy the smart contract
    const steemSmartContracts = new Blockchain();
    steemSmartContracts.loadBlockchain('./test/data/', (error) => {
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', ''));
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1236', 'Harpagon', 'users_contract', 'removeUser', ''));
      steemSmartContracts.producePendingTransactions('2018-06-01T00:00:00');

      const user = steemSmartContracts.findOneInTable('users_contract', 'users', { "id": "Harpagon" });

      assert.equal(user, null);
    });
  });

  it('should allow only the owner of the smart contract to perform certain actions', function () {
    cleanDataFolder();

    const smartContractCode = `
      actions.create = function (payload) {
        // Initialize the smart contract via the create action
        db.createTable('users');
      }
      
      actions.addUser = function (payload) {
        if (sender !== owner) return;

        const { userId } = payload;

        let users = db.getTable('users');

        const newUser = {
          'id': userId
        };

        users.insert(newUser);
      }
    `;

    const base64SmartContractCode = Base64.encode(smartContractCode);

    const contractPayload = {
      name: 'users_contract',
      params: '',
      code: base64SmartContractCode,
    };

    // all the variables that we needed are now ready, we can deploy the smart contract
    const steemSmartContracts = new Blockchain();

    steemSmartContracts.loadBlockchain('./test/data/', (error) => {
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1235', 'Dan', 'users_contract', 'addUser', '{ "userId": "Dan" }'));
      steemSmartContracts.producePendingTransactions('2018-06-01T00:00:00');

      let user = steemSmartContracts.findOneInTable('users_contract', 'users', { "id": "Harpagon" });

      assert.equal(user, null);

      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1236', 'Harpagon', 'users_contract', 'addUser', '{ "userId": "Dan" }'));
      steemSmartContracts.producePendingTransactions('2018-06-01T00:00:00');

      user = steemSmartContracts.findOneInTable('users_contract', 'users', { "id": "Dan" });

      assert.equal(user.id, "Dan");
    });
  });

  it('should perform a search in a smart contract table from another smart contract', function () {
    cleanDataFolder();

    const usersSmartContractCode = `
      actions.create = function (payload) {
        // Initialize the smart contract via the create action
        db.createTable('users');
      }
      
      actions.addUser = function (payload) {
        let users = db.getTable('users');

        const newUser = {
          'id': sender
        };

        users.insert(newUser);
      }
    `;

    const booksSmartContractCode = `
      actions.create = function (payload) {
        // Initialize the smart contract via the create action
        db.createTable('books');
      }
      
      actions.addBook = function (payload) {

        const { title } = payload;

        let user = db.findOneInTable('users_contract', 'users', { "id": sender });

        if (user) {
          let books = db.getTable('books');

          const newBook = {
            'userId': sender,
            title
          };
  
          books.insert(newBook);
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

    // all the variables that we needed are now ready, we can deploy the smart contract
    const steemSmartContracts = new Blockchain();

    steemSmartContracts.loadBlockchain('./test/data/', (error) => {
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(usersContractPayload)));
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(booksContractPayload)));
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', ''));
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1235', 'Harpagon', 'books_contract', 'addBook', '{ "title": "The Awesome Book" }'));
      steemSmartContracts.producePendingTransactions('2018-06-01T00:00:00');

      let book = steemSmartContracts.findInTable('books_contract', 'books', { "userId": "Harpagon" });

      assert.equal(book[0].title, "The Awesome Book");
    });
  });

  it('should execute a smart contract from another smart contract', function () {
    cleanDataFolder();

    const usersSmartContractCode = `
      actions.create = function (payload) {
        // Initialize the smart contract via the create action
        db.createTable('users');
      }
      
      actions.addUser = function (payload) {
        let users = db.getTable('users');

        const newUser = {
          'id': sender
        };

        users.insert(newUser);

        executeSmartContract('books_contract', 'addBook', '{ "title": "The Awesome Book" }')
      }
    `;

    const booksSmartContractCode = `
      actions.create = function (payload) {
        // Initialize the smart contract via the create action
        db.createTable('books');
      }
      
      actions.addBook = function (payload) {

        const { title } = payload;

        let user = db.findOneInTable('users_contract', 'users', { "id": sender });

        if (user) {
          let books = db.getTable('books');

          const newBook = {
            'userId': sender,
            title
          };
  
          books.insert(newBook);
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

    // all the variables that we needed are now ready, we can deploy the smart contract
    const steemSmartContracts = new Blockchain();

    steemSmartContracts.loadBlockchain('./test/data/', (error) => {
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(usersContractPayload)));
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(booksContractPayload)));
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1235', 'Harpagon', 'users_contract', 'addUser', ''));
      steemSmartContracts.producePendingTransactions('2018-06-01T00:00:00');

      let book = steemSmartContracts.findInTable('books_contract', 'books', { "userId": "Harpagon" });

      assert.equal(book[0].title, "The Awesome Book");
    });
  });

  it('should emit an event from a smart contract', function () {
    cleanDataFolder();

    const smartContractCode = `
      actions.create = function (payload) {
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

    // all the variables that we needed are now ready, we can deploy the smart contract
    const steemSmartContracts = new Blockchain();

    steemSmartContracts.loadBlockchain('./test/data/', (error) => {

      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      steemSmartContracts.producePendingTransactions('2018-06-01T00:00:00');

      const block = steemSmartContracts.getLatestBlock();

      const transactions = block.transactions.filter(transaction => transaction.transactionId === 'TXID1234');

      const logs = JSON.parse(transactions[0].logs);

      assert.equal(logs.events[0].event, 'contract_create');
      assert.equal(logs.events[0].data.contractName, 'test_contract');
    });
  });

  it('should log an error when trying to deploy an existing contract', function () {
    cleanDataFolder();

    const smartContractCode = `
      actions.create = function (payload) {
        // Initialize the smart contract via the create action
      }
    `;

    const base64SmartContractCode = Base64.encode(smartContractCode);

    // the code template is added to the smart contract code by the blockchain
    // so in order to make sure that the code deployed is equal to the code we deployed we need to apply this template
    let codeTemplate = `
      let actions = {};

      ###ACTIONS###

      if (typeof actions[action] === 'function')
        actions[action](payload);
    `;

    codeTemplate = codeTemplate.replace('###ACTIONS###', smartContractCode);

    const contractPayload = {
      name: 'test_contract',
      params: '',
      code: base64SmartContractCode,
    };

    // all the variables that we needed are now ready, we can deploy the smart contract
    const steemSmartContracts = new Blockchain();

    steemSmartContracts.loadBlockchain('./test/data/', (error) => {
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1235', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      steemSmartContracts.producePendingTransactions('2018-06-01T00:00:00');

      const block = steemSmartContracts.getLatestBlock();

      const transactions = block.transactions.filter(transaction => transaction.transactionId === 'TXID1235');

      const logs = JSON.parse(transactions[0].logs);

      assert.equal(logs.error, 'contract already exists');
    });
  });

  it('should log an error during the deployment of a smart contract if an error is thrown', function () {
    cleanDataFolder();

    const smartContractCode = `
      actions.create = function (payload) {
        // Initialize the smart contract via the create action

        THIS CODE CRASHES :)
      }
    `;

    const base64SmartContractCode = Base64.encode(smartContractCode);

    // the code template is added to the smart contract code by the blockchain
    // so in order to make sure that the code deployed is equal to the code we deployed we need to apply this template
    let codeTemplate = `
      let actions = {};

      ###ACTIONS###

      if (typeof actions[action] === 'function')
        actions[action](payload);
    `;

    codeTemplate = codeTemplate.replace('###ACTIONS###', smartContractCode);

    const contractPayload = {
      name: 'test_contract',
      params: '',
      code: base64SmartContractCode,
    };

    // all the variables that we needed are now ready, we can deploy the smart contract
    const steemSmartContracts = new Blockchain();

    steemSmartContracts.loadBlockchain('./test/data/', (error) => {
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      steemSmartContracts.producePendingTransactions('2018-06-01T00:00:00');

      const block = steemSmartContracts.getLatestBlock();

      const transactions = block.transactions.filter(transaction => transaction.transactionId === 'TXID1234');

      const logs = JSON.parse(transactions[0].logs);

      assert.equal(logs.error.name, "SyntaxError");
    });
  });

  it('should log an error during the execution of a smart contract if an error is thrown', function () {
    cleanDataFolder();

    const smartContractCode = `
      actions.create = function (payload) {
        // Initialize the smart contract via the create action
      }

      actions.addUser = function (payload) {
        THIS CODE CRASHES :)
      }
    `;

    const base64SmartContractCode = Base64.encode(smartContractCode);

    const contractPayload = {
      name: 'test_contract',
      params: '',
      code: base64SmartContractCode,
    };

    // all the variables that we needed are now ready, we can deploy the smart contract
    const steemSmartContracts = new Blockchain();

    steemSmartContracts.loadBlockchain('./test/data/', (error) => {
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'contract', 'deploy', JSON.stringify(contractPayload)));
      steemSmartContracts.createTransaction(new Transaction(123456789, 'TXID1234', 'Harpagon', 'test_contract', 'addUser', ''));
      steemSmartContracts.producePendingTransactions('2018-06-01T00:00:00');

      const block = steemSmartContracts.getLatestBlock();

      const transactions = block.transactions.filter(transaction => transaction.transactionId === 'TXID1234');

      const logs = JSON.parse(transactions[0].logs);

      assert.equal(logs.error.name, "SyntaxError");
    });
  });
  
});
