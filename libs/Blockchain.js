const SHA256 = require('crypto-js/sha256');
const { VM, VMScript } = require('vm2');
const Loki = require('lokijs');
const { Base64 } = require('js-base64');
const fs = require('fs-extra');
const lfsa = require('./loki-fs-structured-adapter.js');


const { DBUtils } = require('./DBUtils');

const JSVMTIMEOUT = 10000;
const BLOCKCHAINFILENAME = 'blockchain.json';
const DATABASEFILENAME = 'database.db';

class Transaction {
  constructor(refSteemBlockNumber, transactionId, sender, contract, action, payload) {
    this.refSteemBlockNumber = refSteemBlockNumber;
    this.transactionId = transactionId;
    this.sender = sender;
    this.contract = typeof contract === 'string' ? contract : null;
    this.action = typeof action === 'string' ? action : null;
    this.payload = typeof payload === 'string' ? payload : null;
    this.hash = this.calculateHash();
    this.logs = {};
  }

  // add logs to the transaction
  // useful to get the result of the execution of a smart contract (events and errors)
  addLogs(logs) {
    const finalLogs = logs;
    if (finalLogs && finalLogs.errors && finalLogs.errors.length === 0) {
      delete finalLogs.errors;
    }

    if (finalLogs && finalLogs.events && finalLogs.events.length === 0) {
      delete finalLogs.events;
    }

    this.logs = JSON.stringify(finalLogs);
  }

  // calculate the hash of the transaction
  calculateHash() {
    return SHA256(
      this.refSteemBlockNumber
      + this.transactionId
      + this.sender
      + this.contract
      + this.action
      + this.payload,
    )
      .toString();
  }
}

class Block {
  constructor(timestamp, transactions, previousBlockNumber, previousHash = '') {
    this.blockNumber = previousBlockNumber + 1;
    this.refSteemBlockNumber = transactions.length > 0 ? transactions[0].refSteemBlockNumber : 0;
    this.previousHash = previousHash;
    this.timestamp = timestamp;
    this.transactions = transactions;
    this.hash = this.calculateHash();
    this.merkleRoot = '';
  }

  // calculate the hash of the block
  calculateHash() {
    return SHA256(this.previousHash + this.timestamp + JSON.stringify(this.transactions))
      .toString();
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

      newTransactions.push({ hash: SHA256(left + right).toString() });
    }

    if (newTransactions.length === 1) {
      return newTransactions[0].hash;
    }

    return this.calculateMerkleRoot(newTransactions);
  }

  // produce the block (deploy a smart contract or execute a smart contract)
  produceBlock(state) {
    this.transactions.forEach((transaction) => {
      // console.log('transaction: ', transaction);
      const {
        sender,
        contract,
        action,
        payload,
      } = transaction;

      let logs = null;

      if (sender && contract && action) {
        if (contract === 'contract' && action === 'deploy' && payload) {
          logs = Block.deploySmartContract(state, transaction);
        } else {
          logs = Block.executeSmartContract(state, transaction);
        }
      } else {
        logs = { errors: ['the parameters sender, contract and action are required'] };
      }

      transaction.addLogs(logs);
    });

    this.hash = this.calculateHash();
    this.merkleRoot = this.calculateMerkleRoot(this.transactions);

    // console.log(`
    // BLOCK PRODUCED: Block #: ${this.blockNumber} #Txs: ${this.transactions.length}
    // hash: ${this.hash} merkle root: ${this.merkleRoot}`); // eslint-disable-line max-len
  }

  // deploy the smart contract to the blockchain and initialize the database if needed
  static deploySmartContract(state, transaction) {
    try {
      // console.log(transaction);
      const { sender } = transaction;
      const payload = JSON.parse(transaction.payload);
      const { name, params, code } = payload;

      if (name && typeof name === 'string'
          && code && typeof code === 'string') {
        const contracts = state.database.getCollection('contracts');
        const contract = contracts.findOne({ name });

        // for now the contracts are immutable
        if (contract) {
          // contract.code = code;
          return { errors: ['contract already exists'] };
        }

        // this code template is used to manage the code of the smart contract
        // this way we keep control of what can be executed in a smart contract
        let codeTemplate = `
          let actions = {};

          ###ACTIONS###

          if (action && typeof action === 'string' && typeof actions[action] === 'function') {
            if (action !== 'create') {
              actions.create = null;
            }

            actions[action](payload);
          }
        `;

        // the code of the smart contarct comes as a Base64 encoded string
        codeTemplate = codeTemplate.replace('###ACTIONS###', Base64.decode(code));

        // compile the code for faster executions later on
        const script = new VMScript(codeTemplate).compile();

        const tables = [];

        // prepare the db object that will be available in the VM
        const db = {
          // createTable is only available during the smart contract deployment
          createTable: (tableName) => {
            const finalTableName = `${name}_${tableName}`;
            const table = state.database.getCollection(finalTableName);
            if (table) return table;

            tables.push(finalTableName);
            return state.database.addCollection(finalTableName);
          },
          // perform a query on the tables of other smart contracts
          findInTable: (contractName, table, query) => DBUtils.findInTable(
            state,
            contractName,
            table,
            query,
          ),
          // perform a query on the tables of other smart contracts
          findOneInTable: (contractName, table, query) => DBUtils.findOneInTable(
            state,
            contractName,
            table,
            query,
          ),
        };

        // logs used to store events or errors
        const logs = {
          errors: [],
          events: [],
        };

        // initialize the state that will be available in the VM
        const vmState = {
          action: 'create',
          payload: params ? JSON.parse(JSON.stringify(params)) : null,
          db,
          debug: log => console.log(log), // eslint-disable-line no-console
          // execute a smart contract from the current smart contract
          executeSmartContract: (contractName, actionName, parameters) => {
            const res = Block.executeSmartContract(
              state,
              {
                sender,
                contract: contractName,
                action: actionName,
                payload: parameters,
              },
            );
            res.errors.forEach(error => logs.errors.push(error));
            res.events.forEach(event => logs.events.push(event));
          },
          // emit an event that will be stored in the logs
          emit: (event, data) => logs.events.push({ event, data }),
          // add an error that will be stored in the logs
          assert: (condition, error) => {
            if (!condition && typeof error === 'string') {
              logs.errors.push(error);
            }
            return condition;
          },
        };

        Block.runContractCode(vmState, script);

        const newContract = {
          name,
          owner: sender,
          code: script,
          tables,
        };

        contracts.insert(newContract);

        return logs;
      }

      return { errors: ['parameters name and code are mandatory and they must be strings'] };
    } catch (e) {
      // console.error('ERROR DURING CONTRACT DEPLOYMENT: ', e);
      return { errors: [JSON.stringify({ name: e.name, message: e.message })] };
    }
  }

  // execute the smart contract and perform actions on the database if needed
  static executeSmartContract(state, transaction) {
    try {
      const {
        sender,
        contract,
        action,
        payload,
      } = transaction;

      if (action === 'create') return { errors: ['you cannot trigger the create action'] };

      const payloadObj = payload ? JSON.parse(payload) : {};

      const contracts = state.database.getCollection('contracts');
      const contractInDb = contracts.findOne({ name: contract });
      if (contractInDb === null) {
        return { errors: ['contract doesn\'t exist'] };
      }

      const contractCode = contractInDb.code;
      const contractOwner = contractInDb.owner;

      // prepare the db object that will be available in the VM
      const db = {
        // get a table that is owned by the current smart contract
        getTable: (tableName) => {
          const finalTableName = `${contract}_${tableName}`;
          if (contractInDb.tables.includes(finalTableName)) {
            return state.database.getCollection(finalTableName);
          }

          return null;
        },
        // perform a query on the tables of other smart contracts
        findInTable: (contractName, table, query) => DBUtils.findInTable(
          state,
          contractName,
          table,
          query,
        ),
        // perform a query on the tables of other smart contracts
        findOneInTable: (contractName, table, query) => DBUtils.findOneInTable(
          state,
          contractName,
          table,
          query,
        ),
      };

      // logs used to store events or errors
      const logs = {
        errors: [],
        events: [],
      };

      // initialize the state that will be available in the VM
      const vmState = {
        sender,
        owner: contractOwner,
        action,
        payload: JSON.parse(JSON.stringify(payloadObj)),
        db,
        debug: log => console.log(log), // eslint-disable-line no-console
        // execute a smart contract from the current smart contract
        executeSmartContract: (contractName, actionName, params) => {
          const res = Block.executeSmartContract(
            state,
            {
              sender,
              contract: contractName,
              action: actionName,
              payload: params,
            },
          );
          res.errors.forEach(error => logs.errors.push(error));
          res.events.forEach(event => logs.events.push(event));
        },
        // emit an event that will be stored in the logs
        emit: (event, data) => typeof event === 'string' && logs.events.push({ event, data }),
        // add an error that will be stored in the logs
        assert: (condition, error) => {
          if (!condition && typeof error === 'string') {
            logs.errors.push(error);
          }
          return condition;
        },
      };

      Block.runContractCode(vmState, contractCode);

      return logs;
    } catch (e) {
      // console.error('ERROR DURING CONTRACT EXECUTION: ', e);
      return { errors: [JSON.stringify({ name: e.name, message: e.message })] };
    }
  }

  // run the contractCode in a VM with the vmState as a state for the VM
  static runContractCode(vmState, contractCode) {
    // run the code in the VM
    const vm = new VM({
      timeout: JSVMTIMEOUT,
      sandbox: vmState,
    });

    vm.run(contractCode);
  }
}

class Blockchain {
  constructor() {
    this.chain = [Blockchain.createGenesisBlock()];
    this.pendingTransactions = [];
    this.state = {};

    this.blockchainFilePath = '';
    this.databaseFilePath = '';

    this.producing = false;
    this.saving = false;
    this.loading = false;
  }

  // create the genesis block of the blockchain
  static createGenesisBlock() {
    const genesisBlock = new Block('2018-06-01T00:00:00', [], -1, '0');
    // console.log('BLOCK GENESIS CREATED: #',
    // genesisBlock.blockNumber); // eslint-disable-line no-console
    return genesisBlock;
  }

  // load the blockchain as well as the database from the filesystem
  loadBlockchain(dataDirectory, callback) {
    this.loading = true;

    this.blockchainFilePath = dataDirectory + BLOCKCHAINFILENAME;
    this.databaseFilePath = dataDirectory + DATABASEFILENAME;

    // check if the app has already be run
    if (fs.pathExistsSync(this.blockchainFilePath)) {
      // load the file where the blocks are stored to the RAM
      fs.readJson(this.blockchainFilePath, (error, content) => {
        if (error) {
          callback(error);
        }

        this.lokiJSAdapter = new lfsa(); // eslint-disable-line new-cap
        this.state = {
          database: new Loki(this.databaseFilePath, {
            adapter: this.lokiJSAdapter,
          }),
        };

        if (content.length > 0) {
          this.chain = content;
        }

        // load the database from the filesystem to the RAM
        this.state.database.loadDatabase({}, (errorDb) => {
          if (errorDb) {
            callback(errorDb);
          }

          // if the contracts collection doesn't exist we create it
          if (this.state.database.getCollection('contracts') === null) {
            this.state.database.addCollection('contracts');
          }

          this.loading = false;
          callback(null);
        });
      });
    } else {
      // create the data directory if necessary and empty it if files exists
      fs.emptyDirSync(dataDirectory);

      // init the database
      this.lokiJSAdapter = new lfsa(); // eslint-disable-line new-cap
      this.state = {
        database: new Loki(this.databaseFilePath, {
          adapter: this.lokiJSAdapter,
        }),
      };

      this.state.database.addCollection('contracts');

      this.loading = false;
      callback(null);
    }
  }

  // save the blockchain as well as the database on the filesystem
  saveBlockchain(callback) {
    // if a block is being produced we wait until it is completed
    if (this.producing) this.saveBlockchain(callback);
    this.saving = !this.producing;

    // save the blockchain from the RAM to a json file
    fs.writeJson(this.blockchainFilePath, this.chain, { flag: 'w' }, (error) => {
      if (error) {
        callback(error);
      }

      // save the database from the RAM to the filesystem
      this.state.database.saveDatabase((err) => {
        if (err) {
          callback(err);
        }
        callback(null);
      });
    });
  }

  // get the latest block of the blockchain
  getLatestBlock() {
    return this.chain[this.chain.length - 1];
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
    block.produceBlock(this.state);

    this.chain.push(block);

    // console.log(block);

    this.pendingTransactions = [];
    this.producing = false;
  }

  // create a transaction that will be then included in a block
  createTransaction(transaction) {
    this.pendingTransactions.push(transaction);
  }

  // check if the blockchain is valid by checking the block hashes and Merkle roots
  isChainValid() {
    for (let i = 1; i < this.chain.length; i += 1) {
      const currentBlock = this.chain[i];
      const previousBlock = this.chain[i - 1];

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
  replayBlockchain() {
    this.state = {
      database: new Loki(),
    };

    this.state.database.addCollection('contracts');

    for (let i = 0; i < this.chain.length; i += 1) {
      this.chain[i].produceBlock(this.state);
    }
  }

  // RPC methods

  // get the block that has the block number blockNumber
  getBlockInfo(blockNumber) {
    if (blockNumber && typeof blockNumber === 'number' && blockNumber < this.chain.length) {
      return this.chain[blockNumber];
    }

    return null;
  }

  // get the latest block available on the blockchain
  getLatestBlockInfo() {
    return this.chain[this.chain.length - 1];
  }

  // find records in the contract table by using the query, returns empty array if no records found
  findInTable(contract, table, query) {
    return DBUtils.findInTable(this.state, contract, table, query);
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
