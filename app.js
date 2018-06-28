const jayson = require('jayson');
const express = require('express');
const bodyParser = require('body-parser');
const nodeCleanup = require('node-cleanup');
const { startSteemBlock } = require('./config');
const { SteemStreamer } = require('./libs/SteemStreamer');
const { Blockchain, Transaction } = require('./libs/Blockchain');

// instantiate the blockchain
const steemContracts = new Blockchain();

// start reading the Steem blockchain to get incoming transactions
const steemStreamer = new SteemStreamer(startSteemBlock);
steemStreamer.stream((result) => {
  const { timestamp, transactions } = result;
  transactions.forEach((transaction) => {
    steemContracts.createTransaction(
      new Transaction(
        transaction.refBlockNumber,
        transaction.transactionId,
        transaction.author,
        transaction.contractName,
        transaction.contractAction,
        transaction.contractPayload,
      ),
    );
  });

  if (transactions.length > 0) {
    steemContracts.producePendingTransactions(timestamp);
  }
});


// launch an RPC server to be able to get data from the blockchain
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
  console.log('App specific cleanup code... ', exitCode, signal); // eslint-disable-line no-console
});
