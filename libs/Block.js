const SHA256 = require('crypto-js/sha256');
const { Base64 } = require('js-base64');
const { VM, VMScript } = require('vm2');
const currency = require('currency.js');
const { DBUtils } = require('./DBUtils');

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
  produceBlock(state, jsVMTimeout) {
    this.transactions.forEach((transaction) => {
      const {
        sender,
        contract,
        action,
        payload,
      } = transaction;

      let logs = null;

      if (sender && contract && action) {
        if (contract === 'contract' && action === 'deploy' && payload) {
          logs = Block.deploySmartContract(state, transaction, jsVMTimeout);
        } else {
          logs = Block.executeSmartContract(state, transaction, jsVMTimeout);
        }
      } else {
        logs = { errors: ['the parameters sender, contract and action are required'] };
      }

      transaction.addLogs(logs);
    });

    this.hash = this.calculateHash();
    this.merkleRoot = this.calculateMerkleRoot(this.transactions);
  }

  // deploy the smart contract to the blockchain and initialize the database if needed
  static deploySmartContract(state, transaction, jsVMTimeout) {
    try {
      const { refSteemBlockNumber, sender } = transaction;
      const payload = JSON.parse(transaction.payload);
      const { name, params, code } = payload;

      if (name && typeof name === 'string'
        && code && typeof code === 'string') {
        // the contract name has to be a string made of letters and numbers
        const RegexLettersNumbers = /^[a-zA-Z0-9_]+$/;

        if (!RegexLettersNumbers.test(name)) {
          return { errors: ['invalid contract name'] };
        }

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
            if (action !== 'createSSC') {
              actions.createSSC = null;
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
          createTable: (tableName, indexes = []) => {
            const table = DBUtils.createTable(state, name, tableName, indexes);
            if (table) {
              // add the table name to the list of table available for this contract
              const finalTableName = `${name}_${tableName}`;
              if (!tables.includes(finalTableName)) tables.push(finalTableName);
            }

            return table;
          },
          // perform a query on the tables of other smart contracts
          findInTable: (
            contractName,
            table,
            query,
            limit = 1000,
            offset = 0,
            index = '',
            descending = false,
          ) => DBUtils.findInTable(
            state,
            contractName,
            table,
            query,
            limit,
            offset,
            index,
            descending,
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
          action: 'createSSC',
          payload: params ? JSON.parse(JSON.stringify(params)) : null,
          refSteemBlockNumber,
          db,
          currency,
          debug: log => console.log(log), // eslint-disable-line no-console
          // execute a smart contract from the current smart contract
          executeSmartContract: (contractName, actionName, parameters) => {
            if (typeof contractName !== 'string' || typeof actionName !== 'string' || (parameters && typeof parameters !== 'string')) return null;
            const sanitizedParams = parameters ? JSON.parse(parameters) : null;

            // check if a recipient or amountSTEEMSBD
            //  or isSignedWithActiveKey  were passed initially
            if (params && params.amountSTEEMSBD) {
              sanitizedParams.amountSTEEMSBD = params.amountSTEEMSBD;
            }

            if (params && params.recipient) {
              sanitizedParams.recipient = params.recipient;
            }

            if (params && params.isSignedWithActiveKey) {
              sanitizedParams.isSignedWithActiveKey = params.isSignedWithActiveKey;
            }

            const res = Block.executeSmartContract(
              state,
              {
                sender,
                contract: contractName,
                action: actionName,
                payload: JSON.stringify(sanitizedParams),
              },
              jsVMTimeout,
            );
            res.errors.forEach(error => logs.errors.push(error));
            res.events.forEach(event => logs.events.push(event));

            const results = {};
            res.errors.forEach((error) => {
              if (results.errors === undefined) {
                results.errors = [];
              }
              logs.errors.push(error);
              results.errors.push(error);
            });
            res.events.forEach((event) => {
              if (results.events === undefined) {
                results.events = [];
              }
              logs.events.push(event);
              results.events.push(event);
            });

            return results;
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

        Block.runContractCode(vmState, script, jsVMTimeout);

        const newContract = {
          name,
          owner: sender,
          code: codeTemplate,
          tables,
        };

        contracts.insert(newContract);

        return logs;
      }

      return { errors: ['parameters name and code are mandatory and they must be strings'] };
    } catch (e) {
      // console.error('ERROR DURING CONTRACT DEPLOYMENT: ', e);
      return { errors: [`${e.name}: ${e.message}`] };
    }
  }

  // execute the smart contract and perform actions on the database if needed
  static executeSmartContract(state, transaction, jsVMTimeout) {
    try {
      const {
        sender,
        contract,
        action,
        payload,
        refSteemBlockNumber,
      } = transaction;

      if (action === 'createSSC') return { errors: ['you cannot trigger the createSSC action'] };

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
        findInTable: (
          contractName,
          table,
          query,
          limit = 1000,
          offset = 0,
          index = '',
          descending = false,
        ) => DBUtils.findInTable(
          state,
          contractName,
          table,
          query,
          limit,
          offset,
          index,
          descending,
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
        refSteemBlockNumber,
        action,
        payload: JSON.parse(JSON.stringify(payloadObj)),
        db,
        currency,
        debug: log => console.log(log), // eslint-disable-line no-console
        // execute a smart contract from the current smart contract
        executeSmartContract: (contractName, actionName, params) => {
          if (typeof contractName !== 'string' || typeof actionName !== 'string' || (params && typeof params !== 'string')) return null;
          const sanitizedParams = params ? JSON.parse(params) : null;

          // check if a recipient or amountSTEEMSBD or isSignedWithActiveKey  were passed initially
          if (payloadObj && payloadObj.amountSTEEMSBD) {
            sanitizedParams.amountSTEEMSBD = payloadObj.amountSTEEMSBD;
          }

          if (payloadObj && payloadObj.recipient) {
            sanitizedParams.recipient = payloadObj.recipient;
          }

          if (payloadObj && payloadObj.isSignedWithActiveKey) {
            sanitizedParams.isSignedWithActiveKey = payloadObj.isSignedWithActiveKey;
          }

          const res = Block.executeSmartContract(
            state,
            {
              sender,
              contract: contractName,
              action: actionName,
              payload: JSON.stringify(sanitizedParams),
            },
            jsVMTimeout,
          );
          const results = {};
          res.errors.forEach((error) => {
            if (results.errors === undefined) {
              results.errors = [];
            }
            logs.errors.push(error);
            results.errors.push(error);
          });
          res.events.forEach((event) => {
            if (results.events === undefined) {
              results.events = [];
            }
            logs.events.push(event);
            results.events.push(event);
          });

          return results;
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

      Block.runContractCode(vmState, contractCode, jsVMTimeout);

      return logs;
    } catch (e) {
      // console.error('ERROR DURING CONTRACT EXECUTION: ', e);
      return { errors: [`${e.name}: ${e.message}`] };
    }
  }

  // run the contractCode in a VM with the vmState as a state for the VM
  static runContractCode(vmState, contractCode, jsVMTimeout) {
    // run the code in the VM
    const vm = new VM({
      timeout: jsVMTimeout,
      sandbox: vmState,
    });

    vm.run(contractCode);
  }
}

module.exports.Block = Block;
