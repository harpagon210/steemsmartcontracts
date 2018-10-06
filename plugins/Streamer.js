const { Streamer } = require('../libs/Streamer');
const { Transaction } = require('../libs/Transaction');
const { IPC } = require('../libs/IPC');
const BC_PLUGIN_NAME = require('./Blockchain').PLUGIN_NAME;
const BC_PLUGIN_ACTIONS = require('./Blockchain').PLUGIN_ACTIONS;

const PLUGIN_NAME = 'Streamer';
const PLUGIN_PATH = require.resolve(__filename);
const PLUGIN_ACTIONS = {
  GET_CURRENT_BLOCK: 'getCurrentBlock',
};

const ipc = new IPC(PLUGIN_NAME);

class BlockNumberException {
  constructor(message) {
    this.error = 'BlockNumberException';
    this.message = message;
  }
}

let currentBlock = 0;
let chainIdentifier = '';
let stopStream = false;
let streamer = null;
let blockPoller = null;

function getCurrentBlock() {
  return currentBlock;
}

function stop() {
  stopStream = true;
  if (blockPoller) clearTimeout(blockPoller);
  if (streamer) streamer.stop();
  return getCurrentBlock();
}

// parse the transactions found in a Steem block
function parseTransactions(refBlockNumber, block) {
  const newTransactions = [];
  const transactionsLength = block.transactions.length;

  for (let i = 0; i < transactionsLength; i += 1) {
    block.transactions[i].operations.forEach((operation) => { // eslint-disable-line no-loop-func
      if (operation[0] === 'custom_json' || operation[0] === 'transfer' || operation[0] === 'comment') {
        try {
          let id = null;
          let sender = null;
          let recipient = null;
          let amount = null;
          let sscTransaction = null;
          let isSignedWithActiveKey = null;

          if (operation[0] === 'custom_json') {
            id = operation[1].id; // eslint-disable-line prefer-destructuring
            if (operation[1].required_auths.length > 0) {
              sender = operation[1].required_auths[0]; // eslint-disable-line
              isSignedWithActiveKey = true;
            } else {
              sender = operation[1].required_posting_auths[0]; // eslint-disable-line
              isSignedWithActiveKey = false;
            }
            sscTransaction = JSON.parse(operation[1].json); // eslint-disable-line
          } else if (operation[0] === 'transfer') {
            sender = operation[1].from;
            recipient = operation[1].to;
            amount = operation[1].amount; // eslint-disable-line prefer-destructuring
            const transferParams = JSON.parse(operation[1].memo);
            id = transferParams.id; // eslint-disable-line prefer-destructuring
            sscTransaction = transferParams.json; // eslint-disable-line prefer-destructuring
          } else if (operation[0] === 'comment') {
            sender = operation[1].author;
            const transferParams = JSON.parse(operation[1].body);
            id = transferParams.id; // eslint-disable-line prefer-destructuring
            sscTransaction = transferParams.json; // eslint-disable-line prefer-destructuring
          }


          if (id && id === `ssc-${chainIdentifier}` && sscTransaction) {
            const { contractName, contractAction, contractPayload } = sscTransaction;
            if (contractName && typeof contractName === 'string'
              && contractAction && typeof contractAction === 'string'
              && contractPayload && typeof contractPayload === 'object') {
              console.log( // eslint-disable-line no-console
                'sender:',
                sender,
                'recipient',
                recipient,
                'amount',
                amount,
                'contractName:',
                contractName,
                'contractAction:',
                contractAction,
                'contractPayload:',
                contractPayload,
              );

              contractPayload.recipient = recipient;
              contractPayload.amountSTEEMSBD = amount;
              contractPayload.isSignedWithActiveKey = isSignedWithActiveKey;

              if (recipient === null) {
                delete contractPayload.recipient;
              }

              if (amount === null) {
                delete contractPayload.amountSTEEMSBD;
              }

              if (isSignedWithActiveKey === null) {
                delete contractPayload.isSignedWithActiveKey;
              }

              newTransactions.push(
                new Transaction(
                  refBlockNumber,
                  block.transaction_ids[i],
                  sender,
                  contractName,
                  contractAction,
                  JSON.stringify(contractPayload),
                ),
              );
            }
          }
        } catch (e) {
          // IPC.error('Invalid transaction', e); // eslint-disable-line no-console
        }
      }
    });
  }

  return newTransactions;
}

function sendBlock(block) {
  return ipc.send(
    { to: BC_PLUGIN_NAME, action: BC_PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK, payload: block },
  );
}

// get a block from the Steem blockchain
async function getBlock(reject) {
  try {
    if (stopStream) return;

    const block = streamer.getNextBlock();
    if (block && !stopStream) {
      console.log(`Last Steem block parsed: ${block.blockNumber}`); // eslint-disable-line
      if (currentBlock !== block.blockNumber) {
        throw new BlockNumberException(`there is a discrepancy between the current block number (${currentBlock}) and the last streamed block number (${block.blockNumber})`);
      } else {
        await sendBlock(
          {
            // we timestamp the block with the Steem block timestamp
            timestamp: block.timestamp,
            transactions: parseTransactions(
              currentBlock,
              block,
            ),
          },
        );
        currentBlock = block.blockNumber + 1;
      }
    }

    blockPoller = setTimeout(() => getBlock(reject), 500);
  } catch (err) {
    reject(err);
  }
}

// stream the Steem blockchain to find transactions related to the sidechain
function init(conf) {
  const {
    streamNodes,
    chainId,
    startSteemBlock,
  } = conf;
  currentBlock = startSteemBlock;
  chainIdentifier = chainId;
  const node = streamNodes[0];
  streamer = new Streamer(node, getCurrentBlock());
  streamer.init();

  return new Promise((resolve, reject) => { // eslint-disable-line no-unused-vars
    console.log('Starting Steem streaming at ', node); // eslint-disable-line no-console
    streamer.stream(reject);

    getBlock(reject);
  }).catch((err) => {
    if (blockPoller) clearTimeout(blockPoller);
    streamer.stop();
    IPC.error('Stream error:', err.message, 'with', node); // eslint-disable-line no-console
    streamNodes.push(streamNodes.shift());
    init(conf);
  });
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
      console.log('successfully initialized');
      break;
    case 'stop':
      ipc.reply(message, stop());
      console.log('successfully stopped');
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
