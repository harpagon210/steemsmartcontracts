const nodeCleanup = require('node-cleanup');
const fs = require('fs-extra');
const { JsonRPCServer } = require('./libs/JsonRPCServer');
const {
  chainId,
  startSteemBlock,
  javascriptVMTimeout,
  dataDirectory,
  autosaveInterval,
  databaseFilePath,
} = require('./config');
const { SteemStreamer } = require('./libs/SteemStreamer');
const { Blockchain, Transaction } = require('./libs/Blockchain');

// instantiate the blockchain
const steemContracts = new Blockchain(chainId, autosaveInterval, javascriptVMTimeout);

console.log('Loading Blockchain...'); // eslint-disable-line
steemContracts.loadBlockchain(dataDirectory, databaseFilePath, (error) => {
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

    // JSON RPC Server instantiation
    const jsonRPCServer = new JsonRPCServer(steemContracts);
    jsonRPCServer.StartServer();

    // execute actions before the app closes
    nodeCleanup((exitCode, signal) => {
      if (signal) {
        console.log('Closing App... ', exitCode, signal); // eslint-disable-line

        let currentSteemBlock = steemStreamer.GetCurrentBlock();
        steemStreamer.StopStream();

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
