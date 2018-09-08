const jayson = require('jayson');
const https = require('https');
const express = require('express');
const bodyParser = require('body-parser');
const nodeCleanup = require('node-cleanup');
const fs = require('fs-extra');
const {
  chainId,
  startSteemBlock,
  rpcNodePort,
  javascriptVMTimeout,
  dataDirectory,
  blockchainFilePath,
  databaseFilePath,
  keyCertificat,
  certificat,
  caCertificat,
} = require('./config');
const { SteemStreamer } = require('./libs/SteemStreamer');
const { Blockchain, Transaction } = require('./libs/Blockchain');

// instantiate the blockchain
const steemContracts = new Blockchain(javascriptVMTimeout);

console.log('Loading Blockchain...'); // eslint-disable-line
steemContracts.loadBlockchain(dataDirectory, blockchainFilePath, databaseFilePath, (error) => {
  if (error) {
    console.error(error); // eslint-disable-line
  } else {
    console.log('Blockchain loaded'); // eslint-disable-line

    // start reading the Steem blockchain to get incoming transactions
    const steemStreamer = new SteemStreamer(chainId, startSteemBlock);
    steemStreamer.stream((result) => {
      // the stream parsed transactions from the Steem blockchain
      const { timestamp, transactions } = result;
      // we create the transactions that will be processed by the sidechain
      transactions.forEach((transaction) => {
        steemContracts.createTransaction(
          new Transaction(
            transaction.refBlockNumber,
            transaction.transactionId,
            transaction.sender,
            transaction.contractName,
            transaction.contractAction,
            transaction.contractPayload,
          ),
        );
      });

      // if there are transactions pending we produce a block
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

      getContract: (args, callback) => {
        const { contract } = args;

        if (contract) {
          const res = steemContracts.getContract(contract);
          callback(null, res);
        } else {
          callback({
            code: 400,
            message: 'missing or wrong parameters: contract is required',
          }, null);
        }
      },

      findOneInTable: (args, callback) => {
        const { contract, table, query } = args;

        if (contract && table && query) {
          const res = steemContracts.findOneInTable(contract, table, query);
          callback(null, res);
        } else {
          callback({
            code: 400,
            message: 'missing or wrong parameters: contract and tableName are required',
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

    https.createServer({
      key: fs.readFileSync(keyCertificat),
      cert: fs.readFileSync(certificat),
      ca: fs.readFileSync(caCertificat),
    }, app)
      .listen(rpcNodePort, () => {
        console.log(`RPC Node now listening on port ${rpcNodePort}`); // eslint-disable-line
      });

    // execute actions before the app closes
    nodeCleanup((exitCode, signal) => {
      if (signal) {
        console.log('Closing App... ', exitCode, signal); // eslint-disable-line

        let currentSteemBlock = steemStreamer.GetCurrentBlock();

        steemContracts.saveBlockchain((err) => {
          if (err) {
            console.error(err); // eslint-disable-line
          } else {
            console.log('Blockchain saved'); // eslint-disable-line
          }

          // check if the last streamed Steem block is not lower than the latest block processed
          const latestBlock = steemContracts.getLatestBlock();
          if (currentSteemBlock < latestBlock.refSteemBlockNumber) {
            currentSteemBlock = latestBlock.refSteemBlockNumber;
          }

          const config = fs.readJSONSync('./config.json');
          config.startSteemBlock = currentSteemBlock;
          fs.writeJSONSync('./config.json', config);

          // calling process.exit() won't inform parent process of signal
          process.kill(process.pid, signal);
        });
        nodeCleanup.uninstall(); // don't call cleanup handler again
        return false;
      }

      return true;
    });
  }
});
