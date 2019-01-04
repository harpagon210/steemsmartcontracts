const { Transaction } = require('../libs/Transaction');
const { IPC } = require('../libs/IPC');
const BC_PLUGIN_NAME = require('./Blockchain.constants').PLUGIN_NAME;
const BC_PLUGIN_ACTIONS = require('./Blockchain.constants').PLUGIN_ACTIONS;

const PLUGIN_PATH = require.resolve(__filename);
const { PLUGIN_NAME, PLUGIN_ACTIONS } = require('./Streamer.simulator.constants');

const ipc = new IPC(PLUGIN_NAME);

let blockNumber = 2000000;
let transactionId = 0;
let stopGeneration = false;

function getCurrentBlock() {
  return blockNumber;
}

function stop() {
  stopGeneration = true;
  return getCurrentBlock();
}

function sendBlock(block) {
  return ipc.send(
    { to: BC_PLUGIN_NAME, action: BC_PLUGIN_ACTIONS.ADD_BLOCK_TO_QUEUE, payload: block },
  );
}

// get a block from the Steem blockchain
async function generateBlock() {
  if (stopGeneration) return;

  blockNumber += 1;
  const block = {
    // we timestamp the block with the Steem block timestamp
    timestamp: new Date().toISOString(),
    transactions: [],
  };

  for (let i = 0; i < 50; i += 1) {
    transactionId += 1;
    block.transactions.push(
      new Transaction(
        blockNumber,
        transactionId,
        `TestSender${transactionId}`,
        'accounts',
        'register',
        '',
      ),
    );
  }

  await sendBlock(block);
  setTimeout(() => generateBlock(), 3000);
}

// stream the Steem blockchain to find transactions related to the sidechain
function init() {
  generateBlock();
}

ipc.onReceiveMessage((message) => {
  const {
    action,
    payload,
    // from,
  } = message;

  switch (action) {
    case 'init':
      init(payload);
      ipc.reply(message);
      console.log('successfully initialized'); // eslint-disable-line no-console
      break;
    case 'stop':
      ipc.reply(message, stop());
      ipc.reply(message);
      console.log('successfully stopped'); // eslint-disable-line no-console
      break;
    default:
      ipc.reply(message);
      break;
  }
});

module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLUGIN_PATH = PLUGIN_PATH;
module.exports.PLUGIN_ACTIONS = PLUGIN_ACTIONS;
