const steem = require('steem');
const { streamNodes } = require('../config');

module.exports.SteemStreamer = class SteemStreamer {
  constructor(chainId, currentBlock) {
    this.chainId = chainId;
    this.currentBlock = currentBlock;
    this.stopStream = false;
  }

  // stream the Steem blockchain to find transactions related to the sidechain
  stream(callback) {
    const node = streamNodes[0];
    steem.api.setOptions({ url: node });

    return new Promise((resolve, reject) => { // eslint-disable-line no-unused-vars
      console.log('Starting Steem streaming at ', node); // eslint-disable-line no-console

      this.GetBlock(callback, reject);
    }).catch((err) => {
      console.error('Stream error:', err.message, 'with', node); // eslint-disable-line no-console
      streamNodes.push(streamNodes.shift());
      this.stream(callback);
    });
  }

  GetCurrentBlock() {
    return this.currentBlock;
  }

  StopStream() {
    this.stopStream = true;
  }

  // get a block from the Steem blockchain
  GetBlock(callback, reject) {
    try {
      if (this.stopStream) return null;
      steem.api.getDynamicGlobalProperties((err, blockchainProps) => { // eslint-disable-line
        if (err) return reject(err);

        const { last_irreversible_block_num } = blockchainProps; // eslint-disable-line camelcase

        if (this.currentBlock <= last_irreversible_block_num) { // eslint-disable-line camelcase
          steem.api.getBlock(this.currentBlock, (error, block) => {
            if (this.stopStream) return null;
            if (err) return reject(error);

            if (block) {
              callback(
                {
                  // we timestamp the block with the Steem block timestamp
                  timestamp: block.timestamp,
                  transactions: SteemStreamer.ParseTransactions(
                    this.chainId,
                    this.currentBlock,
                    block,
                  ),
                },
              );

              console.log('--------------------------------------------------------------------------'); // eslint-disable-line
              console.log('Steem last irreversible block number:', last_irreversible_block_num); // eslint-disable-line
              console.log('Steem blockchain is ', last_irreversible_block_num - this.currentBlock, 'blocks ahead'); // eslint-disable-line
              console.log('Last Steem block parsed:', this.currentBlock); // eslint-disable-line

              this.currentBlock += 1;
            }

            return this.GetBlock(callback, reject);
          });
        } else {
          return this.GetBlock(callback, reject);
        }
      });

      return null;
    } catch (e) {
      return reject(e);
    }
  }

  // parse the transactions found in a Steem block
  static ParseTransactions(chainId, refBlockNumber, block) {
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

            if (id && id === `ssc-${chainId}` && sscTransaction) {
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

                newTransactions.push({
                  // we use the Steem block number as the reference block
                  refBlockNumber,
                  // we give the Steem transaction id to be able to retrieve it later
                  transactionId: block.transaction_ids[i],
                  sender,
                  contractName,
                  contractAction,
                  contractPayload: JSON.stringify(contractPayload),
                });
              }
            }
          } catch (e) {
            // console.error('Invalid transaction', e); // eslint-disable-line no-console
          }
        }
      });
    }

    return newTransactions;
  }
};
