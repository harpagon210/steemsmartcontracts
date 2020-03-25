const { Block } = require('../libs/Block');
const { Transaction } = require('../libs/Transaction');
const { IPC } = require('../libs/IPC');
const { Database } = require('../libs/Database');
const { Bootstrap } = require('../contracts/bootstrap/Bootstrap');

const PLUGIN_PATH = require.resolve(__filename);
const { PLUGIN_NAME, PLUGIN_ACTIONS } = require('./Blockchain.constants');

const actions = {};

const ipc = new IPC(PLUGIN_NAME);
let database = null;
let javascriptVMTimeout = 0;
let producing = false;
let stopRequested = false;

const createGenesisBlock = async (payload) => {
  // check if genesis block hasn't been generated already
  let genesisBlock = await database.getBlockInfo(0);

  if (!genesisBlock) {
    // insert the genesis block
    const { chainId, genesisHiveBlock } = payload;
    const genesisTransactions = await Bootstrap.getBootstrapTransactions(genesisHiveBlock);
    genesisTransactions.unshift(new Transaction(genesisHiveBlock, 0, 'null', 'null', 'null', JSON.stringify({ chainId, genesisHiveBlock })));

    genesisBlock = new Block('2018-06-01T00:00:00', 0, '', '', genesisTransactions, -1, '0');
    await genesisBlock.produceBlock(database, javascriptVMTimeout);

    await database.insertGenesisBlock(genesisBlock);
  }
};

function getLatestBlockMetadata() {
  return database.getLatestBlockMetadata();
}

function addBlock(block) {
  return database.addBlock(block);
}

// produce all the pending transactions, that will result in the creation of a block
async function producePendingTransactions(
  refHiveBlockNumber, refHiveBlockId, prevRefHiveBlockId, transactions, timestamp,
) {
  const previousBlock = await getLatestBlockMetadata();
  if (previousBlock) {
    // skip block if it has been parsed already
    if (refHiveBlockNumber <= previousBlock.refHiveBlockNumber) {
      // eslint-disable-next-line no-console
      console.warn(`skipping Hive block ${refHiveBlockNumber} as it has already been parsed`);
      return;
    }

    const newBlock = new Block(
      timestamp,
      refHiveBlockNumber,
      refHiveBlockId,
      prevRefHiveBlockId,
      transactions,
      previousBlock.blockNumber,
      previousBlock.hash,
      previousBlock.databaseHash,
    );

    await newBlock.produceBlock(database, javascriptVMTimeout);

    if (newBlock.transactions.length > 0 || newBlock.virtualTransactions.length > 0) {
      await addBlock(newBlock);
    }
  }
}

const produceNewBlockSync = async (block, callback = null) => {
  if (stopRequested) return;
  producing = true;
  // the stream parsed transactions from the Hive blockchain
  const {
    refHiveBlockNumber, refHiveBlockId, prevRefHiveBlockId,
    transactions, timestamp, virtualTransactions,
  } = block;
  const newTransactions = [];

  transactions.forEach((transaction) => {
    const finalTransaction = transaction;

    newTransactions.push(new Transaction(
      finalTransaction.refHiveBlockNumber,
      finalTransaction.transactionId,
      finalTransaction.sender,
      finalTransaction.contract,
      finalTransaction.action,
      finalTransaction.payload,
    ));
  });

  // if there are transactions pending we produce a block
  if (newTransactions.length > 0 || (virtualTransactions && virtualTransactions.length > 0)) {
    await producePendingTransactions(
      refHiveBlockNumber, refHiveBlockId, prevRefHiveBlockId, newTransactions, timestamp,
    );
  }
  producing = false;

  if (callback) callback();
};

// when stopping, we wait until the current block is produced
function stop(callback) {
  stopRequested = true;
  if (producing) {
    setTimeout(() => stop(callback), 500);
  } else {
    stopRequested = false;
    if (database) database.close();
    callback();
  }
}

const init = async (conf, callback) => {
  const {
    databaseURL,
    databaseName,
  } = conf;
  javascriptVMTimeout = conf.javascriptVMTimeout; // eslint-disable-line prefer-destructuring

  database = new Database();
  await database.init(databaseURL, databaseName);

  await createGenesisBlock(conf);

  callback(null);
};

ipc.onReceiveMessage((message) => {
  const {
    action,
    payload,
    // from,
  } = message;

  if (action === 'init') {
    init(payload, (res) => {
      console.log('successfully initialized'); // eslint-disable-line no-console
      ipc.reply(message, res);
    });
  } else if (action === 'stop') {
    stop(() => {
      console.log('successfully stopped'); // eslint-disable-line no-console
      ipc.reply(message);
    });
  } else if (action === PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC) {
    produceNewBlockSync(payload, () => {
      ipc.reply(message);
    });
  } else if (action && typeof actions[action] === 'function') {
    ipc.reply(message, actions[action](payload));
  } else {
    ipc.reply(message);
  }
});

module.exports.producePendingTransactions = producePendingTransactions;
module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLUGIN_PATH = PLUGIN_PATH;
module.exports.PLUGIN_ACTIONS = PLUGIN_ACTIONS;
