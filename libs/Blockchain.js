const SHA256 = require('crypto-js/sha256');
const { VM, VMScript } = require('vm2');
const Loki = require('lokijs');
const { Base64 } = require('js-base64');

const { DBUtils } = require('./DBUtils');

const JSVMTIMEOUT = 10000;

class Transaction {
  constructor(refBlockNumber, transactionId, sender, contract, action, payload) {
    this.refBlockNumber = refBlockNumber;
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
    this.logs = JSON.stringify(logs);
  }

  // calculate the hash of the transaction
  calculateHash() {
    return SHA256(
      this.refBlockNumber
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
        logs = { error: 'the parameters sender, contract and action are required' };
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
          return { error: 'contract already exists' };
        }

        // this code template is used to manage the code of the smart contract
        // this way we keep control of what can be executed in a smart contract
        let codeTemplate = `
          let actions = {};

          ###ACTIONS###

          if (action && typeof action === 'string' && typeof actions[action] === 'function') {
            if (action !== 'deploy') {
              actions.create = function () {};
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
            res.events.forEach(event => logs.events.push(event));
          },
          // emit an event that will be sotred in the logs
          emit: (event, data) => logs.events.push({ event, data }),
        };

        Block.runContractCode(vmState, script);

        const newContract = {
          name,
          owner: sender,
          code: script,
          tables,
        };

        contracts.insert(newContract);

        if (logs.events.length === 0) return {};

        return logs;
      }

      return { error: 'parameters name and code are mandatory and they must be strings' };
    } catch (e) {
      // console.error('ERROR DURING CONTRACT DEPLOYMENT: ', e);
      return { error: { name: e.name, message: e.message } };
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

      if (action === 'create') return { error: 'you cannot trigger the create action' };

      const payloadObj = payload ? JSON.parse(payload) : {};

      const contracts = state.database.getCollection('contracts');
      const contractInDb = contracts.findOne({ name: contract });
      if (contractInDb === null) {
        return { error: 'contract doesn\'t exist' };
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
          res.events.forEach(event => logs.events.push(event));
        },
        // emit an event that will be sotred in the logs
        emit: (event, data) => logs.events.push({ event, data }),
      };

      Block.runContractCode(vmState, contractCode);

      // const test = state.database.getCollection('test_contract_users_users');
      // console.log('state after: ', test.find({}));

      return logs;
    } catch (e) {
      // console.error('ERROR DURING CONTRACT EXECUTION: ', e);
      return { error: { name: e.name, message: e.message } };
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
    this.state = {
      database: new Loki(),
    };

    this.state.database.addCollection('contracts');
  }

  // create the genesis block of the blockchain
  static createGenesisBlock() {
    const genesisBlock = new Block('2018-06-01T00:00:00', [], -1, '0');
    // console.log('BLOCK GENESIS CREATED: #',
    // genesisBlock.blockNumber); // eslint-disable-line no-console
    return genesisBlock;
  }

  // get the latest block of the blockchain
  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

  // produce all the pending transactions, that will result in the creattion of a block
  producePendingTransactions(timestamp) {
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
