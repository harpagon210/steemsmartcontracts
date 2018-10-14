const fs = require('fs');
const readline = require('readline');
const stream = require('stream');
const { IPC } = require('../libs/IPC');
const BC_PLUGIN_NAME = require('./Blockchain').PLUGIN_NAME;
const BC_PLUGIN_ACTIONS = require('./Blockchain').PLUGIN_ACTIONS;

const PLUGIN_NAME = 'Replay';
const PLUGIN_PATH = require.resolve(__filename);
const PLUGIN_ACTIONS = {
  GET_CURRENT_BLOCK: 'getCurrentBlock',
  GET_CURRENT_STEEM_BLOCK: 'getCurrentSteemBlock',
  REPLAY_FILE: 'replayFile',
};

const ipc = new IPC(PLUGIN_NAME);

let currentSteemBlock = 0;
let currentBlock = 0;
let filePath = '';

function getCurrentBlock() {
  return currentBlock;
}

function getCurrentSteemBlock() {
  return currentSteemBlock;
}

function sendBlock(block) {
  return ipc.send(
    { to: BC_PLUGIN_NAME, action: BC_PLUGIN_ACTIONS.ADD_BLOCK_TO_QUEUE, payload: block },
  );
}


function replayFile(callback) {
  let instream;
  let outstream;
  let rl;

  // make sure file exists
  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isFile()) {
      instream = fs.createReadStream(filePath);
      outstream = new stream(); // eslint-disable-line new-cap
      rl = readline.createInterface(instream, outstream);

      rl.on('line', async (line) => {
        if (line !== '') {
          const block = JSON.parse(line);
          const { blockNumber, timestamp, transactions } = block;
          if (blockNumber !== 0) {
            currentSteemBlock = transactions[0].refSteemBlockNumber;
            currentBlock = blockNumber;
            console.log(`block ${currentBlock} scheduled to replay`); // eslint-disable-line no-console
            await sendBlock({
              blockNumber,
              timestamp,
              transactions,
            });
          }
        }
      });

      rl.on('error', (error) => {
        callback(error);
      });

      rl.on('close', () => {
        callback(null);
      });
    } else {
      // file does not exist, so callback with null
      callback(`file located at ${filePath} does not exist`);
    }
  });
}

function init(payload) {
  const { blocksLogFilePath } = payload;
  filePath = blocksLogFilePath;
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
      ipc.reply(message, getCurrentSteemBlock());
      console.log('successfully stopped'); // eslint-disable-line no-console
      break;
    case PLUGIN_ACTIONS.REPLAY_FILE:
      replayFile((result) => {
        let finalResult = null;
        if (result === null) {
          finalResult = getCurrentBlock();
        }
        if (result) console.log('error encountered during the replay:', result); // eslint-disable-line no-console

        ipc.reply(message, finalResult);
      });
      break;
    case PLUGIN_ACTIONS.GET_CURRENT_BLOCK:
      ipc.reply(message, getCurrentBlock());
      break;
    default:
      ipc.reply(message);
      break;
  }
});

module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLUGIN_PATH = PLUGIN_PATH;
module.exports.PLUGIN_ACTIONS = PLUGIN_ACTIONS;
