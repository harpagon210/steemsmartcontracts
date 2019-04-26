const { Streamer } = require('../libs/Streamer');
const { Transaction } = require('../libs/Transaction');
const { IPC } = require('../libs/IPC');
const BC_PLUGIN_NAME = require('./Blockchain.constants').PLUGIN_NAME;
const BC_PLUGIN_ACTIONS = require('./Blockchain.constants').PLUGIN_ACTIONS;

const PLUGIN_PATH = require.resolve(__filename);
const { PLUGIN_NAME, PLUGIN_ACTIONS } = require('./Streamer.constants');

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
    const nbOperations = block.transactions[i].operations.length;

    for (let indexOp = 0; indexOp < nbOperations; indexOp += 1) {
      const operation = block.transactions[i].operations[indexOp];

      if (operation[0] === 'custom_json'
        || operation[0] === 'transfer'
        || operation[0] === 'comment'
        || operation[0] === 'comment_options'
        || operation[0] === 'vote'
      ) {
        try {
          let id = null;
          let sender = null;
          let recipient = null;
          let amount = null;
          let permlink = null;
          let sscTransactions = [];
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
            let jsonObj = JSON.parse(operation[1].json); // eslint-disable-line
            sscTransactions = Array.isArray(jsonObj) ? jsonObj : [jsonObj];
          } else if (operation[0] === 'transfer') {
            isSignedWithActiveKey = true;
            sender = operation[1].from;
            recipient = operation[1].to;
            amount = operation[1].amount; // eslint-disable-line prefer-destructuring
            const transferParams = JSON.parse(operation[1].memo);
            id = transferParams.id; // eslint-disable-line prefer-destructuring
            // multi transactions is not supported for the Steem transfers
            if (Array.isArray(transferParams.json) && transferParams.json.length === 1) {
              sscTransactions = transferParams.json;
            } else if (!Array.isArray(transferParams.json)) {
              sscTransactions = [transferParams.json];
            }
          } else if (operation[0] === 'comment') {
            sender = operation[1].author;
            const commentMeta = JSON.parse(operation[1].json_metadata);

            if (commentMeta && commentMeta.ssc) {
              id = commentMeta.ssc.id; // eslint-disable-line prefer-destructuring
              sscTransactions = commentMeta.ssc.transactions;
              permlink = operation[1].permlink; // eslint-disable-line prefer-destructuring
            } else {
              const commentBody = JSON.parse(operation[1].body);
              id = commentBody.id; // eslint-disable-line prefer-destructuring
              sscTransactions = Array.isArray(commentBody.json)
                ? commentBody.json : [commentBody.json];
            }
          } else if (operation[0] === 'comment_options') {
            id = `ssc-${chainIdentifier}`;
            sender = operation[1].author;
            permlink = operation[1].permlink; // eslint-disable-line prefer-destructuring

            const extensions = operation[1].extensions; // eslint-disable-line prefer-destructuring
            let beneficiaries = [];
            if (extensions
              && extensions[0] && extensions[0].length > 1
              && extensions[0][1].beneficiaries) {
              beneficiaries = extensions[0][1].beneficiaries; // eslint-disable-line
            }

            sscTransactions = [
              {
                contractName: 'comments',
                contractAction: 'commentOptions',
                contractPayload: {
                  maxAcceptedPayout: operation[1].max_accepted_payout,
                  allowVotes: operation[1].allow_votes,
                  allowCurationRewards: operation[1].allow_curation_rewards,
                  beneficiaries,
                },
              },
            ];
          } else if (operation[0] === 'vote') {
            id = `ssc-${chainIdentifier}`;
            sender = operation[1].voter;
            permlink = operation[1].permlink; // eslint-disable-line prefer-destructuring

            sscTransactions = [
              {
                contractName: 'comments',
                contractAction: 'vote',
                contractPayload: {
                  author: operation[1].author,
                  weight: operation[1].weight,
                },
              },
            ];
          }

          if (id && id === `ssc-${chainIdentifier}` && sscTransactions.length > 0) {
            const nbTransactions = sscTransactions.length;
            for (let index = 0; index < nbTransactions; index += 1) {
              const sscTransaction = sscTransactions[index];

              const { contractName, contractAction, contractPayload } = sscTransaction;
              if (contractName && typeof contractName === 'string'
                && contractAction && typeof contractAction === 'string'
                && contractPayload && typeof contractPayload === 'object') {
                contractPayload.recipient = recipient;
                contractPayload.amountSTEEMSBD = amount;
                contractPayload.isSignedWithActiveKey = isSignedWithActiveKey;
                contractPayload.permlink = permlink;

                if (recipient === null) {
                  delete contractPayload.recipient;
                }

                if (amount === null) {
                  delete contractPayload.amountSTEEMSBD;
                }

                if (isSignedWithActiveKey === null) {
                  delete contractPayload.isSignedWithActiveKey;
                }

                if (permlink === null) {
                  delete contractPayload.permlink;
                }

                // if multi transactions
                // append the index of the transaction to the Steem transaction id
                let SSCtransactionId = block.transaction_ids[i];

                if (nbOperations > 1) {
                  SSCtransactionId = `${SSCtransactionId}-${indexOp}`;
                }

                if (nbTransactions > 1) {
                  SSCtransactionId = `${SSCtransactionId}-${index}`;
                }

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

                newTransactions.push(
                  new Transaction(
                    refBlockNumber,
                    SSCtransactionId,
                    sender,
                    contractName,
                    contractAction,
                    JSON.stringify(contractPayload),
                  ),
                );
              }
            }
          }
        } catch (e) {
          // console.error('Invalid transaction', e); // eslint-disable-line no-console
        }
      }
    }
  }

  return newTransactions;
}

function sendBlock(block) {
  return ipc.send(
    { to: BC_PLUGIN_NAME, action: BC_PLUGIN_ACTIONS.ADD_BLOCK_TO_QUEUE, payload: block },
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
            refSteemBlockNumber: block.blockNumber,
            refSteemBlockId: block.block_id,
            prevRefSteemBlockId: block.previous,
            transactions: parseTransactions(
              currentBlock,
              block,
            ),
          },
        );
        currentBlock = block.blockNumber + 1;
      }
    }

    blockPoller = setTimeout(() => getBlock(reject), 100);
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
  streamer = new Streamer(node, startSteemBlock);
  streamer.init();

  return new Promise((resolve, reject) => { // eslint-disable-line no-unused-vars
    console.log('Starting Steem streaming at ', node); // eslint-disable-line no-console
    streamer.stream(reject);

    getBlock(reject);
  }).catch((err) => {
    if (blockPoller) clearTimeout(blockPoller);
    streamer.stop();
    console.error('Stream error:', err.message, 'with', node); // eslint-disable-line no-console
    streamNodes.push(streamNodes.shift());
    init(Object.assign({}, conf, { startSteemBlock: getCurrentBlock() }));
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
      console.log('successfully initialized'); // eslint-disable-line no-console
      break;
    case 'stop':
      ipc.reply(message, stop());
      console.log('successfully stopped'); // eslint-disable-line no-console
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
