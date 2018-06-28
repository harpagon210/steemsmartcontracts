const jayson = require('jayson');
const { Base64 } = require('js-base64');
const express = require('express');
const bodyParser = require('body-parser');
const nodeCleanup = require('node-cleanup');
const { Blockchain, Transaction } = require('../Blockchain');


const steemContracts = new Blockchain();

let codeUsers = `
    actions.create = function (payload) {
      db.createTable('users');
    }

    actions.addUser = function (payload) {
      const { username } = payload;
      if (username && typeof username === 'string'){

        let users = db.getTable('users');

        let user = users.findOne({ 'id': sender });

        if (user === null) {
          const newUser = {
            'id': sender,
            'username': username,
            'verified': false,
          };

          users.insert(newUser);
          emit('newUserCreated', newUser);
        } 
      }
    }

    actions.updateUser = function (payload) {
      const { username } = payload;
      if (username && typeof username === 'string'){

        let users = db.getTable('users');
        let user = users.findOne({ 'id': sender });
        if (user) {
          user.username = username;
          users.update(user);
        }
      }
    }

    actions.removeUser = function (payload) {
      if (sender != owner) return;
      
      const { userId } = payload;

      if (userId && typeof userId === 'string'){
        let users = db.getTable('users');
        let user = users.findOne({ 'id': userId });
        if (user)
          users.remove(user);
      }
    }

    actions.verifyUser = function (payload) {
      if (sender != owner) return;
      
      const { userId } = payload;

      if (userId && typeof userId === 'string'){
        let users = db.getTable('users');
        let user = users.findOne({ 'id': sender });
        if (user) {
          // do some verification about the user...
          user.verified = true;
          users.update(user);

          // the user seems to be ok... let's give him some tokens :)
          // call an external contract
          const paramsContract = {
            userId,
            nbTokens: 100
          }
          executeSmartContract('contract_tokens', 'addTokens', JSON.stringify(paramsContract));
        }
      }
    }
  `;

let codeTokens = `
    actions.create = function (payload) {
      db.createTable('tokens');
    }

    actions.addTokens = function (payload) {
      if (sender != owner) return;

      const { userId, nbTokens } = payload;
      if (userId && typeof userId === 'string'
          && nbTokens && typeof nbTokens === 'number'){

        let tokens = db.getTable('tokens');

        const data = {
          'id': userId,
          'tokenBalance': nbTokens,
        };

        tokens.insert(data);
      }
    }
  `;

codeUsers = Base64.encode(codeUsers);
codeTokens = Base64.encode(codeTokens);

const payloadUsers = {
  name: 'contract_users',
  params: '',
  code: codeUsers,
};

const payloadTokens = {
  name: 'contract_tokens',
  params: '',
  code: codeTokens,
};

steemContracts.createTransaction(new Transaction(123456789, 'TXID', 'Harpagon', 'contract', 'deploy', JSON.stringify(payloadUsers)));
steemContracts.createTransaction(new Transaction(123456789, 'TXID', 'Harpagon', 'contract', 'deploy', JSON.stringify(payloadTokens)));

steemContracts.producePendingTransactions('2018-07-01T00:00:00');

steemContracts.createTransaction(new Transaction(123456789, 'TXID', 'Harpagon', 'contract_users', 'addUser', '{ "username": "AwesomeUsername" }'));
// steemContracts.createTransaction(new Transaction(123456789, 'TXID', 'Harpagon', 'contract_users', 'updateUser', '{ "username": "AwesomeUsernameUpdated" }'));
// steemContracts.createTransaction(new Transaction(123456789, 'TXID', 'Harpagon', 'contract_users', 'removeUser', '{ "userId": "Harpagon" }'));
steemContracts.createTransaction(new Transaction(123456789, 'TXID', 'Harpagon', 'contract_users', 'verifyUser', '{ "userId": "Harpagon" }'));


steemContracts.producePendingTransactions('2018-07-01T00:00:00');

// console.log(steemContracts.isChainValid() ? 'blockchain is valid' : 'blockchain is invalid');
// steemContracts.chain[1].transactions[0].sender = 'azerty';
// console.log(steemContracts.isChainValid() ? 'blockchain is valid' : 'blockchain is invalid');

// console.log('###replaying blockchain###')
// steemContracts.replayBlockchain();

const blockchainRPC = {

  getLatestBlockInfo: (args, callback) => {
    const res = steemContracts.getLatestBlockInfo();
    callback(null, res);
  },

  getBlockInfo: (args, callback) => {
    const { blockNumber } = args;

    if (blockNumber) {
      const res = steemContracts.getBlockInfo(blockNumber);
      callback(null, res);
    } else {
      callback({
        code: 400,
        message: 'missing or wrong parameters: blockNumber is required',
      }, null);
    }
  },
};

const contractsRPC = {

  getCode: (args, callback) => {
    const { contract } = args;

    if (contract) {
      const res = steemContracts.getCode(contract);
      callback(null, res);
    } else {
      callback({
        code: 400,
        message: 'missing or wrong parameters: contract is required',
      }, null);
    }
  },

  getOwner: (args, callback) => {
    const { contract } = args;

    if (contract) {
      const res = steemContracts.getOwner(contract);
      callback(null, res);
    } else {
      callback({
        code: 400,
        message: 'missing or wrong parameters: contract is required',
      }, null);
    }
  },

  findInTable: (args, callback) => {
    const { contract, table, query } = args;

    if (contract && table && query) {
      const res = steemContracts.findInTable(contract, table, query);
      callback(null, res);
    } else {
      callback({
        code: 400,
        message: 'missing or wrong parameters: contract and tableName are required',
      }, null);
    }
  },
};

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.post('/blockchain', jayson.server(blockchainRPC).middleware());
app.post('/contracts', jayson.server(contractsRPC).middleware());
app.listen(5000);

// execute actions before the app closes
nodeCleanup((exitCode, signal) => {
  console.log('App specific cleanup code... ', exitCode, signal);
});
