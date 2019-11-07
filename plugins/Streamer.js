const dsteem = require('dsteem');
const { Queue } = require('../libs/Queue');
const { Transaction } = require('../libs/Transaction');
const { IPC } = require('../libs/IPC');
const BC_PLUGIN_NAME = require('./Blockchain.constants').PLUGIN_NAME;
const BC_PLUGIN_ACTIONS = require('./Blockchain.constants').PLUGIN_ACTIONS;

const PLUGIN_PATH = require.resolve(__filename);
const { PLUGIN_NAME, PLUGIN_ACTIONS } = require('./Streamer.constants');

const ipc = new IPC(PLUGIN_NAME);
let client = null;
class ForkException {
  constructor(message) {
    this.error = 'ForkException';
    this.message = message;
  }
}

let currentSteemBlock = 0;
let steemHeadBlockNumber = 0;
let stopStream = false;
const antiForkBufferMaxSize = 2;
const buffer = new Queue(antiForkBufferMaxSize);
let chainIdentifier = '';
let blockStreamerHandler = null;
let updaterGlobalPropsHandler = null;
let lastBlockSentToBlockchain = 0;

const getCurrentBlock = () => currentSteemBlock;

const stop = () => {
  stopStream = true;
  if (blockStreamerHandler) clearTimeout(blockStreamerHandler);
  if (updaterGlobalPropsHandler) clearTimeout(updaterGlobalPropsHandler);
  return lastBlockSentToBlockchain;
};

// parse the transactions found in a Steem block
const parseTransactions = (refBlockNumber, block) => {
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
            const commentMeta = operation[1].json_metadata !== '' ? JSON.parse(operation[1].json_metadata) : null;

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
            sender = 'null';
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
                  author: operation[1].author,
                  maxAcceptedPayout: operation[1].max_accepted_payout,
                  allowVotes: operation[1].allow_votes,
                  allowCurationRewards: operation[1].allow_curation_rewards,
                  beneficiaries,
                },
              },
            ];
          } else if (operation[0] === 'vote') {
            id = `ssc-${chainIdentifier}`;
            sender = 'null';
            permlink = operation[1].permlink; // eslint-disable-line prefer-destructuring

            sscTransactions = [
              {
                contractName: 'comments',
                contractAction: 'vote',
                contractPayload: {
                  voter: operation[1].voter,
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

                // callingContractInfo is a reserved property
                // it is used to provide information about a contract when calling
                // a contract action from another contract
                if (contractPayload.callingContractInfo) {
                  delete contractPayload.callingContractInfo;
                }

                // set the sender to null when calling the comment action
                // this way we allow people to create comments only via the comment operation
                if (operation[0] === 'comment' && contractName === 'comments' && contractAction === 'comment') {
                  contractPayload.author = sender;
                  sender = 'null';
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

                /* console.log( // eslint-disable-line no-console
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
                ); */

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
};

const sendBlock = block => ipc.send(
  { to: BC_PLUGIN_NAME, action: BC_PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block },
);

// process Steem block
const processBlock = async (block) => {
  if (stopStream) return;

  await sendBlock(
    {
      // we timestamp the block with the Steem block timestamp
      timestamp: block.timestamp,
      refSteemBlockNumber: block.blockNumber,
      refSteemBlockId: block.block_id,
      prevRefSteemBlockId: block.previous,
      transactions: parseTransactions(
        block.blockNumber,
        block,
      ),
    },
  );

  lastBlockSentToBlockchain = block.blockNumber;
};

const updateGlobalProps = async () => {
  try {
    if (client !== null) {
      const globProps = await client.database.getDynamicGlobalProperties();
      steemHeadBlockNumber = globProps.head_block_number;
      const delta = steemHeadBlockNumber - currentSteemBlock;
      // eslint-disable-next-line
      console.log(`head_block_number ${steemHeadBlockNumber}`, `currentBlock ${currentSteemBlock}`, `Steem blockchain is ${delta > 0 ? delta : 0} blocks ahead`);
    }
    updaterGlobalPropsHandler = setTimeout(() => updateGlobalProps(), 10000);
  } catch (ex) {
    console.error('An error occured while trying to fetch the Steem blockchain global properties'); // eslint-disable-line no-console
  }
};

const addBlockToBuffer = async (block) => {
  const finalBlock = block;
  finalBlock.blockNumber = currentSteemBlock;

  // if the buffer is full
  if (buffer.size() + 1 > antiForkBufferMaxSize) {
    const lastBlock = buffer.last();

    // we can send the oldest block of the buffer to the blockchain plugin
    if (lastBlock) {
      await processBlock(lastBlock);
    }
  }
  buffer.push(finalBlock);
};

const streamBlocks = async (reject) => {
  if (stopStream) return;
  try {
    const block = await client.database.getBlock(currentSteemBlock);
    let addBlockToBuf = false;

    if (block) {
      // check if there are data in the buffer
      if (buffer.size() > 0) {
        const lastBlock = buffer.first();
        if (lastBlock.block_id === block.previous) {
          addBlockToBuf = true;
        } else {
          buffer.clear();
          throw new ForkException(`a fork happened between block ${currentSteemBlock - 1} and block ${currentSteemBlock}`);
        }
      } else {
        // get the previous block
        const prevBlock = await client.database.getBlock(currentSteemBlock - 1);

        if (prevBlock && prevBlock.block_id === block.previous) {
          addBlockToBuf = true;
        } else {
          throw new ForkException(`a fork happened between block ${currentSteemBlock - 1} and block ${currentSteemBlock}`);
        }
      }

      // add the block to the buffer
      if (addBlockToBuf === true) {
        await addBlockToBuffer(block);
      }
      currentSteemBlock += 1;
      streamBlocks(reject);
    } else {
      blockStreamerHandler = setTimeout(() => {
        streamBlocks(reject);
      }, 500);
    }
  } catch (err) {
    reject(err);
  }
};

const initSteemClient = (node, steemAddressPrefix, steemChainId) => {
  client = new dsteem.Client(node, {
    addressPrefix: steemAddressPrefix,
    chainId: steemChainId,
  });
};

const startStreaming = (conf) => {
  const {
    streamNodes,
    chainId,
    startSteemBlock,
    steemAddressPrefix,
    steemChainId,
  } = conf;
  currentSteemBlock = startSteemBlock;
  chainIdentifier = chainId;
  const node = streamNodes[0];
  initSteemClient(node, steemAddressPrefix, steemChainId);

  return new Promise((resolve, reject) => { // eslint-disable-line no-unused-vars
    console.log('Starting Steem streaming at ', node); // eslint-disable-line no-console

    streamBlocks(reject);
  }).catch((err) => {
    console.error('Stream error:', err.message, 'with', node); // eslint-disable-line no-console
    streamNodes.push(streamNodes.shift());
    startStreaming(Object.assign({}, conf, { startSteemBlock: getCurrentBlock() }));
  });
};

// stream the Steem blockchain to find transactions related to the sidechain
const init = (conf) => {
  startStreaming(conf);
  updateGlobalProps();
};

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
