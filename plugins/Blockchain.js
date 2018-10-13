const { Base64 } = require('js-base64');
const { Block } = require('../libs/Block');
const { Transaction } = require('../libs/Transaction');
const { Queue } = require('../libs/Queue');
const { IPC } = require('../libs/IPC');
const DB_PLUGIN_NAME = require('./Database').PLUGIN_NAME;
const DB_PLUGIN_ACTIONS = require('./Database').PLUGIN_ACTIONS;
const { Contracts } = require('../contracts/bootstrap');

const PLUGIN_NAME = 'Blockchain';
const PLUGIN_PATH = require.resolve(__filename);
const PLUGIN_ACTIONS = {
  PRODUCE_NEW_BLOCK_SYNC: 'produceNewBlockSync',
  ADD_BLOCK_TO_QUEUE: 'addBlockToQueue',
  START_BLOCK_PRODUCTION: 'startBlockProduction',
  CREATE_GENESIS_BLOCK: 'createGenesisBlock',
};

if (process.env.NODE_ENV === 'test') console.log = () => {}; // eslint-disable-line

const actions = {};

const ipc = new IPC(PLUGIN_NAME);
let javascriptVMTimeout = 0;
let producing = false;
let stopRequested = false;
const blockProductionQueue = new Queue();

async function createGenesisBlock(payload, callback) {
  const { chainId, genesisSteemBlock } = payload;
  const genesisTransactions = [];

  // deploy bootstrap contracts
  Contracts.forEach((contract) => {
    const base64SmartContractCode = Base64.encode(contract.code);

    const contractPayload = {
      name: contract.name,
      params: '',
      code: base64SmartContractCode,
    };

    genesisTransactions.push(new Transaction(genesisSteemBlock, 0, 'null', 'contract', 'deploy', JSON.stringify(contractPayload)));
  });

  const genesisBlock = new Block('2018-06-01T00:00:00', genesisTransactions, -1, '0');
  await genesisBlock.produceBlock(ipc, javascriptVMTimeout);
  genesisBlock.transactions.unshift({ chainId, genesisSteemBlock });
  return callback(genesisBlock);
}

function getLatestBlock() {
  return ipc.send({ to: DB_PLUGIN_NAME, action: DB_PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO });
}

function addBlock(block) {
  return ipc.send({ to: DB_PLUGIN_NAME, action: DB_PLUGIN_ACTIONS.ADD_BLOCK, payload: block });
}

// produce all the pending transactions, that will result in the creation of a block
async function producePendingTransactions(transactions, timestamp) {
  const res = await getLatestBlock();
  if (res) {
    const previousBlock = res.payload;
    const newBlock = new Block(
      timestamp,
      transactions,
      previousBlock.blockNumber,
      previousBlock.hash,
    );

    await newBlock.produceBlock(ipc, javascriptVMTimeout);
    await addBlock(newBlock);
  }
}

actions.addBlockToQueue = (block) => {
  blockProductionQueue.push(block);
};

actions.produceNewBlock = async (block) => {
  if (stopRequested) return;
  producing = true;
  // the stream parsed transactions from the Steem blockchain
  const { transactions, timestamp } = block;
  const newTransactions = [];

  transactions.forEach((transaction) => {
    newTransactions.push(new Transaction(
      transaction.refSteemBlockNumber,
      transaction.transactionId,
      transaction.sender,
      transaction.contract,
      transaction.action,
      transaction.payload,
    ));
  });

  // if there are transactions pending we produce a block
  if (newTransactions.length > 0) {
    await producePendingTransactions(newTransactions, timestamp);
  }
  producing = false;
};

const produceNewBlockSync = async (block, callback = null) => {
  if (stopRequested) return;
  producing = true;
  // the stream parsed transactions from the Steem blockchain
  const { transactions, timestamp } = block;
  const newTransactions = [];

  transactions.forEach((transaction) => {
    newTransactions.push(new Transaction(
      transaction.refSteemBlockNumber,
      transaction.transactionId,
      transaction.sender,
      transaction.contract,
      transaction.action,
      transaction.payload,
    ));
  });

  // if there are transactions pending we produce a block
  if (newTransactions.length > 0) {
    await producePendingTransactions(newTransactions, timestamp);
  }
  producing = false;

  if (callback) callback();
};

// when stopping, we wait until the current block is produced
function stop(callback) {
  stopRequested = true;

  if (producing) process.nextTick(() => stop(callback));

  stopRequested = false;
  callback();
}

async function startBlockProduction() {
  // get a block from the queue
  const block = blockProductionQueue.pop();

  if (block) {
    await produceNewBlockSync(block);
  }

  setTimeout(() => startBlockProduction(), 10);
}

function init(conf) {
  javascriptVMTimeout = conf.javascriptVMTimeout; // eslint-disable-line prefer-destructuring
}

ipc.onReceiveMessage((message) => {
  const {
    action,
    payload,
    // from,
  } = message;

  if (action === 'init') {
    init(payload);
    console.log('successfully initialized'); // eslint-disable-line no-console
    ipc.reply(message);
  } else if (action === 'stop') {
    stop(() => {
      console.log('successfully stopped'); // eslint-disable-line no-console
      ipc.reply(message);
    });
  } else if (action === PLUGIN_ACTIONS.CREATE_GENESIS_BLOCK) {
    createGenesisBlock(payload, (genBlock) => {
      ipc.reply(message, genBlock);
    });
  } else if (action === PLUGIN_ACTIONS.START_BLOCK_PRODUCTION) {
    startBlockProduction();
    ipc.reply(message);
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
