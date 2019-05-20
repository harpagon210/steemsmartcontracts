const fs = require('fs');
const readLastLines = require('read-last-lines');
const LineByLineReader = require('line-by-line');
const dsteem = require('dsteem');
const { IPC } = require('../libs/IPC');
const BC_PLUGIN_NAME = require('./Blockchain.constants').PLUGIN_NAME;
const BC_PLUGIN_ACTIONS = require('./Blockchain.constants').PLUGIN_ACTIONS;
const { PLUGIN_NAME, PLUGIN_ACTIONS } = require('./Replay.constants');

const PLUGIN_PATH = require.resolve(__filename);

const ipc = new IPC(PLUGIN_NAME);
let steemClient = null;


let currentSteemBlock = 0;
let currentBlock = 0;
let filePath = '';
let steemNode = '';

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
          const {
            blockNumber,
            timestamp,
            transactions,
            refSteemBlockNumber,
            refSteemBlockId,
            prevRefSteemBlockId,
          } = block;

          let finalRefSteemBlockId = refSteemBlockId;
          let finalPrevRefSteemBlockId = prevRefSteemBlockId;

          if (blockNumber !== 0) {
            currentSteemBlock = refSteemBlockNumber;
            currentBlock = blockNumber;
            console.log(`replaying block ${currentBlock} / ${lastBockNumber}`); // eslint-disable-line no-console

            if (steemClient !== null && finalRefSteemBlockId === undefined) {
              const steemBlock = await steemClient.database.getBlock(refSteemBlockNumber);
              finalRefSteemBlockId = steemBlock.block_id;
              finalPrevRefSteemBlockId = steemBlock.previous;
            }

            await sendBlock({
              blockNumber,
              timestamp,
              refSteemBlockNumber,
              refSteemBlockId: finalRefSteemBlockId,
              prevRefSteemBlockId: finalPrevRefSteemBlockId,
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
  const { blocksLogFilePath, streamNodes } = payload;
  filePath = blocksLogFilePath;
  steemNode = streamNodes[0]; // eslint-disable-line
  steemClient = process.env.NODE_ENV === 'test' ? new dsteem.Client('https://testnet.steemitdev.com', { addressPrefix: 'TST', chainId: '46d82ab7d8db682eb1959aed0ada039a6d49afa1602491f93dde9cac3e8e6c32' }) : new dsteem.Client(steemNode);
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
      ipc.reply(message, getCurrentSteemBlock() + 1);
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
