const SHA256 = require('crypto-js/sha256');
const enchex = require('crypto-js/enc-hex');
const dsteem = require('dsteem');
const { Base64 } = require('js-base64');
const { VM, VMScript } = require('vm2');
const BigNumber = require('bignumber.js');
const validator = require('validator');
const seedrandom = require('seedrandom');

const DB_PLUGIN_NAME = require('../plugins/Database.constants').PLUGIN_NAME;
const DB_PLUGIN_ACTIONS = require('../plugins/Database.constants').PLUGIN_ACTIONS;

const RESERVED_CONTRACT_NAMES = ['contract', 'blockProduction', 'null'];
const RESERVED_ACTIONS = ['createSSC'];

class SmartContracts {
  // deploy the smart contract to the blockchain and initialize the database if needed
  static async deploySmartContract(
    ipc, transaction, blockNumber, timestamp, refSteemBlockId, prevRefSteemBlockId, jsVMTimeout,
  ) {
    try {
      const { transactionId, refSteemBlockNumber, sender } = transaction;
      const payload = JSON.parse(transaction.payload);
      const { name, params, code } = payload;

      if (name && typeof name === 'string'
        && code && typeof code === 'string') {
        // the contract name has to be a string made of letters and numbers
        if (!validator.isAlphanumeric(name)
          || RESERVED_CONTRACT_NAMES.includes(name)
          || name.length < 3
          || name.length > 50) {
          return { logs: { errors: ['invalid contract name'] } };
        }

        let existingContract = null;

        const res = await ipc.send(
          { to: DB_PLUGIN_NAME, action: DB_PLUGIN_ACTIONS.FIND_CONTRACT, payload: { name } },
        );

        existingContract = res.payload;

        let finalSender = sender;

        // allow "steemsc" to update contracts owned by "null"
        if (existingContract && finalSender === 'steemsc' && existingContract.owner === 'null') {
          finalSender = 'null';
        }

        if (existingContract && existingContract.owner !== finalSender) {
          return { logs: { errors: ['you are not allowed to update this contract'] } };
        }

        // this code template is used to manage the code of the smart contract
        // this way we keep control of what can be executed in a smart contract
        let codeTemplate = `
          RegExp.prototype.constructor = function () { };
          RegExp.prototype.exec = function () {  };
          RegExp.prototype.test = function () {  };

          let actions = {};

          ###ACTIONS###

          const execute = async function () {
            try {
              if (api.action && typeof api.action === 'string' && typeof actions[api.action] === 'function') {
                if (api.action !== 'createSSC') {
                  actions.createSSC = null;
                }
                await actions[api.action](api.payload);
                done(null);
              } else {
                done('invalid action');
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

        const tables = {};

        // prepare the db object that will be available in the VM
        const db = {
          // createTable is only available during the smart contract deployment
          createTable: (tableName, indexes = []) => SmartContracts.createTable(
            ipc, tables, name, tableName, indexes,
          ),
          // perform a query find on a table of the smart contract
          find: (table, query, limit = 1000, offset = 0, indexes = []) => SmartContracts.find(
            ipc, name, table, query, limit, offset, indexes,
          ),
          // perform a query find on a table of an other smart contract
          findInTable: (contractName, table, query, limit = 1000, offset = 0, index = '', descending = false) => SmartContracts.find(
            ipc, contractName, table, query, limit, offset, index, descending,
          ),
          // perform a query findOne on a table of the smart contract
          findOne: (table, query) => SmartContracts.findOne(ipc, name, table, query),
          // perform a query findOne on a table of an other smart contract
          findOneInTable: (contractName, table, query) => SmartContracts.findOne(
            ipc, contractName, table, query,
          ),
          // find the information of a contract
          findContract: contractName => SmartContracts.findContract(ipc, contractName),
          // insert a record in the table of the smart contract
          insert: (table, record) => SmartContracts.dinsert(ipc, name, table, record),
          // insert a record in the table of the smart contract
          remove: (table, record) => SmartContracts.remove(ipc, name, table, record),
          // insert a record in the table of the smart contract
          update: (table, record) => SmartContracts.update(ipc, name, table, record),
          // check if a table exists
          tableExists: table => SmartContracts.tableExists(ipc, name, table),
        };

        // logs used to store events or errors
        const logs = {
          errors: [],
          events: [],
        };

        const rng = seedrandom(`${prevRefSteemBlockId}${refSteemBlockId}${transactionId}`);

        // init bignumber decimal places
        if (refSteemBlockNumber > 33719500) {
          BigNumber.set({ DECIMAL_PLACES: 20 });
        } else {
          BigNumber.set({ DECIMAL_PLACES: 3 });
        }

        const contractVersion = existingContract && existingContract.version
          ? existingContract.version
          : 1;

        // initialize the state that will be available in the VM
        const vmState = {
          api: {
            action: 'createSSC',
            payload: params ? JSON.parse(JSON.stringify(params)) : null,
            transactionId,
            blockNumber,
            refSteemBlockNumber,
            steemBlockTimestamp: timestamp,
            contractVersion,
            db,
            BigNumber,
            validator,
            hash: (payloadToHash) => {
              if (typeof payloadToHash === 'string') {
                return SHA256(payloadToHash).toString(enchex);
              }

              return SHA256(JSON.stringify(payloadToHash)).toString(enchex);
            },
            checkSignature: (payloadToCheck, signature, publicKey) => {
              if ((typeof payloadToCheck !== 'string'
              && typeof payloadToCheck !== 'object')
              || typeof signature !== 'string'
              || typeof publicKey !== 'string') return null;

              const sig = dsteem.Signature.fromString(signature);
              const finalPayload = typeof payloadToCheck === 'string' ? payloadToCheck : JSON.stringify(payloadToCheck);
              const payloadHash = SHA256(finalPayload).toString(enchex);
              const buffer = Buffer.from(payloadHash, 'hex');

              return dsteem.PublicKey.fromString(publicKey).verify(buffer, sig);
            },
            random: () => rng(),
            debug: log => console.log(log), // eslint-disable-line no-console
            // execute a smart contract from the current smart contract
            executeSmartContract: async (
              contractName, actionName, parameters,
            ) => SmartContracts.executeSmartContractFromSmartContract(
              ipc, logs, finalSender, params, contractName, actionName,
              JSON.stringify(parameters),
              blockNumber, timestamp,
              refSteemBlockNumber, refSteemBlockId, prevRefSteemBlockId, jsVMTimeout,
              name, 'createSSC', contractVersion,
            ),
            // emit an event that will be stored in the logs
            emit: (event, data) => typeof event === 'string' && logs.events.push({ contract: name, event, data }),
            // add an error that will be stored in the logs
            assert: (condition, error) => {
              if (!condition && typeof error === 'string') {
                logs.errors.push(error);
              }
              return condition;
            },
          },
        };

        const error = await SmartContracts.runContractCode(vmState, script, jsVMTimeout);
        if (error) {
          if (error.name && typeof error.name === 'string'
            && error.message && typeof error.message === 'string') {
            return { errors: [`${error.name}: ${error.message}`] };
          }

          return { logs: { errors: ['unknown error'] } };
        }

        const newContract = {
          _id: name,
          owner: finalSender,
          code: codeTemplate,
          codeHash: SHA256(codeTemplate).toString(enchex),
          tables,
          version: 1,
        };

        // if contract already exists, update it
        if (existingContract !== null) {
          newContract._id = existingContract._id; // eslint-disable-line no-underscore-dangle
          newContract.tables = Object.assign(existingContract.tables, newContract.tables);
          newContract.version = existingContract.version + 1;

          await ipc.send(
            {
              to: DB_PLUGIN_NAME,
              action: DB_PLUGIN_ACTIONS.UPDATE_CONTRACT,
              payload: newContract,
            },
          );
        } else {
          await ipc.send(
            { to: DB_PLUGIN_NAME, action: DB_PLUGIN_ACTIONS.ADD_CONTRACT, payload: newContract },
          );
        }
        return { executedCodeHash: newContract.codeHash, logs };
      }
      return { logs: { errors: ['parameters name and code are mandatory and they must be strings'] } };
    } catch (e) {
      // console.error('ERROR DURING CONTRACT DEPLOYMENT: ', e);
      return { logs: { errors: [`${e.name}: ${e.message}`] } };
    }
  }

  // execute the smart contract and perform actions on the database if needed
  static async executeSmartContract(
    ipc, transaction, blockNumber, timestamp, refSteemBlockId, prevRefSteemBlockId, jsVMTimeout,
  ) {
    try {
      const {
        transactionId,
        sender,
        contract,
        action,
        payload,
        refSteemBlockNumber,
      } = transaction;

      if (RESERVED_ACTIONS.includes(action)) return { logs: { errors: ['you cannot trigger this action'] } };

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
        return { logs: { errors: ['contract doesn\'t exist'] } };
      }

      const contractCode = contractInDb.code;
      const contractOwner = contractInDb.owner;
      const contractVersion = contractInDb.version;

      // prepare the db object that will be available in the VM
      const db = {
        // perform a query find on a table of the smart contract
        find: (table, query, limit = 1000, offset = 0, indexes = []) => SmartContracts.find(
          ipc, contract, table, query, limit, offset, indexes,
        ),
        // perform a query find on a table of an other smart contract
        findInTable: (contractName, table, query, limit = 1000, offset = 0, index = '', descending = false) => SmartContracts.find(
          ipc, contractName, table, query, limit, offset, index, descending,
        ),
        // perform a query findOne on a table of the smart contract
        findOne: (table, query) => SmartContracts.findOne(ipc, contract, table, query),
        // perform a query findOne on a table of an other smart contract
        findOneInTable: (contractName, table, query) => SmartContracts.findOne(
          ipc, contractName, table, query,
        ),
        // find the information of a contract
        findContract: contractName => SmartContracts.findContract(ipc, contractName),
        // insert a record in the table of the smart contract
        insert: (table, record) => SmartContracts.insert(ipc, contract, table, record),
        // insert a record in the table of the smart contract
        remove: (table, record) => SmartContracts.remove(ipc, contract, table, record),
        // insert a record in the table of the smart contract
        update: (table, record) => SmartContracts.update(ipc, contract, table, record),
        // get block information
        getBlockInfo: blockNum => SmartContracts.getBlockInfo(ipc, blockNum),
      };

      // logs used to store events or errors
      const results = {
        executedCodeHash: contractInDb.codeHash,
        logs: {
          errors: [],
          events: [],
        },
      };

      const rng = seedrandom(`${prevRefSteemBlockId}${refSteemBlockId}${transactionId}`);

      // init bignumber decimal places
      if (refSteemBlockNumber > 33719500) {
        BigNumber.set({ DECIMAL_PLACES: 20 });
      } else {
        BigNumber.set({ DECIMAL_PLACES: 3 });
      }

      // initialize the state that will be available in the VM
      const vmState = {
        api: {
          sender,
          owner: contractOwner,
          refSteemBlockNumber,
          steemBlockTimestamp: timestamp,
          contractVersion,
          transactionId,
          blockNumber,
          action,
          payload: JSON.parse(JSON.stringify(payloadObj)),
          db,
          BigNumber,
          validator,
          random: () => rng(),
          hash: (payloadToHash) => {
            if (typeof payloadToHash === 'string') {
              return SHA256(payloadToHash).toString(enchex);
            }
            return SHA256(JSON.stringify(payloadToHash)).toString(enchex);
          },
          checkSignature: (hash, signature, publicKey) => {
            if (typeof hash !== 'string'
            || typeof signature !== 'string'
            || typeof publicKey !== 'string') return null;
            const sig = dsteem.Signature.fromString(signature);
            const buffer = Buffer.from(hash, 'hex');

            return dsteem.PublicKey.fromString(publicKey).verify(buffer, sig);
          },
          debug: log => console.log(log), // eslint-disable-line no-console
          // execute a smart contract from the current smart contract
          executeSmartContract: async (
            contractName, actionName, parameters,
          ) => SmartContracts.executeSmartContractFromSmartContract(
            ipc, results, sender, payloadObj, contractName, actionName,
            JSON.stringify(parameters),
            blockNumber, timestamp,
            refSteemBlockNumber, refSteemBlockId, prevRefSteemBlockId, jsVMTimeout,
            contract, action, contractVersion,
          ),
          // execute a smart contract from the current smart contract
          // with the contractOwner authority level
          executeSmartContractAsOwner: async (
            contractName, actionName, parameters,
          ) => SmartContracts.executeSmartContractFromSmartContract(
            ipc, results, contractOwner, payloadObj, contractName, actionName,
            JSON.stringify(parameters),
            blockNumber, timestamp,
            refSteemBlockNumber, refSteemBlockId, prevRefSteemBlockId, jsVMTimeout,
            contract, action, contractVersion,
          ),
          // execute a token transfer from the contract balance
          transferTokens: async (
            to, symbol, quantity, type,
          ) => SmartContracts.executeSmartContractFromSmartContract(
            ipc, results, 'null', payloadObj, 'tokens', 'transferFromContract',
            JSON.stringify({
              from: contract,
              to,
              quantity,
              symbol,
              type,
            }),
            blockNumber, timestamp,
            refSteemBlockNumber, refSteemBlockId, prevRefSteemBlockId, jsVMTimeout,
            contract, action, contractVersion,
          ),
          // emit an event that will be stored in the logs
          emit: (event, data) => typeof event === 'string' && results.logs.events.push({ contract, event, data }),
          // add an error that will be stored in the logs
          assert: (condition, error) => {
            if (!condition && typeof error === 'string') {
              results.logs.errors.push(error);
            }
            return condition;
          },
        },
      };

      const error = await SmartContracts.runContractCode(vmState, contractCode, jsVMTimeout);

      if (error) {
        const { name, message } = error;
        if (name && typeof name === 'string'
          && message && typeof message === 'string') {
          return { logs: { errors: [`${name}: ${message}`] } };
        }

        return { logs: { errors: ['unknown error'] } };
      }

      return results;
    } catch (e) {
      // console.error('ERROR DURING CONTRACT EXECUTION: ', e);
      return { logs: { errors: [`${e.name}: ${e.message}`] } };
    }
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

  static async executeSmartContractFromSmartContract(
    ipc, originalResults, sender, originalParameters,
    contract, action, parameters,
    blockNumber,
    timestamp,
    refSteemBlockNumber, refSteemBlockId, prevRefSteemBlockId,
    jsVMTimeout,
    callingContractName, callingContractAction, callingContractVersion,
  ) {
    if (typeof contract !== 'string' || typeof action !== 'string' || (parameters && typeof parameters !== 'string')) return null;
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

    // pass the calling contract name and calling contract version to the contract
    sanitizedParams.callingContractInfo = {
      name: callingContractName,
      action: callingContractAction,
      version: callingContractVersion,
    };

    const results = {};
    try {
      const res = await SmartContracts.executeSmartContract(
        ipc,
        {
          sender,
          contract,
          action,
          payload: JSON.stringify(sanitizedParams),
          refSteemBlockNumber,
        },
        blockNumber,
        timestamp,
        refSteemBlockId,
        prevRefSteemBlockId,
        jsVMTimeout,
      );

      if (res && res.logs && res.logs.errors !== undefined) {
        res.logs.errors.forEach((error) => {
          if (results.errors === undefined) {
            results.errors = [];
          }
          if (originalResults.logs.errors === undefined) {
            originalResults.logs.errors = []; // eslint-disable-line no-param-reassign
          }

          originalResults.logs.errors.push(error);
          results.errors.push(error);
        });
      }

      if (res && res.logs && res.logs.events !== undefined) {
        res.logs.events.forEach((event) => {
          if (results.events === undefined) {
            results.events = [];
          }
          if (originalResults.logs.events === undefined) {
            originalResults.logs.events = []; // eslint-disable-line no-param-reassign
          }

          originalResults.logs.events.push(event);
          results.events.push(event);
        });
      }

      if (res && res.executedCodeHash) {
        results.executedCodeHash = res.executedCodeHash;
        originalResults.executedCodeHash += res.executedCodeHash; // eslint-disable-line
      }
    } catch (error) {
      results.errors = [];
      results.errors.push(error);
    }
    return results;
  }

  static async createTable(ipc, tables, contractName, tableName, indexes = []) {
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
      if (tables[finalTableName] === undefined) {
        tables[finalTableName] = { // eslint-disable-line
          size: 0,
          hash: '',
          nbIndexes: indexes.length,
        };
      }
    }
  }

  static async find(ipc, contractName, table, query, limit = 1000, offset = 0, indexes = []) {
    const res = await ipc.send({
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.FIND,
      payload: {
        contract: contractName,
        table,
        query,
        limit,
        offset,
        indexes,
      },
    });

    return res.payload;
  }

  static async findOne(ipc, contractName, table, query) {
    const res = await ipc.send({
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.FIND_ONE,
      payload: {
        contract: contractName,
        table,
        query,
      },
    });

    return res.payload;
  }

  static async findContract(ipc, contractName) {
    const res = await ipc.send({
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.FIND_CONTRACT,
      payload: {
        name: contractName,
      },
    });

    return res.payload;
  }

  static async insert(ipc, contractName, table, record) {
    const res = await ipc.send({
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.INSERT,
      payload: {
        contract: contractName,
        table,
        record,
      },
    });

    return res.payload;
  }

  static async dinsert(ipc, contractName, table, record) {
    const res = await ipc.send({
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.DINSERT,
      payload: {
        table: `${contractName}_${table}`,
        record,
      },
    });

    return res.payload;
  }

  static async remove(ipc, contractName, table, record) {
    const res = await ipc.send({
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.REMOVE,
      payload: {
        contract: contractName,
        table,
        record,
      },
    });

    return res.payload;
  }

  static async update(ipc, contractName, table, record) {
    const res = await ipc.send({
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.UPDATE,
      payload: {
        contract: contractName,
        table,
        record,
      },
    });

    return res.payload;
  }

  static async tableExists(ipc, contractName, table) {
    const res = await ipc.send({
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.TABLE_EXISTS,
      payload: {
        contract: contractName,
        table,
      },
    });

    return res.payload;
  }

  static async getBlockInfo(ipc, blockNumber) {
    const res = await ipc.send({
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.GET_BLOCK_INFO,
      payload: blockNumber,
    });

    return res.payload;
  }
}

module.exports.SmartContracts = SmartContracts;
