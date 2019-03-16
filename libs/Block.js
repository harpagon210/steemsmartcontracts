const SHA256 = require('crypto-js/sha256');
const enchex = require('crypto-js/enc-hex');

const { SmartContracts } = require('./SmartContracts');
const { BlockProduction } = require('./BlockProduction');

const DB_PLUGIN_NAME = require('../plugins/Database.constants').PLUGIN_NAME;
const DB_PLUGIN_ACTIONS = require('../plugins/Database.constants').PLUGIN_ACTIONS;

class Block {
  constructor(timestamp, refSteemBlockNumber, refSteemBlockId, prevRefSteemBlockId, transactions, previousBlockNumber, previousHash = '', previousDatabaseHash = '') {
    this.blockNumber = previousBlockNumber + 1;
    this.refSteemBlockNumber = refSteemBlockNumber;
    this.refSteemBlockId = refSteemBlockId;
    this.prevRefSteemBlockId = prevRefSteemBlockId;
    this.previousHash = previousHash;
    this.previousDatabaseHash = previousDatabaseHash;
    this.timestamp = timestamp;
    this.transactions = transactions;
    this.hash = this.calculateHash();
    this.databaseHash = '';
    this.merkleRoot = '';
    this.signature = '';
  }

  // calculate the hash of the block
  calculateHash() {
    return SHA256(
      this.previousHash
      + this.previousDatabaseHash
      + this.blockNumber.toString()
      + this.refSteemBlockNumber.toString()
      + this.refSteemBlockId
      + this.prevRefSteemBlockId
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

      const leftDbHash = tmpTransactions[index].databaseHash;
      const rightDbHash = index + 1 < nbTransactions
        ? tmpTransactions[index + 1].databaseHash
        : leftDbHash;

      newTransactions.push({
        hash: SHA256(left + right).toString(enchex),
        databaseHash: SHA256(leftDbHash + rightDbHash).toString(enchex),
      });
    }

    if (newTransactions.length === 1) {
      return {
        hash: newTransactions[0].hash,
        databaseHash: newTransactions[0].databaseHash,
      };
    }

    return this.calculateMerkleRoot(newTransactions);
  }

  // produce the block (deploy a smart contract or execute a smart contract)
  async produceBlock(ipc, jsVMTimeout, activeSigningKey) {
    const nbTransactions = this.transactions.length;
    const bp = new BlockProduction(ipc, this.refSteemBlockNumber);

    let currentDatabaseHash = this.previousDatabaseHash;

    for (let i = 0; i < nbTransactions; i += 1) {
      const transaction = this.transactions[i];
      const {
        sender,
        contract,
        action,
        payload,
      } = transaction;

      let results = null;

      // init the database hash for that transactions
      await ipc.send({ // eslint-disable-line
        to: DB_PLUGIN_NAME,
        action: DB_PLUGIN_ACTIONS.INIT_DATABASE_HASH,
        payload: currentDatabaseHash,
      });

      if (sender && contract && action) {
        if (contract === 'contract' && action === 'deploy' && payload) {
          const authorizedAccountContractDeployment = ['null', 'steemsc', 'steem-peg'];

          if (authorizedAccountContractDeployment.includes(sender)) {
            results = await SmartContracts.deploySmartContract( // eslint-disable-line
              ipc, transaction, this.timestamp,
              this.refSteemBlockId, this.prevRefSteemBlockId, jsVMTimeout,
            );
          } else {
            results = { logs: { errors: ['the contract deployment is currently unavailable'] } };
          }
        } else if (contract === 'blockProduction' && payload) {
          // results = await bp.processTransaction(transaction); // eslint-disable-line
          results = { logs: { errors: ['blockProduction contract not available'] } };
        } else {
          results = await SmartContracts.executeSmartContract(// eslint-disable-line
            ipc, transaction, this.timestamp,
            this.refSteemBlockId, this.prevRefSteemBlockId, jsVMTimeout,
          );
        }
      } else {
        results = { logs: { errors: ['the parameters sender, contract and action are required'] } };
      }

      // get the database hash
      const res = await ipc.send({ // eslint-disable-line
        to: DB_PLUGIN_NAME,
        action: DB_PLUGIN_ACTIONS.GET_DATABASE_HASH,
        payload: {
        },
      });

      currentDatabaseHash = res.payload;


      // console.log('transac logs', results.logs);
      transaction.addLogs(results.logs);
      transaction.executedCodeHash = results.executedCodeHash || '';
      transaction.databaseHash = currentDatabaseHash;

      transaction.calculateHash();
    }

    // reward block producers
    await bp.rewardBlockProducers(); // eslint-disable-line

    this.hash = this.calculateHash();
    // calculate the merkle root of the transactions' hashes and the transactions' database hashes

    const merkleRoots = this.calculateMerkleRoot(this.transactions);
    this.merkleRoot = merkleRoots.hash;
    this.databaseHash = merkleRoots.databaseHash;
    const buffMR = Buffer.from(this.merkleRoot, 'hex');
    this.signature = activeSigningKey.sign(buffMR).toString();
  }
}

module.exports.Block = Block;
