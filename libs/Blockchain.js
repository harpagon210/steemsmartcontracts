const Loki = require('lokijs');
const fs = require('fs-extra');
const lfsa = require('./loki-fs-structured-adapter.js');
const { Transaction } = require('./Transaction');
const { Block } = require('./Block');

const { DBUtils } = require('./DBUtils');

class Blockchain {
  constructor(chainId, autosaveInterval, jsVMTimeout) {
    this.chain = null;
    this.chainId = chainId;
    this.pendingTransactions = [];
    this.state = {};

    this.blockchainFilePath = '';
    this.databaseFilePath = '';
    this.autosaveInterval = autosaveInterval;
    this.jsVMTimeout = jsVMTimeout;

    this.producing = false;
    this.saving = false;
    this.loading = false;
  }

  // create the genesis block of the blockchain
  static createGenesisBlock(chainId) {
    const genesisBlock = new Block('2018-06-01T00:00:00', [{ chainId }], -1, '0');
    return genesisBlock;
  }

  // load the database from the filesystem
  loadBlockchain(dataDirectory, databaseFile, callback) {
    this.loading = true;

    this.databaseFilePath = dataDirectory + databaseFile;

    // check if the app has already be run
    if (fs.pathExistsSync(this.databaseFilePath)) {
      // load the blockchain
      this.lokiJSAdapter = new lfsa(); // eslint-disable-line new-cap
      this.state = {
        database: new Loki(this.databaseFilePath, {
          adapter: this.lokiJSAdapter,
          autosave: this.autosaveInterval > 0,
          autosaveInterval: this.autosaveInterval,
        }),
      };

      // load the database from the filesystem to the RAM
      this.state.database.loadDatabase({}, (errorDb) => {
        if (errorDb) {
          callback(errorDb);
        }

        // if the chain or the contracts collection doesn't exist we return an error
        this.chain = this.state.database.getCollection('chain');
        if (this.chain === null
          || this.state.database.getCollection('contracts') === null) {
          callback('The database is missing either the chain or the contracts table');
        }

        this.loading = false;
        callback(null);
      });
    } else {
      // create the data directory if necessary and empty it if files exists
      fs.emptyDirSync(dataDirectory);

      // init the database
      this.lokiJSAdapter = new lfsa(); // eslint-disable-line new-cap
      this.state = {
        database: new Loki(this.databaseFilePath, {
          adapter: this.lokiJSAdapter,
          autosave: this.autosaveInterval > 0,
          autosaveInterval: this.autosaveInterval,
        }),
      };

      // init the main tables
      this.chain = this.state.database.addCollection('chain');
      this.state.database.addCollection('contracts');

      // insert the genesis block
      this.chain.insert(Blockchain.createGenesisBlock(this.chainId));

      this.loading = false;
      callback(null);
    }
  }

  // save the blockchain as well as the database on the filesystem
  saveBlockchain(callback) {
    // if a block is being produced we wait until it is completed
    if (this.producing) this.saveBlockchain(callback);
    this.saving = !this.producing;

    // save the database from the RAM to the filesystem
    this.state.database.saveDatabase((err) => {
      if (err) {
        callback(err);
      }

      callback(null);
    });
  }

  // get the latest block of the blockchain
  getLatestBlock() {
    const { maxId } = this.chain;
    return this.chain.findOne({ $loki: maxId });
  }

  // produce all the pending transactions, that will result in the creattion of a block
  producePendingTransactions(timestamp) {
    // the block producing is aborted if the blockchain is being saved
    if (this.saving) return;

    // if the blockchain is loadng we postpone the production
    if (this.loading) this.producePendingTransactions(timestamp);

    this.producing = true;
    const previousBlock = this.getLatestBlock();
    const block = new Block(
      timestamp,
      this.pendingTransactions,
      previousBlock.blockNumber,
      previousBlock.hash,
    );
    block.produceBlock(this.state, this.jsVMTimeout);

    this.chain.insert(block);

    this.pendingTransactions = [];
    this.producing = false;
  }

  // create a transaction that will be then included in a block
  createTransaction(transaction) {
    this.pendingTransactions.push(transaction);
  }

  // check if the blockchain is valid by checking the block hashes and Merkle roots
  isChainValid() {
    const chain = this.chain.find();

    for (let i = 1; i < chain.length; i += 1) {
      const currentBlock = chain[i];
      const previousBlock = chain[i - 1];

      if (currentBlock.merkleRoot !== currentBlock.calculateMerkleRoot(currentBlock.transactions)) {
        return false;
      }

      if (currentBlock.hash !== currentBlock.calculateHash()) {
        return false;
      }

      if (currentBlock.previousHash !== previousBlock.hash) {
        return false;
      }
    }

    return true;
  }

  // replay the entire blockchain (rebuild the database as well)
  replayBlockchain(dataDirectory) {
    const chain = this.chain.find();

    // create the data directory if necessary and empty it if files exists
    fs.emptyDirSync(dataDirectory);

    // init the database
    this.lokiJSAdapter = new lfsa(); // eslint-disable-line new-cap
    this.state = {
      database: new Loki(this.databaseFilePath, {
        adapter: this.lokiJSAdapter,
        autosave: this.autosaveInterval > 0,
        autosaveInterval: this.autosaveInterval,
      }),
    };

    // init the main tables
    this.chain = this.state.database.addCollection('chain');
    this.state.database.addCollection('contracts');

    // insert the genesis block
    this.chain.insert(Blockchain.createGenesisBlock(this.chainId));

    for (let i = 0; i < chain.length; i += 1) {
      const txLength = chain[i].transactions.length;
      const txs = chain[i].transactions;

      for (let j = 0; j < txLength; j += 1) {
        const {
          refSteemBlockNumber,
          transactionId,
          sender,
          contract,
          action,
          payload,
        } = txs[j];
        this.createTransaction(
          new Transaction(refSteemBlockNumber, transactionId, sender, contract, action, payload),
        );
      }

      this.producePendingTransactions(chain[i].timestamp);
    }
  }

  // RPC methods

  // get the block that has the block number blockNumber
  getBlockInfo(blockNumber) {
    if (Number.isInteger(blockNumber)) {
      // the $loki field starts from 1 so the block 0 has the id 1
      // so to get the actual block we need to add 1 to blockNumber
      return this.chain.findOne({ $loki: blockNumber + 1 });
    }

    return null;
  }

  // get the latest block available on the blockchain
  getLatestBlockInfo() {
    return this.getLatestBlock();
  }

  // find records in the contract table by using the query, returns empty array if no records found
  findInTable(contract, table, query, limit = 1000, offset = 0, index = '', descending = false) {
    return DBUtils.findInTable(
      this.state,
      contract,
      table,
      query,
      limit,
      offset,
      index,
      descending,
    );
  }

  // find one record in the table of a contract by using the query, returns nullrecord found
  findOneInTable(contract, table, query) {
    return DBUtils.findOneInTable(this.state, contract, table, query);
  }

  // get the contract info (owner, code, tables available, etc...)
  getContract(contract) {
    return DBUtils.getContract(this.state, contract);
  }
}

module.exports.Transaction = Transaction;
module.exports.Blockchain = Blockchain;
