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

  // get a block from the Steem blockchain
  GetBlock(callback, reject) {
    steem.api.getDynamicGlobalProperties((err, blockchainProps) => { // eslint-disable-line
      if (err) return reject(err);

      const { last_irreversible_block_num } = blockchainProps; // eslint-disable-line camelcase
      // console.log('last_irreversible_block_num: ', last_irreversible_block_num);

      if (this.currentBlock <= last_irreversible_block_num) { // eslint-disable-line camelcase
        console.log('getting Steem block ', this.currentBlock); // eslint-disable-line no-console
        steem.api.getBlock(this.currentBlock, (error, block) => { // eslint-disable-line camelcase
          if (err) return reject(error);

          callback(
            {
              timestamp: block.timestamp, // we timestamp the block with the Steem block timestamp
              transactions: SteemStreamer.ParseTransactions(
                this.currentBlock,
                block,
              ),
            },
          );

          this.currentBlock += 1;
          return this.GetBlock(callback, reject);
        });
      } else {
        return this.GetBlock(callback, reject);
      }
    });
  }

  // parse the transactions found in a Steem block
  static ParseTransactions(refBlockNumber, block) {
    const newTransactions = [];
    const transactionsLength = block.transactions.length;

    for (let i = 0; i < transactionsLength; i += 1) {
      // console.log(block.transactionIds)
      block.transactions[i].operations.forEach((operation) => {
        // ##STEEMCONTRACTSBEGIN##CONTRACTNAME##CONTRACTACTION##PAYLOAD##STEEMCONTRACTSEND##
        if (operation[0] === 'comment') {
          // console.log(operation)
          let { author, body } = operation[1]; // eslint-disable-line prefer-const
          body = body.trim();

          if (body.startsWith('##STEEMCONTRACTSBEGIN##') && body.endsWith('##STEEMCONTRACTSEND##')) {
            body = body.replace('##STEEMCONTRACTSBEGIN##', '');
            body = body.replace('##STEEMCONTRACTSEND##', '');
            const steemContractParams = body.split('##');
            if (steemContractParams.length === 3) {
              const contractName = steemContractParams[0];
              const contractAction = steemContractParams[1];
              const contractPayload = steemContractParams[2];

              console.log( // eslint-disable-line no-console
                'author:',
                author,
                'contractName:',
                contractName,
                'contractAction:', contractAction, 'contractPayload:', contractPayload,
              );
              newTransactions.push({
                // we use the Steem block number as the reference block
                refBlockNumber,
                // we give the transaction the Steem transaction id to be able to retrieve it later
                transactionId: block.transaction_ids[i],
                author,
                contractName,
                contractAction,
                contractPayload,
              });
            }
          }
        }
      });
    }

    return newTransactions;
  }
};
