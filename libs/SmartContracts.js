/* eslint-disable max-len */

const SHA256FN = require('crypto-js/sha256');
const enchex = require('crypto-js/enc-hex');
const dsteem = require('dsteem');
const { Base64 } = require('js-base64');
const { VM, VMScript } = require('vm2');
const BigNumber = require('bignumber.js');
const validator = require('validator');
const seedrandom = require('seedrandom');
const { CONSTANTS } = require('../libs/Constants');

const RESERVED_CONTRACT_NAMES = ['contract', 'blockProduction', 'null'];
const RESERVED_ACTIONS = ['createSSC'];

const JSVMs = [];
const MAXJSVMs = 5;

class SmartContracts {
  // deploy the smart contract to the blockchain and initialize the database if needed
  static async deploySmartContract(
    database, transaction, blockNumber, timestamp, refHiveBlockId, prevRefHiveBlockId, jsVMTimeout,
  ) {
    try {
      const { transactionId, refHiveBlockNumber, sender } = transaction;
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

        existingContract = await database.findContract({ name });

        let finalSender = sender;

        // allow "HIVE_ENGINE_ACCOUNT" to update contracts owned by "null"
        if (existingContract && finalSender === CONSTANTS.HIVE_ENGINE_ACCOUNT && existingContract.owner === 'null') {
          finalSender = 'null';
        }

        if (existingContract && existingContract.owner !== finalSender) {
          return { logs: { errors: ['you are not allowed to update this contract'] } };
        }

        // this code template is used to manage the code of the smart contract
        // this way we keep control of what can be executed in a smart contract
        let codeTemplate = `
          function wrapper () {
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
          }

          wrapper();
        `;

        // the code of the smart contarct comes as a Base64 encoded string
        codeTemplate = codeTemplate.replace('###ACTIONS###', Base64.decode(code));

        // compile the code for faster executions later on
        const script = new VMScript(codeTemplate).compile();

        const tables = {};

        // prepare the db object that will be available in the VM
        const db = {
          // create a new table for the smart contract
          createTable: (tableName, indexes = []) => SmartContracts.createTable(
            database, tables, name, tableName, indexes,
          ),
          // perform a query find on a table of the smart contract
          find: (table, query, limit = 1000, offset = 0, indexes = []) => SmartContracts.find(
            database, name, table, query, limit, offset, indexes,
          ),
          // perform a query find on a table of an other smart contract
          findInTable: (contractName, table, query, limit = 1000, offset = 0, index = '', descending = false) => SmartContracts.find(
            database, contractName, table, query, limit, offset, index, descending,
          ),
          // perform a query findOne on a table of the smart contract
          findOne: (table, query) => SmartContracts.findOne(database, name, table, query),
          // perform a query findOne on a table of an other smart contract
          findOneInTable: (contractName, table, query) => SmartContracts.findOne(
            database, contractName, table, query,
          ),
          // find the information of a contract
          findContract: contractName => SmartContracts.findContract(database, contractName),
          // insert a record in the table of the smart contract
          insert: (table, record) => SmartContracts.dinsert(database, name, table, record),
          // insert a record in the table of the smart contract
          remove: (table, record) => SmartContracts.remove(database, name, table, record),
          // insert a record in the table of the smart contract
          update: (table, record, unsets = undefined) => SmartContracts.update(database, name, table, record, unsets),
          // check if a table exists
          tableExists: table => SmartContracts.tableExists(database, name, table),
        };

        // logs used to store events or errors
        const logs = {
          errors: [],
          events: [],
        };

        const rng = seedrandom(`${prevRefHiveBlockId}${refHiveBlockId}${transactionId}`);

        // init bignumber decimal places
        BigNumber.set({ DECIMAL_PLACES: 20 });

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
            refHiveBlockNumber,
            hiveBlockTimestamp: timestamp,
            contractVersion,
            db,
            BigNumber,
            validator,
            SHA256: (payloadToHash) => {
              if (typeof payloadToHash === 'string') {
                return SHA256FN(payloadToHash).toString(enchex);
              }

              return SHA256FN(JSON.stringify(payloadToHash)).toString(enchex);
            },
            checkSignature: (payloadToCheck, signature, publicKey, isPayloadSHA256 = false) => {
              if ((typeof payloadToCheck !== 'string'
              && typeof payloadToCheck !== 'object')
              || typeof signature !== 'string'
              || typeof publicKey !== 'string') return false;
              try {
                const sig = dsteem.Signature.fromString(signature);
                const finalPayload = typeof payloadToCheck === 'string' ? payloadToCheck : JSON.stringify(payloadToCheck);
                const payloadHash = isPayloadSHA256 === true
                  ? finalPayload
                  : SHA256FN(finalPayload).toString(enchex);
                const buffer = Buffer.from(payloadHash, 'hex');
                return dsteem.PublicKey.fromString(publicKey).verify(buffer, sig);
              } catch (error) {
                return false;
              }
            },
            random: () => rng(),
            debug: log => console.log(log), // eslint-disable-line no-console
            // execute a smart contract from the current smart contract
            executeSmartContract: async (
              contractName, actionName, parameters,
            ) => SmartContracts.executeSmartContractFromSmartContract(
              database, logs, finalSender, params, contractName, actionName,
              JSON.stringify(parameters),
              blockNumber, timestamp,
              refHiveBlockNumber, refHiveBlockId, prevRefHiveBlockId, jsVMTimeout,
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
            isValidAccountName: account => SmartContracts.isValidAccountName(account),
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
          codeHash: SHA256FN(codeTemplate).toString(enchex),
          tables,
          version: 1,
        };

        // if contract already exists, update it
        if (existingContract !== null) {
          newContract._id = existingContract._id; // eslint-disable-line no-underscore-dangle
          newContract.tables = Object.assign(existingContract.tables, newContract.tables);
          newContract.version = existingContract.version + 1;

          await database.updateContract(newContract);
        } else {
          await database.addContract(newContract);
        }
        return { executedCodeHash: newContract.codeHash, logs };
      }
      return { logs: { errors: ['parameters name and code are mandatory and they must be strings'] } };
    } catch (e) {
      // console.error('ERROR DURING CONTRACT DEPLOYMENT: ', name, e);
      return { logs: { errors: [`${e.name}: ${e.message}`] } };
    }
  }

  // execute the smart contract and perform actions on the database if needed
  static async executeSmartContract(
    database, transaction, blockNumber, timestamp, refHiveBlockId, prevRefHiveBlockId, jsVMTimeout,
  ) {
    try {
      const {
        transactionId,
        sender,
        contract,
        action,
        payload,
        refHiveBlockNumber,
      } = transaction;

      if (RESERVED_ACTIONS.includes(action)) return { logs: { errors: ['you cannot trigger this action'] } };

      const payloadObj = payload ? JSON.parse(payload) : {};

      const contractInDb = await database.findContract({ name: contract });
      if (contractInDb === null) {
        return { logs: { errors: ['contract doesn\'t exist'] } };
      }

      const contractCode = contractInDb.code;
      const contractOwner = contractInDb.owner;
      const contractVersion = contractInDb.version;

      const tables = {};

      // prepare the db object that will be available in the VM
      const db = {
        // create a new table for the smart contract
        createTable: (tableName, indexes = []) => SmartContracts.createTable(
          database, tables, contract, tableName, indexes,
        ),
        // perform a query find on a table of the smart contract
        find: (table, query, limit = 1000, offset = 0, indexes = []) => SmartContracts.find(
          database, contract, table, query, limit, offset, indexes,
        ),
        // perform a query find on a table of an other smart contract
        findInTable: (contractName, table, query, limit = 1000, offset = 0, index = '', descending = false) => SmartContracts.find(
          database, contractName, table, query, limit, offset, index, descending,
        ),
        // perform a query findOne on a table of the smart contract
        findOne: (table, query) => SmartContracts.findOne(database, contract, table, query),
        // perform a query findOne on a table of an other smart contract
        findOneInTable: (contractName, table, query) => SmartContracts.findOne(
          database, contractName, table, query,
        ),
        // find the information of a contract
        findContract: contractName => SmartContracts.findContract(database, contractName),
        // insert a record in the table of the smart contract
        insert: (table, record) => SmartContracts.insert(database, contract, table, record),
        // insert a record in the table of the smart contract
        remove: (table, record) => SmartContracts.remove(database, contract, table, record),
        // insert a record in the table of the smart contract
        update: (table, record, unsets = undefined) => SmartContracts.update(database, contract, table, record, unsets),
        // check if a table exists
        tableExists: table => SmartContracts.tableExists(database, contract, table),
        // get block information
        getBlockInfo: blockNum => SmartContracts.getBlockInfo(database, blockNum),
      };

      // logs used to store events or errors
      const results = {
        executedCodeHash: contractInDb.codeHash,
        logs: {
          errors: [],
          events: [],
        },
      };

      const rng = seedrandom(`${prevRefHiveBlockId}${refHiveBlockId}${transactionId}`);

      // init bignumber decimal places
      if (refHiveBlockNumber > 33719500) {
        BigNumber.set({ DECIMAL_PLACES: 20 });
      } else {
        BigNumber.set({ DECIMAL_PLACES: 3 });
      }

      // initialize the state that will be available in the VM
      const vmState = {
        api: {
          sender,
          owner: contractOwner,
          refHiveBlockNumber,
          hiveBlockTimestamp: timestamp,
          contractVersion,
          transactionId,
          blockNumber,
          action,
          payload: JSON.parse(JSON.stringify(payloadObj)),
          db,
          BigNumber,
          validator,
          logs: () => JSON.parse(JSON.stringify(results.logs)),
          random: () => rng(),
          SHA256: (payloadToHash) => {
            if (typeof payloadToHash === 'string') {
              return SHA256FN(payloadToHash).toString(enchex);
            }
            return SHA256FN(JSON.stringify(payloadToHash)).toString(enchex);
          },
          checkSignature: (payloadToCheck, signature, publicKey, isPayloadSHA256 = false) => {
            if ((typeof payloadToCheck !== 'string'
            && typeof payloadToCheck !== 'object')
            || typeof signature !== 'string'
            || typeof publicKey !== 'string') return false;
            try {
              const sig = dsteem.Signature.fromString(signature);
              const finalPayload = typeof payloadToCheck === 'string' ? payloadToCheck : JSON.stringify(payloadToCheck);
              const payloadHash = isPayloadSHA256 === true
                ? finalPayload
                : SHA256FN(finalPayload).toString(enchex);
              const buffer = Buffer.from(payloadHash, 'hex');
              return dsteem.PublicKey.fromString(publicKey).verify(buffer, sig);
            } catch (error) {
              return false;
            }
          },
          debug: log => console.log(log), // eslint-disable-line no-console
          // execute a smart contract from the current smart contract
          executeSmartContract: async (
            contractName, actionName, parameters,
          ) => SmartContracts.executeSmartContractFromSmartContract(
            database, results, sender, payloadObj, contractName, actionName,
            JSON.stringify(parameters),
            blockNumber, timestamp,
            refHiveBlockNumber, refHiveBlockId, prevRefHiveBlockId, jsVMTimeout,
            contract, action, contractVersion,
          ),
          // execute a smart contract from the current smart contract
          // with the contractOwner authority level
          executeSmartContractAsOwner: async (
            contractName, actionName, parameters,
          ) => SmartContracts.executeSmartContractFromSmartContract(
            database, results, contractOwner, payloadObj, contractName, actionName,
            JSON.stringify(parameters),
            blockNumber, timestamp,
            refHiveBlockNumber, refHiveBlockId, prevRefHiveBlockId, jsVMTimeout,
            contract, action, contractVersion,
          ),
          // execute a token transfer from the contract balance
          transferTokens: async (
            to, symbol, quantity, type,
          ) => SmartContracts.executeSmartContractFromSmartContract(
            database, results, 'null', payloadObj, 'tokens', 'transferFromContract',
            JSON.stringify({
              from: contract,
              to,
              quantity,
              symbol,
              type,
            }),
            blockNumber, timestamp,
            refHiveBlockNumber, refHiveBlockId, prevRefHiveBlockId, jsVMTimeout,
            contract, action, contractVersion,
          ),
          verifyBlock: async (block) => {
            if (contract !== 'witnesses') return;
            SmartContracts.verifyBlock(database, block);
          },
          // emit an event that will be stored in the logs
          emit: (event, data) => typeof event === 'string' && results.logs.events.push({ contract, event, data }),
          // add an error that will be stored in the logs
          assert: (condition, error) => {
            if (!condition && typeof error === 'string') {
              results.logs.errors.push(error);
            }
            return condition;
          },
          isValidAccountName: account => SmartContracts.isValidAccountName(account),
        },
      };

      // if action is called from another contract, we can add an additional function
      // to allow token transfers from the calling contract
      if ('callingContractInfo' in payloadObj) {
        vmState.api.transferTokensFromCallingContract = async (
          to, symbol, quantity, type,
        ) => SmartContracts.executeSmartContractFromSmartContract(
          database, results, 'null', payloadObj, 'tokens', 'transferFromContract',
          JSON.stringify({
            from: payloadObj.callingContractInfo.name,
            to,
            quantity,
            symbol,
            type,
          }),
          blockNumber, timestamp,
          refHiveBlockNumber, refHiveBlockId, prevRefHiveBlockId, jsVMTimeout,
          contract, contractVersion,
        );
      }

      const error = await SmartContracts.runContractCode(vmState, contractCode, jsVMTimeout);

      if (error) {
        const { name, message } = error;
        if (name && typeof name === 'string'
          && message && typeof message === 'string') {
          return { logs: { errors: [`${name}: ${message}`] } };
        }

        return { logs: { errors: ['unknown error'] } };
      }

      // if new tables were created, we need to do a contract update
      if (Object.keys(tables).length > 0) {
        Object.assign(contractInDb.tables, tables);
        await database.updateContract(contractInDb);
      }

      return results;
    } catch (e) {
      // console.error('ERROR DURING CONTRACT EXECUTION: ', e);
      return { logs: { errors: [`${e.name}: ${e.message}`] } };
    }
  }

  static getJSVM(jsVMTimeout) {
    let vm = null;

    vm = JSVMs.find(v => v.inUse === false);

    if (vm === undefined) {
      if (JSVMs.length < MAXJSVMs) {
        vm = {
          vm: new VM({
            timeout: jsVMTimeout,
            sandbox: {
            },
          }),
          inUse: true,
        };
        JSVMs.push(vm);
      }
    }

    if (vm === undefined) {
      vm = null;
    } else {
      // eslint-disable-next-line no-underscore-dangle
      Object.keys(vm.vm._context).filter(key => key !== 'VMError' && key !== 'Buffer' && key !== 'api').forEach((key) => {
        // eslint-disable-next-line no-underscore-dangle
        delete vm.vm._context[key];
      });
      // eslint-disable-next-line no-underscore-dangle
      vm.vm._context.api = {};
      vm.inUse = true;
    }

    return vm;
  }

  // run the contractCode in a VM with the vmState as a state for the VM
  static runContractCode(vmState, contractCode, jsVMTimeout) {
    return new Promise((resolve) => {
      const vm = SmartContracts.getJSVM(jsVMTimeout);
      try {
        // run the code in the VM
        if (vm !== null) {
          // eslint-disable-next-line no-underscore-dangle
          Object.keys(vmState.api).forEach((key) => {
            // eslint-disable-next-line no-underscore-dangle
            vm.vm._context.api[key] = vmState.api[key];
          });
          // eslint-disable-next-line no-underscore-dangle
          vm.vm._context.done = (error) => {
            // console.log('error', error);
            vm.inUse = false;
            resolve(error);
          };

          vm.vm.run(contractCode);
        } else {
          resolve('no JS VM available');
        }
      } catch (err) {
        // console.log('error', err);
        vm.inUse = false;
        resolve(err);
      }
    });
  }

  static async executeSmartContractFromSmartContract(
    ipc, originalResults, sender, originalParameters,
    contract, action, parameters,
    blockNumber,
    timestamp,
    refHiveBlockNumber, refHiveBlockId, prevRefHiveBlockId,
    jsVMTimeout,
    callingContractName, callingContractAction, callingContractVersion,
  ) {
    if (typeof contract !== 'string' || typeof action !== 'string' || (parameters && typeof parameters !== 'string')) return null;
    const sanitizedParams = parameters ? JSON.parse(parameters) : null;

    // check if a recipient or amountHIVEHBD
    //  or isSignedWithActiveKey  were passed initially
    if (originalParameters && originalParameters.amountHIVEHBD) {
      sanitizedParams.amountHIVEHBD = originalParameters.amountHIVEHBD;
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
          refHiveBlockNumber,
        },
        blockNumber,
        timestamp,
        refHiveBlockId,
        prevRefHiveBlockId,
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

  static async verifyBlock(database, block) {
    await database.verifyBlock(block);
  }

  static isValidAccountName(value) {
    if (!value) {
      // Account name should not be empty.
      return false;
    }

    if (typeof value !== 'string') {
      // Account name should be a string.
      return false;
    }

    let len = value.length;
    if (len < 3) {
      // Account name should be longer.
      return false;
    }
    if (len > 16) {
      // Account name should be shorter.
      return false;
    }

    const ref = value.split('.');
    len = ref.length;
    for (let i = 0; i < len; i += 1) {
      const label = ref[i];
      if (label.length < 3) {
        // Each account segment be longer
        return false;
      }

      if (!/^[a-z]/.test(label)) {
        // Each account segment should start with a letter.
        return false;
      }

      if (!/^[a-z0-9-]*$/.test(label)) {
        // Each account segment have only letters, digits, or dashes.
        return false;
      }

      if (/--/.test(label)) {
        // Each account segment have only one dash in a row.
        return false;
      }

      if (!/[a-z0-9]$/.test(label)) {
        // Each account segment end with a letter or digit.
        return false;
      }
    }

    return true;
  }

  static async createTable(database, tables, contractName, tableName, indexes = []) {
    const result = await database.createTable({
      contractName,
      tableName,
      indexes,
    });

    if (result === true) {
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

  static async find(database, contractName, table, query, limit = 1000, offset = 0, indexes = []) {
    const result = await database.find({
      contract: contractName,
      table,
      query,
      limit,
      offset,
      indexes,
    });

    return result;
  }

  static async findOne(database, contractName, table, query) {
    const result = await database.findOne({
      contract: contractName,
      table,
      query,
    });

    return result;
  }

  static async findContract(database, contractName) {
    const contract = await database.findContract({
      name: contractName,
    });

    return contract;
  }

  static async insert(database, contractName, table, record) {
    const result = await database.insert({
      contract: contractName,
      table,
      record,
    });

    return result;
  }

  static async dinsert(database, contractName, table, record) {
    const result = await database.dinsert({
      contract: contractName,
      table: `${contractName}_${table}`,
      record,
    });

    return result;
  }

  static async remove(database, contractName, table, record) {
    const result = await database.remove({
      contract: contractName,
      table,
      record,
    });

    return result;
  }

  static async update(database, contractName, table, record, unsets) {
    const result = await database.update({
      contract: contractName,
      table,
      record,
      unsets,
    });

    return result;
  }

  static async tableExists(database, contractName, table) {
    const result = await database.tableExists({
      contract: contractName,
      table,
    });

    return result;
  }

  static async getBlockInfo(database, blockNumber) {
    const result = await database.getBlockInfo(blockNumber);

    return result;
  }
}

module.exports.SmartContracts = SmartContracts;
