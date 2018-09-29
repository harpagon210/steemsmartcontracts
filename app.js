const nodeCleanup = require('node-cleanup');
const fs = require('fs-extra');
const program = require('commander');
const packagejson = require('./package.json');
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
const { Blockchain } = require('./libs/Blockchain');
const { Transaction } = require('./libs/Transaction');
const { Replay } = require('./libs/Replay');

program
  .version(packagejson.version)
  .option('-r, --replay [type]', 'replay the blockchain from [file|steemd]', /^(file|steemd)$/i)
  .parse(process.argv);

if (program.replay !== undefined) {
  // instantiate the blockchain
  const steemContracts = new Blockchain(chainId, 0, javascriptVMTimeout);

  console.log('Loading Blockchain...'); // eslint-disable-line
  steemContracts.loadBlockchain(dataDirectory, databaseFilePath, (error) => {
    if (error) {
      console.error(error); // eslint-disable-line
    } else {
      let nbBlocksReplayed = 0;
      console.log('Blockchain loaded'); // eslint-disable-line

      // instantiate the replay tool
      const replay = new Replay(program.replay);
      console.log(`Sarting replay from ${program.replay}`); // eslint-disable-line
      replay.start((result) => {
        if (result) {
          const { timestamp, transactions, blockNumber } = result;
          console.log(`Replaying block ${blockNumber}`); // eslint-disable-line
          nbBlocksReplayed += 1;
          // we create the transactions that will be processed by the sidechain
          transactions.forEach((transaction) => {
            steemContracts.createTransaction(
              new Transaction(
                transaction.refBlockNumber,
                transaction.transactionId,
                transaction.sender,
                transaction.contract,
                transaction.action,
                transaction.payload,
              ),
            );
          });
          // if there are transactions pending we produce a block
          if (transactions.length > 0) {
            steemContracts.producePendingTransactions(timestamp);
          }
        } else {
          console.log(`Done replaying ${nbBlocksReplayed} blocks`); // eslint-disable-line
          steemContracts.saveBlockchain((err) => {
            if (err) {
              console.error(err); // eslint-disable-line
            } else {
              console.log('Blockchain saved'); // eslint-disable-line
            }

            const latestBlock = steemContracts.getLatestBlock();

            const config = fs.readJSONSync('./config.json');
            config.startSteemBlock = latestBlock.refSteemBlockNumber;
            fs.writeJSONSync('./config.json', config);

            // calling process.exit() won't inform parent process of signal
            process.kill(process.pid);
          });
        }
      });
    }
  });
} else {
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
}
