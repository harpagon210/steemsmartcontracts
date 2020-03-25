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
let hiveClient = null;


let currentHiveBlock = 0;
let currentBlock = 0;
let filePath = '';
let hiveNode = '';

function getCurrentBlock() {
  return currentBlock;
}

function getcurrentHiveBlock() {
  return currentHiveBlock;
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
            refHiveBlockNumber,
            refHiveBlockId,
            prevRefHiveBlockId,
            virtualTransactions,
          } = block;

          let finalRefHiveBlockId = refHiveBlockId;
          let finalPrevRefHiveBlockId = prevRefHiveBlockId;

          if (blockNumber !== 0) {
            currentHiveBlock = refHiveBlockNumber;
            currentBlock = blockNumber;
            console.log(`replaying block ${currentBlock} / ${lastBockNumber}`); // eslint-disable-line no-console

            if (hiveClient !== null && finalRefHiveBlockId === undefined) {
              const hiveBlock = await hiveClient.database.getBlock(refHiveBlockNumber);
              finalRefHiveBlockId = hiveBlock.block_id;
              finalPrevRefHiveBlockId = hiveBlock.previous;
            }

            await sendBlock({
              blockNumber,
              timestamp,
              refHiveBlockNumber,
              refHiveBlockId: finalRefHiveBlockId,
              prevRefHiveBlockId: finalPrevRefHiveBlockId,
              transactions,
              virtualTransactions,
            });
          }
        }
        lr.resume();
      });

      lr.on('error', (error) => {
        callback(error);
      });

      lr.on('end', () => {
        console.log('Replay done'); // eslint-disable-line no-console
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
  hiveNode = streamNodes[0]; // eslint-disable-line
  hiveClient = new dsteem.Client(hiveNode);
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
      ipc.reply(message, getcurrentHiveBlock() + 1);
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
