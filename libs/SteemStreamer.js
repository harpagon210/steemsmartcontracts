const steem = require('steem');
const { streamNodes } = require('../config');

module.exports.SteemStreamer = class SteemStreamer {
  constructor(currentBlock) {
    this.currentBlock = currentBlock;
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

  // get a block from the Steem blockchain
  GetBlock(callback, reject) {
    try {
      steem.api.getDynamicGlobalProperties((err, blockchainProps) => { // eslint-disable-line
        if (err) return reject(err);

        const { last_irreversible_block_num } = blockchainProps; // eslint-disable-line camelcase
        console.log('--------------------------------------------------------------------------');
        console.log('Steem last irreversible block number:', last_irreversible_block_num);
        console.log('Steem blockchain is ', last_irreversible_block_num - this.currentBlock, 'blocks ahead'); // eslint-disable-line camelcase

        if (this.currentBlock <= last_irreversible_block_num) { // eslint-disable-line camelcase
          console.log('Getting Steem block ', this.currentBlock); // eslint-disable-line no-console
          steem.api.getBlock(this.currentBlock, (error, block) => {
            if (err) return reject(error);

            if (block) {
              callback(
                {
                  // we timestamp the block with the Steem block timestamp
                  timestamp: block.timestamp,
                  transactions: SteemStreamer.ParseTransactions(
                    this.currentBlock,
                    block,
                  ),
                },
              );

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
  static ParseTransactions(refBlockNumber, block) {
    const newTransactions = [];
    const transactionsLength = block.transactions.length;

    for (let i = 0; i < transactionsLength; i += 1) {
      // console.log(block.transactionIds)
      block.transactions[i].operations.forEach((operation) => {
        if (operation[0] === 'custom_json') {
          // console.log(operation)
          let { required_posting_auths, id, json } = operation[1]; // eslint-disable-line prefer-const

          if (id === 'ssc') {
            try {
              const sscTransatcion = JSON.parse(json);
              const { contractName, contractAction, contractPayload } = sscTransatcion;
              if (contractName && typeof contractName === 'string'
                  && contractAction && typeof contractAction === 'string'
                  && contractPayload && typeof contractPayload === 'string') {
  
                console.log( // eslint-disable-line no-console
                  'author:',
                  required_posting_auths[0],
                  'contractName:',
                  contractName,
                  'contractAction:', 
                  contractAction, 
                  'contractPayload:', 
                  contractPayload,
                );
                newTransactions.push({
                  // we use the Steem block number as the reference block
                  refBlockNumber,
                  // we give the transaction the Steem transaction id to be able to retrieve it later
                  transactionId: block.transaction_ids[i],
                  author: required_posting_auths[0],
                  contractName,
                  contractAction,
                  contractPayload,
                });
              }
            } catch(e) {
              console.error('Invalid transaction', json); // eslint-disable-line no-console
            }
          }
        }
      });
    }

    return newTransactions;
  }
};
