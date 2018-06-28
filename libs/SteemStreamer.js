const steem = require('steem');
const { streamNodes } = require('../config');

module.exports.SteemStreamer = class SteemStreamer {
  constructor(currentBlock) {
    this.currentBlock = currentBlock;
  }

  stream(callback) {
    const node = streamNodes[0];
    steem.api.setOptions({ url: node });

    return new Promise((resolve, reject) => { // eslint-disable-line no-unused-vars
      console.log('Starting Steem streaming at ', node); // eslint-disable-line no-console
      this.GetBlock(callback);
    }).catch((err) => {
      console.error('Stream error:', err.message, 'with', node); // eslint-disable-line no-console
      streamNodes.push(streamNodes.shift());
      this.stream(callback);
    });
  }

  GetBlock(callback) {
    return new Promise((resolve, reject) => {
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
                timestamp: block.timestamp,
                transactions: SteemStreamer.ParseTransactions(
                  this.currentBlock,
                  block,
                ),
              },
            );

            this.currentBlock += 1;
            return this.GetBlock(callback);
          });
        } else {
          return this.GetBlock(callback);
        }
      });
    });
  }

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
                refBlockNumber,
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
