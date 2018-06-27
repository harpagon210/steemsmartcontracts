const SHA256 = require('crypto-js/sha256');
const { VM, VMScript } = require('vm2');
const Loki = require('lokijs');

const JSVMTIMEOUT = 10000;

module.exports.Transaction = class Transaction {
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

  addLogs(logs) {
    this.logs = JSON.stringify(logs);
  }

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
};

class Block {
  constructor(timestamp, transactions, previousBlockNumber, previousHash = '') {
    this.blockNumber = previousBlockNumber + 1;
    this.previousHash = previousHash;
    this.timestamp = timestamp;
    this.transactions = transactions;
    this.hash = this.calculateHash();
    this.merkleRoot = '';
  }

  calculateHash() {
    return SHA256(this.previousHash + this.timestamp + JSON.stringify(this.transactions))
      .toString();
  }

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

  produceBlock(state) {
    this.transactions.forEach((transaction) => {
      console.log('transaction: ', transaction);
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
        } else if (contract && action) {
          logs = Block.executeSmartContract(state, transaction);
        }
      }

      transaction.addLogs(logs);
    });

    this.hash = this.calculateHash();
    this.merkleRoot = this.calculateMerkleRoot(this.transactions);

    console.log(`BLOCK PRODUCED: Block #: ${this.blockNumber} #Txs: ${this.transactions.length} hash: ${this.hash} merkle root: ${this.merkleRoot}`);
  }

  static deploySmartContract(state, transaction) {
    try {
      console.log(transaction);
      const { sender } = transaction;
      const payload = JSON.parse(transaction.payload);
      const { name, params, code } = payload;

      if (name && typeof name === 'string'
          && code && typeof code === 'string') {
        const contracts = state.database.getCollection('contracts');
        const contract = contracts.findOne({ name });

        if (contract) {
          // contract.code = code;
          throw new Error('contract already exists');
        } else {
          let codeTemplate = `
            let actions = {};

            ###ACTIONS###

            if (typeof actions[action] === 'function')
              actions[action](payload);
          `;

          codeTemplate = codeTemplate.replace('###ACTIONS###', Base64.decode(code)); // eslint-disable-line no-undef

          const script = new VMScript(codeTemplate).compile();

          const tables = [];
          const db = {
            createTable: (tableName) => {
              const finalTableName = `${name}_${tableName}`;
              const table = state.database.getCollection(finalTableName);
              if (table) return table;

              tables.push(finalTableName);
              return state.database.addCollection(finalTableName);
            },
            findInTable: (contractName, table, query) => this.findInTable(
              contractName,
              table,
              query,
            ),
          };

          const logs = {
            events: [],
          };

          const vmState = {
            action: 'create',
            payload: params ? JSON.parse(JSON.stringify(params)) : null,
            db,
            debug: log => console.log(log), // eslint-disable-line no-console
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

          return logs;
        }
      }

      return { error: 'parameters name and code are mandatory and they must be strings' };
    } catch (e) {
      console.error('ERROR DURING CONTRACT DEPLOYMENT: ', e);
      return { error: e };
    }
  }

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
        throw new Error('contract doesn\'t exist');
      }

      const contractCode = contractInDb.code;
      const contractOwner = contractInDb.owner;

      const db = {
        getTable: (tableName) => {
          const finalTableName = `${contract}_${tableName}`;
          if (contractInDb.tables.includes(finalTableName)) {
            return state.database.getCollection(finalTableName);
          }

          return null;
        },
        findInTable: (contractName, table, query) => this.findInTable(contractName, table, query),
      };

      const logs = {
        events: [],
      };

      const vmState = {
        sender,
        owner: contractOwner,
        action,
        payload: JSON.parse(JSON.stringify(payloadObj)),
        db,
        debug: log => console.log(log), // eslint-disable-line no-console
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
        emit: (event, data) => logs.events.push({ event, data }),
      };

      Block.runContractCode(vmState, contractCode);

      // const test = state.database.getCollection('test_contract_users_users');
      // console.log('state after: ', test.find({}));

      return logs;
    } catch (e) {
      console.error('ERROR DURING CONTRACT EXECUTION: ', e);
      return { error: e };
    }
  }

  static runContractCode(vmState, contractCode) {
    // run the code in the VM
    const vm = new VM({
      timeout: JSVMTIMEOUT,
      sandbox: vmState,
    });

    vm.run(contractCode);
  }
}

module.exports.Blockchain = class Blockchain {
  constructor() {
    this.chain = [Blockchain.createGenesisBlock()];
    this.pendingTransactions = [];
    this.state = {
      database: new Loki(),
    };

    this.state.database.addCollection('contracts');
  }

  static createGenesisBlock() {
    const genesisBlock = new Block('2018-06-01T00:00:00', [], -1, '0');
    console.log('BLOCK GENESIS CREATED: #', genesisBlock.blockNumber); // eslint-disable-line no-console
    return genesisBlock;
  }

  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

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

  createTransaction(transaction) {
    this.pendingTransactions.push(transaction);
  }

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

  getBlockInfo(blockNumber) {
    if (blockNumber && typeof blockNumber === 'number' && blockNumber < this.chain.length) {
      return this.chain[blockNumber];
    }

    return null;
  }

  getLatestBlockInfo() {
    return this.chain[this.chain.length - 1];
  }

  findInTable(contract, table, query) {
    if (contract && typeof contract === 'string'
        && table && typeof table === 'string'
        && query && typeof query === 'object') {
      const contracts = this.state.database.getCollection('contracts');
      const contractInDb = contracts.findOne({ name: contract });

      if (contractInDb) {
        const finalTableName = `${contract}_${table}`;
        if (contractInDb.tables.includes(finalTableName)) {
          const tableData = this.state.database.getCollection(finalTableName);
          return tableData.find(query);
        }
      }
    }

    return null;
  }

  getCode(contract) {
    if (contract && typeof contract === 'string') {
      const contracts = this.state.database.getCollection('contracts');
      const contractInDb = contracts.findOne({ name: contract });

      if (contractInDb) {
        return contractInDb.code.code;
      }
    }

    return null;
  }

  getOwner(contract) {
    if (contract && typeof contract === 'string') {
      const contracts = this.state.database.getCollection('contracts');
      const contractInDb = contracts.findOne({ name: contract });

      if (contractInDb) {
        return contractInDb.owner;
      }
    }

    return null;
  }
};
