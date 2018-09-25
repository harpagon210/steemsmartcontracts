const { Streamer } = require('./Streamer');
const { streamNodes } = require('../config');

class BlockNumberException {
  constructor(message) {
    this.error = 'BlockNumberException';
    this.message = message;
  }
}

module.exports.SteemStreamer = class SteemStreamer {
  constructor(chainId, currentBlock) {
    this.chainId = chainId;
    this.currentBlock = currentBlock;
    this.stopStream = false;
    this.streamer = null;
    this.blockPoller = null;
  }

  // stream the Steem blockchain to find transactions related to the sidechain
  stream(callback) {
    const node = streamNodes[0];
    this.streamer = new Streamer(node, this.GetCurrentBlock());
    this.streamer.init();

    return new Promise((resolve, reject) => { // eslint-disable-line no-unused-vars
      console.log('Starting Steem streaming at ', node); // eslint-disable-line no-console
      this.streamer.stream(reject);

      this.GetBlock(callback, reject);
    }).catch((err) => {
      if (this.blockPoller) clearTimeout(this.blockPoller);
      this.streamer.stop();
      console.error('Stream error:', err.message, 'with', node); // eslint-disable-line no-console
      streamNodes.push(streamNodes.shift());
      this.stream(callback);
    });
  }

  GetCurrentBlock() {
    return this.currentBlock;
  }

  StopStream() {
    if (this.blockPoller) clearTimeout(this.blockPoller);
    if (this.streamer) this.streamer.stop();
    this.stopStream = true;
  }

  // get a block from the Steem blockchain
  GetBlock(callback, reject) {
    try {
      if (this.stopStream) return;

      const block = this.streamer.getNextBlock();
      if (block && !this.stopStream) {
        callback(
          {
            // we timestamp the block with the Steem block timestamp
            timestamp: block.timestamp,
            transactions: this.ParseTransactions(
              this.currentBlock,
              block,
            ),
          },
        );

        console.log('Last Steem block parsed:', block.blockNumber); // eslint-disable-line
        console.log('-----------------------------------------------------------------------'); // eslint-disable-line
        if (this.currentBlock !== block.blockNumber) {
          throw new BlockNumberException(`there is a discrepancy between the current block number (${this.currentBlock}) and the last streamed block number (${block.blockNumber})`);
        } else {
          this.currentBlock = block.blockNumber + 1;
        }
      }

      this.blockPoller = setTimeout(() => this.GetBlock(callback, reject), 500);
    } catch (err) {
      reject(err);
    }
  }

  // parse the transactions found in a Steem block
  ParseTransactions(refBlockNumber, block) {
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


            if (id && id === `ssc-${this.chainId}` && sscTransaction) {
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
