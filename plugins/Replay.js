const fs = require('fs');
const readLastLines = require('read-last-lines');
const LineByLineReader = require('line-by-line');
const { IPC } = require('../libs/IPC');
const BC_PLUGIN_NAME = require('./Blockchain.constants').PLUGIN_NAME;
const BC_PLUGIN_ACTIONS = require('./Blockchain.constants').PLUGIN_ACTIONS;
const { PLUGIN_NAME, PLUGIN_ACTIONS } = require('./Replay.constants');

const PLUGIN_PATH = require.resolve(__filename);

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
    { to: BC_PLUGIN_NAME, action: BC_PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block },
  );
}


function replayFile(callback) {
  let lr;

  // make sure file exists
  fs.stat(filePath, async (err, stats) => {
    if (!err && stats.isFile()) {
      // read last line of the file to determine the number of blocks to replay
      const lastLine = await readLastLines.read(filePath, 1);
      const lastBlock = JSON.parse(lastLine);
      const lastBockNumber = lastBlock.blockNumber;

      // read the file from the start
      lr = new LineByLineReader(filePath);

      lr.on('line', async (line) => {
        lr.pause();
        if (line !== '') {
          const block = JSON.parse(line);
          const { blockNumber, timestamp, transactions } = block;
          if (blockNumber !== 0) {
            currentSteemBlock = transactions[0].refSteemBlockNumber;
            currentBlock = blockNumber;
            console.log(`replaying block ${currentBlock} / ${lastBockNumber}`); // eslint-disable-line no-console
            await sendBlock({
              blockNumber,
              timestamp,
              transactions,
            });
          }
        }
        lr.resume();
      });

      lr.on('error', (error) => {
        callback(error);
      });

      lr.on('end', () => {
        console.log('Replay done');
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
