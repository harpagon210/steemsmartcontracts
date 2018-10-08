const { Base64 } = require('js-base64');
const { VM, VMScript } = require('vm2');
const currency = require('currency.js');

const DB_PLUGIN_NAME = require('../plugins/Database').PLUGIN_NAME;
const DB_PLUGIN_ACTIONS = require('../plugins/Database').PLUGIN_ACTIONS;

class SmartContracts {
  // deploy the smart contract to the blockchain and initialize the database if needed
  static deploySmartContract(ipc, transaction, jsVMTimeout) {
    return new Promise(async (resolve) => {
      try {
        const { refSteemBlockNumber, sender } = transaction;
        const payload = JSON.parse(transaction.payload);
        const { name, params, code } = payload;

        if (name && typeof name === 'string'
          && code && typeof code === 'string') {
          // the contract name has to be a string made of letters and numbers
          const RegexLettersNumbers = /^[a-zA-Z0-9_]+$/;

          if (!RegexLettersNumbers.test(name)) {
            resolve({ errors: ['invalid contract name'] });
          }

          const res = await ipc.send(
            { to: DB_PLUGIN_NAME, action: DB_PLUGIN_ACTIONS.FIND_CONTRACT, payload: { name } },
          );

          // for now the contracts are immutable
          if (res.payload) {
            // contract.code = code;
            resolve({ errors: ['contract already exists'] });
          }

          // this code template is used to manage the code of the smart contract
          // this way we keep control of what can be executed in a smart contract
          let codeTemplate = `
            let actions = {};
  
            ###ACTIONS###

            const execute = async function () {
              try {
                if (action && typeof action === 'string' && typeof actions[action] === 'function') {
                  if (action !== 'createSSC') {
                    actions.createSSC = null;
                  }
                  await actions[action](payload);
                  done(null);
                }
              } catch (error) {
                done(error);
              }
            }
  
            execute();
          `;

          // the code of the smart contarct comes as a Base64 encoded string
          codeTemplate = codeTemplate.replace('###ACTIONS###', Base64.decode(code));

          // compile the code for faster executions later on
          const script = new VMScript(codeTemplate).compile();

          const tables = [];

          // prepare the db object that will be available in the VM
          const db = {
            // createTable is only available during the smart contract deployment
            createTable: (tableName, indexes = []) => this.createTable(
              ipc, tables, name, tableName, indexes,
            ),
            // perform a query find on a table of the smart contract
            find: (table, query, limit = 1000, offset = 0, index = '', descending = false) => this.find(
              ipc, name, table, query, limit, offset, index, descending,
            ),
            // perform a query find on a table of an other smart contract
            findInTable: (contractName, table, query, limit = 1000, offset = 0, index = '', descending = false) => this.find(
              ipc, contractName, table, query, limit, offset, index, descending,
            ),
            // perform a query findOne on a table of the smart contract
            findOne: (table, query) => this.findOne(ipc, name, table, query),
            // perform a query findOne on a table of an other smart contract
            findOneInTable: (contractName, table, query) => this.findOne(
              ipc, contractName, table, query,
            ),
            // insert a record in the table of the smart contract
            insert: (table, record) => this.insert(ipc, name, table, record),
            // insert a record in the table of the smart contract
            remove: (table, record) => this.remove(ipc, name, table, record),
            // insert a record in the table of the smart contract
            update: (table, record) => this.update(ipc, name, table, record),
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
            executeSmartContract: async (
              contractName, actionName, parameters,
            ) => SmartContracts.executeSmartContractFromSmartContract(
              ipc, logs, sender, params, contractName, actionName,
              JSON.stringify(parameters), jsVMTimeout,
            ),
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

          const error = await SmartContracts.runContractCode(vmState, script, jsVMTimeout);
          if (error) {
            if (error.name && typeof error.name === 'string'
              && error.message && typeof error.message === 'string') {
              resolve({ errors: [`${error.name}: ${error.message}`] });
            } else {
              resolve({ errors: ['unknown error'] });
            }
          }

          const newContract = {
            name,
            owner: sender,
            code: codeTemplate,
            tables,
          };

          await ipc.send(
            { to: DB_PLUGIN_NAME, action: DB_PLUGIN_ACTIONS.ADD_CONTRACT, payload: newContract },
          );

          resolve(logs);
        }

        resolve({ errors: ['parameters name and code are mandatory and they must be strings'] });
      } catch (e) {
        // console.error('ERROR DURING CONTRACT DEPLOYMENT: ', e);
        resolve({ errors: [`${e.name}: ${e.message}`] });
      }
    });
  }

  // execute the smart contract and perform actions on the database if needed
  static executeSmartContract(ipc, transaction, jsVMTimeout) {
    return new Promise(async (resolve) => {
      try {
        const {
          sender,
          contract,
          action,
          payload,
          refSteemBlockNumber,
        } = transaction;

        if (action === 'createSSC') resolve({ errors: ['you cannot trigger the createSSC action'] });

        const payloadObj = payload ? JSON.parse(payload) : {};

        const res = await ipc.send(
          {
            to: DB_PLUGIN_NAME,
            action: DB_PLUGIN_ACTIONS.FIND_CONTRACT,
            payload: { name: contract },
          },
        );

        const contractInDb = res.payload;
        if (contractInDb === null) {
          resolve({ errors: ['contract doesn\'t exist'] });
        }

        const contractCode = contractInDb.code;
        const contractOwner = contractInDb.owner;

        // prepare the db object that will be available in the VM
        const db = {
          // perform a query find on a table of the smart contract
          find: (table, query, limit = 1000, offset = 0, index = '', descending = false) => this.find(
            ipc, contract, table, query, limit, offset, index, descending,
          ),
          // perform a query find on a table of an other smart contract
          findInTable: (contractName, table, query, limit = 1000, offset = 0, index = '', descending = false) => this.find(
            ipc, contractName, table, query, limit, offset, index, descending,
          ),
          // perform a query findOne on a table of the smart contract
          findOne: (table, query) => this.findOne(ipc, contract, table, query),
          // perform a query findOne on a table of an other smart contract
          findOneInTable: (contractName, table, query) => this.findOne(
            ipc, contractName, table, query,
          ),
          // insert a record in the table of the smart contract
          insert: (table, record) => this.insert(ipc, contract, table, record),
          // insert a record in the table of the smart contract
          remove: (table, record) => this.remove(ipc, contract, table, record),
          // insert a record in the table of the smart contract
          update: (table, record) => this.update(ipc, contract, table, record),
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
          executeSmartContract: async (
            contractName, actionName, parameters,
          ) => SmartContracts.executeSmartContractFromSmartContract(
            ipc, logs, sender, payloadObj, contractName, actionName,
            JSON.stringify(parameters), jsVMTimeout,
          ),
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

        const error = await SmartContracts.runContractCode(vmState, contractCode, jsVMTimeout);

        if (error) {
          const { name, message } = error;
          if (name && typeof name === 'string'
            && message && typeof message === 'string') {
            resolve({ errors: [`${name}: ${message}`] });
          } else {
            resolve({ errors: ['unknown error'] });
          }
        }

        resolve(logs);
      } catch (e) {
        console.error('ERROR DURING CONTRACT EXECUTION: ', e);
        resolve({ errors: [`${e.name}: ${e.message}`] });
      }
    });
  }

  // run the contractCode in a VM with the vmState as a state for the VM
  static runContractCode(vmState, contractCode, jsVMTimeout) {
    return new Promise((resolve) => {
      try {
        // console.log('vmState', vmState)
        // run the code in the VM
        const vm = new VM({
          timeout: jsVMTimeout,
          sandbox: {
            ...vmState,
            done: (error) => {
              // console.log('error', error);
              resolve(error);
            },
          },
        });

        vm.run(contractCode);
      } catch (err) {
        resolve(err);
      }
    });
  }

  static executeSmartContractFromSmartContract(
    ipc, logs, sender, originalParameters, contract, action, parameters, jsVMTimeout,
  ) {
    return new Promise(async (resolveExec) => {
      if (typeof contract !== 'string' || typeof action !== 'string' || (parameters && typeof parameters !== 'string')) resolveExec(null);
      const sanitizedParams = parameters ? JSON.parse(parameters) : null;

      // check if a recipient or amountSTEEMSBD
      //  or isSignedWithActiveKey  were passed initially
      if (originalParameters && originalParameters.amountSTEEMSBD) {
        sanitizedParams.amountSTEEMSBD = originalParameters.amountSTEEMSBD;
      }

      if (originalParameters && originalParameters.recipient) {
        sanitizedParams.recipient = originalParameters.recipient;
      }

      if (originalParameters && originalParameters.isSignedWithActiveKey) {
        sanitizedParams.isSignedWithActiveKey = originalParameters.isSignedWithActiveKey;
      }

      const results = {};
      try {
        const res = await SmartContracts.executeSmartContract(
          ipc,
          {
            sender,
            contract,
            action,
            payload: JSON.stringify(sanitizedParams),
          },
          jsVMTimeout,
        );

        if (res && res.errors !== undefined) {
          res.errors.forEach((error) => {
            if (results.errors === undefined) {
              results.errors = [];
            }
            if (logs.errors === undefined) {
              logs.errors = []; // eslint-disable-line no-param-reassign
            }

            logs.errors.push(error);
            results.errors.push(error);
          });
        }

        if (res && res.events !== undefined) {
          res.events.forEach((event) => {
            if (results.events === undefined) {
              results.events = [];
            }
            if (logs.events === undefined) {
              logs.events = []; // eslint-disable-line no-param-reassign
            }

            logs.events.push(event);
            results.events.push(event);
          });
        }
      } catch (error) {
        results.errors = [];
        results.errors.push(error);
      }
      resolveExec(results);
    });
  }

  //
  static createTable(ipc, tables, contractName, tableName, indexes = []) {
    return new Promise(async (resolve) => {
      const res = await ipc.send({
        to: DB_PLUGIN_NAME,
        action: DB_PLUGIN_ACTIONS.CREATE_TABLE,
        payload: {
          contractName,
          tableName,
          indexes,
        },
      });

      if (res.payload === true) {
        // add the table name to the list of table available for this contract
        const finalTableName = `${contractName}_${tableName}`;
        if (!tables.includes(finalTableName)) tables.push(finalTableName);
      }

      resolve();
    });
  }

  static find(ipc, contractName, table, query, limit = 1000, offset = 0, index = '', descending = false) {
    return new Promise(async (resolve) => {
      const res = await ipc.send({
        to: DB_PLUGIN_NAME,
        action: DB_PLUGIN_ACTIONS.FIND,
        payload: {
          contract: contractName,
          table,
          query,
          limit,
          offset,
          index,
          descending,
        },
      });

      resolve(res.payload);
    });
  }

  static findOne(ipc, contractName, table, query) {
    return new Promise(async (resolve) => {
      const res = await ipc.send({
        to: DB_PLUGIN_NAME,
        action: DB_PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: contractName,
          table,
          query,
        },
      });

      resolve(res.payload);
    });
  }

  static insert(ipc, contractName, table, record) {
    return new Promise(async (resolve) => {
      const res = await ipc.send({
        to: DB_PLUGIN_NAME,
        action: DB_PLUGIN_ACTIONS.INSERT,
        payload: {
          contract: contractName,
          table,
          record,
        },
      });

      resolve(res.payload);
    });
  }

  static remove(ipc, contractName, table, record) {
    return new Promise(async (resolve) => {
      const res = await ipc.send({
        to: DB_PLUGIN_NAME,
        action: DB_PLUGIN_ACTIONS.REMOVE,
        payload: {
          contract: contractName,
          table,
          record,
        },
      });

      resolve(res.payload);
    });
  }

  static update(ipc, contractName, table, record) {
    return new Promise(async (resolve) => {
      const res = await ipc.send({
        to: DB_PLUGIN_NAME,
        action: DB_PLUGIN_ACTIONS.UPDATE,
        payload: {
          contract: contractName,
          table,
          record,
        },
      });

      resolve(res.payload);
    });
  }
}

module.exports.SmartContracts = SmartContracts;
