const SHA256 = require('crypto-js/sha256');
const enchex = require('crypto-js/enc-hex');

const { SmartContracts } = require('./SmartContracts');
const { BlockProduction } = require('./BlockProduction');

class Block {
  constructor(timestamp, transactions, previousBlockNumber, previousHash = '') {
    this.blockNumber = previousBlockNumber + 1;
    this.refSteemBlockNumber = transactions.length > 0 ? transactions[0].refSteemBlockNumber : 0;
    this.previousHash = previousHash;
    this.timestamp = timestamp;
    this.transactions = transactions;
    this.hash = this.calculateHash();
    this.merkleRoot = '';
    this.signature = '';
  }

  // calculate the hash of the block
  calculateHash() {
    return SHA256(
      this.previousHash
      + this.blockNumber.toString()
      + this.refSteemBlockNumber.toString()
      + this.timestamp
      + JSON.stringify(this.transactions) // eslint-disable-line
    )
      .toString(enchex);
  }

  // calculate the Merkle root of the block ((#TA + #TB) + (#TC + #TD) )
  calculateMerkleRoot(transactions) {
    if (transactions.length <= 0) return '';

    const tmpTransactions = transactions.slice(0, transactions.length);
    const newTransactions = [];
    const nbTransactions = tmpTransactions.length;

    for (let index = 0; index < nbTransactions; index += 2) {
      const left = tmpTransactions[index].hash;
      const right = index + 1 < nbTransactions ? tmpTransactions[index + 1].hash : left;

      newTransactions.push({ hash: SHA256(left + right).toString(enchex) });
    }

    if (newTransactions.length === 1) {
      return newTransactions[0].hash;
    }

    return this.calculateMerkleRoot(newTransactions);
  }

  // produce the block (deploy a smart contract or execute a smart contract)
  async produceBlock(ipc, jsVMTimeout, activeSigningKey) {
    const nbTransactions = this.transactions.length;
    const bp = new BlockProduction(ipc, this.refSteemBlockNumber);

    for (let i = 0; i < nbTransactions; i += 1) {
      const transaction = this.transactions[i];
      const {
        sender,
        contract,
        action,
        payload,
      } = transaction;

      let results = null;

      if (sender && contract && action) {
        if (contract === 'contract' && action === 'deploy' && payload) {
          const authorizedAccountContractDeployment = ['null', 'steemsc', 'steem-peg'];

          if (authorizedAccountContractDeployment.includes(sender)) {
            results = await SmartContracts.deploySmartContract( // eslint-disable-line
              ipc, transaction, jsVMTimeout,
            );
          } else {
            results = { logs: { errors: ['the contract deployment is currently unavailable'] } };
          }
        } else if (contract === 'blockProduction' && payload) {
          results = await bp.processTransaction(transaction); // eslint-disable-line
        } else {
          results = await SmartContracts.executeSmartContract(// eslint-disable-line
            ipc, transaction, jsVMTimeout,
          );
        }
      } else {
        results = { logs: { errors: ['the parameters sender, contract and action are required'] } };
      }

      // console.log('transac logs', results.logs);
      transaction.addLogs(results.logs);
      transaction.executedCodeHash = results.executedCodeHash || '';
      transaction.calculateHash();
    }

    // reward block producers
    // await bp.rewardBlockProducers(); // eslint-disable-line

    this.hash = this.calculateHash();
    this.merkleRoot = this.calculateMerkleRoot(this.transactions);
    const buffMR = Buffer.from(this.merkleRoot, 'hex');
    this.signature = activeSigningKey.sign(buffMR).toString();
  }
}

module.exports.Block = Block;
