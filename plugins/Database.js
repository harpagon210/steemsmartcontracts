const fs = require('fs-extra');
// const Loki = require('lokijs');
const { MongoClient } = require('mongodb');
const { Database, aql } = require('arangojs');
const builder = require('mongo-aql-fixed');


const SHA256 = require('crypto-js/sha256');
const enchex = require('crypto-js/enc-hex');
const validator = require('validator');
// const lfsa = require('../libs/loki-fs-structured-adapter');
const { IPC } = require('../libs/IPC');
const { BlockProduction } = require('../libs/BlockProduction');

const BC_PLUGIN_NAME = require('./Blockchain.constants').PLUGIN_NAME;
const BC_PLUGIN_ACTIONS = require('./Blockchain.constants').PLUGIN_ACTIONS;
const { BP_PLUGIN_ACTIONS } = require('../libs/BlockProduction.contants').CONSTANTS;


const { PLUGIN_NAME, PLUGIN_ACTIONS } = require('./Database.constants');

const PLUGIN_PATH = require.resolve(__filename);

const actions = {};

const ipc = new IPC(PLUGIN_NAME);

let database = null;
let chain = null;
let saving = false;
let databaseHash = '';

const initSequence = async (name) => {
  const sequences = database.collection('sequences');

  await sequences.insertOne({ _id: name, seq: 1 });
};

const getNextSequence = async (name) => {
  const sequences = database.collection('sequences');

  const sequence = await sequences.findOneAndUpdate(
    { _id: name }, { $inc: { seq: 1 } }, { new: true },
  );


  return sequence.value.seq;
};

const getLastSequence = async (name) => {
  const sequences = database.collection('sequences');

  const sequence = await sequences.findOne({ _id: name });

  return sequence.seq;
};

const getCollection = async name => new Promise((resolve) => {
  database.collection(name, { strict: true }, (err, collection) => {
    // collection does not exist
    if (err) {
      resolve(null);
    }
    resolve(collection);
  });
});

// load the database from the filesystem
async function init(conf, callback) {
  const {
    databaseURL,
    databaseName,
  } = conf;

  try {
    // init the database
    database = new Database(databaseURL);
    await database.createDatabase(databaseName);
    database.useDatabase(databaseName);

    // get the chain collection and init the chain if not done yet

    chain = database.collection('chain');
    const chainExists = await chain.exists();

    if (chainExists === false) {
      chain = database.collection('chain');
      await chain.create({
        keyOptions: {
          type: 'autoincrement',
        },
      });

      let coll = database.collection('transactions');
      await coll.create({
        keyOptions: {
          type: 'autoincrement',
        },
      });
      await coll.createHashIndex('txID', { unique: true });

      coll = database.collection('contracts');
      await coll.create({
        keyOptions: {
          type: 'autoincrement',
        },
      });
      await coll.createHashIndex('name');
    }

    callback(null);
  } catch (error) {
    throw error;
  }
}

async function generateGenesisBlock(conf, callback) {
  const {
    chainId,
    genesisSteemBlock,
  } = conf;

  // check if genesis block hasn't been generated already
  let genBlock = await actions.getBlockInfo(0);

  if (!genBlock) {
    // insert the genesis block
    const res = await ipc.send(
      {
        to: BC_PLUGIN_NAME,
        action: BC_PLUGIN_ACTIONS.CREATE_GENESIS_BLOCK,
        payload: {
          chainId,
          genesisSteemBlock,
        },
      },
    );
    genBlock = res.payload;
    await chain.save(genBlock);
  }

  callback();
}

// save the blockchain as well as the database on the filesystem
actions.save = (callback) => {
  saving = true;

  saving = false;
  callback(null);
};

// save the blockchain as well as the database on the filesystem
const stop = (callback) => {
  actions.save(callback);
};

const addTransactions = async (block) => {
  const transactionsTable = database.collection('transactions');
  const { transactions } = block;
  const nbTransactions = transactions.length;

  for (let index = 0; index < nbTransactions; index += 1) {
    const transaction = transactions[index];
    const transactionToSave = {
      txID: transaction.transactionId,
      blockNumber: block.blockNumber,
      index,
    };

    await transactionsTable.save(transactionToSave); // eslint-disable-line no-await-in-loop
  }
};

const updateTableHash = async (contract, table, record) => {
  try {
    const contracts = database.collection('contracts');
    const contractInDb = await contracts.firstExample({ name: contract });

    if (contractInDb && contractInDb.tables[table] !== undefined) {
      const recordHash = SHA256(JSON.stringify(record)).toString(enchex);
      const tableHash = contractInDb.tables[table].hash;
      const newData = {};
      newData.tables = contractInDb.tables;
      newData.tables[table].hash = SHA256(tableHash + recordHash).toString(enchex);

      await contracts.update(contractInDb._key, newData);

      databaseHash = SHA256(databaseHash + contractInDb.tables[table].hash).toString(enchex);
    }
  } catch (error) {
    console.log('updateTableHash:', contract, table);
    // console.log('updateTableHash', error);
  }
};

actions.initDatabaseHash = (previousDatabaseHash, callback) => {
  databaseHash = previousDatabaseHash;
  callback();
};

actions.getDatabaseHash = (payload, callback) => {
  callback(databaseHash);
};

actions.getTransactionInfo = async (txID, callback) => { // eslint-disable-line no-unused-vars
  try {
    const transactionsTable = database.collection('transactions');

    const transaction = await transactionsTable.firstExample({ txID });

    let result = null;

    if (transaction) {
      const { index, blockNumber } = transaction;
      const block = await actions.getBlockInfo(blockNumber);

      if (block) {
        result = Object.assign({}, { blockNumber }, block.transactions[index]);
      }
    }

    callback(result);
  } catch (error) {
    console.log('getTransactionInfo:', error);
  }
};

actions.addBlock = async (block, callback) => { // eslint-disable-line no-unused-vars
  try {
    await chain.save(block);
    await addTransactions(block);

    callback();
  } catch (error) {
    console.log('addBlock:', error);
  }
};

actions.getLatestBlockInfo = async (payload, callback) => { // eslint-disable-line no-unused-vars
  let block;
  try {
    const res = await chain.count();

    block = await chain.document(res.count.toString());
  } catch (error) {
    block = null;
  }

  if (callback) {
    callback(block);
  }

  return block;
};

actions.getBlockInfo = async (blockNumber, callback) => {
  let block;
  try {
    block = await chain.document((blockNumber + 1).toString());
  } catch (error) {
    block = null;
  }

  if (callback) {
    callback(block);
  }

  return block;
};

/**
 * Get the information of a contract (owner, source code, etc...)
 * @param {String} contract name of the contract
 * @returns {Object} returns the contract info if it exists, null otherwise
 */
actions.findContract = async (payload, callback) => {
  try {
    const { name } = payload;
    if (name && typeof name === 'string') {
      const contracts = database.collection('contracts');

      const contractInDb = await contracts.firstExample({ name });

      if (contractInDb) {
        if (callback) {
          callback(contractInDb);
        }
        return contractInDb;
      }
    }

    if (callback) {
      callback(null);
    }
    return null;
  } catch (error) {
    //console.log('findContract:', error);
    if (callback) {
      callback(null);
    }
    return null;
  }
};

/**
 * add a smart contract to the database
 * @param {String} name name of the contract
 * @param {String} owner owner of the contract
 * @param {String} code code of the contract
 * @param {String} tables tables linked to the contract
 */
actions.addContract = async (payload, callback) => { // eslint-disable-line no-unused-vars
  try {
    const {
      name,
      owner,
      code,
      tables,
    } = payload;

    if (name && typeof name === 'string'
      && owner && typeof owner === 'string'
      && code && typeof code === 'string'
      && tables && typeof tables === 'object') {
      const contracts = database.collection('contracts');
      await contracts.save(payload);
    }

    callback();
  } catch (error) {
    console.log('addContract:', error);
  }
};

/**
 * Add a table to the database
 * @param {String} contractName name of the contract
 * @param {String} tableName name of the table
 * @param {Array} indexes array of string containing the name of the indexes to create
 */
actions.createTable = async (payload, callback) => { // eslint-disable-line no-unused-vars
  try {
    const { contractName, tableName, indexes } = payload;
    let result = false;

    // check that the params are correct
    // each element of the indexes array have to be a string if defined
    if (validator.isAlphanumeric(tableName)
      && Array.isArray(indexes)
      && (indexes.length === 0
        || (indexes.length > 0 && indexes.every(el => typeof el === 'string' && validator.isAlphanumeric(el))))) {
      const finalTableName = `${contractName}_${tableName}`;
      // get the table from the database
      const table = database.collection(finalTableName);
      const tableExist = await table.exists();
      if (tableExist === false) {
        // if it doesn't exist, create it (with the binary indexes)
        await table.create({
          keyOptions: {
            type: 'autoincrement',
          },
        });

        const nbIndexes = indexes.length;

        for (let i = 0; i < nbIndexes; i += 1) {
          const index = indexes[i];
          await table.createHashIndex(index); // eslint-disable-line no-await-in-loop
        }

        result = true;
      }
    }

    callback(result);
  } catch (error) {
    console.log('createTable:', error);
  }
};

/**
 * retrieve records from the table of a contract
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {JSON} query query to perform on the table
 * @param {Integer} limit limit the number of records to retrieve
 * @param {Integer} offset offset applied to the records set
 * @param {Array<Object>} indexes array of index definitions { index: string, descending: boolean }
 * @returns {Array<Object>} returns an array of objects if records found, an empty array otherwise
 */
actions.find = async (payload, callback) => { // eslint-disable-line no-unused-vars
  try {
    const {
      contract,
      table,
      query,
      limit,
      offset,
      indexes,
    } = payload;

    const lim = limit || 1000;
    const off = offset || 0;
    const ind = indexes || [];
    let result = null;

    if (contract && typeof contract === 'string'
      && table && typeof table === 'string'
      && query && typeof query === 'object'
      && JSON.stringify(query).indexOf('$regex') === -1
      && Array.isArray(ind)
      && (ind.length === 0
        || (ind.length > 0
          && ind.every(el => el.index && typeof el.index === 'string'
            && el.descending !== undefined && typeof el.descending === 'boolean')))
      && Number.isInteger(lim)
      && Number.isInteger(off)
      && lim > 0 && lim <= 1000
      && off >= 0) {
      const finalTableName = `${contract}_${table}`;
      const tableData = database.collection(finalTableName);
      const tableExists = await tableData.exists();

      if (tableExists === true) {
        // if there is an index passed, check if it exists
        // TODO: check index exists
        /*
        if (ind.length > 0 && ind.every(el => tableData.binaryIndices[el.index] !== undefined || el.index === '$loki')) {
          return tableData.chain()
            .find(query)
            .compoundsort(ind.map(el => [el.index, el.descending]))
            .offset(off)
            .limit(lim)
            .data();
        } */

        const q = query;

        q.$limit = lim;
        q.$skip = off;

        const nbIndexes = ind.length;
        if (nbIndexes > 0) {
          q.$orderby = {};
          for (let i = 0; i < nbIndexes; i += 1) {
            const idx = ind[i];
            q.$orderby[idx.index] = idx.descending === true ? 0 : 1;
          }
        }

        const finalQuery = builder(finalTableName, q);
        //console.log(finalQuery)
        const cursor = await database.query(finalQuery.query, finalQuery.values);
        result = await cursor.all();
      }
    }

    callback(result);
  } catch (error) {
    console.log('find:', error);
    callback(null);
  }
};

/**
 * retrieve a record from the table of a contract
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {JSON} query query to perform on the table
 * @returns {Object} returns a record if it exists, null otherwise
 */
actions.findOne = async (payload, callback) => { // eslint-disable-line no-unused-vars
  try {
    const { contract, table, query } = payload;
    let result = null;
    if (contract && typeof contract === 'string'
      && table && typeof table === 'string'
      && query && typeof query === 'object'
      && JSON.stringify(query).indexOf('$regex') === -1) {
      const finalTableName = `${contract}_${table}`;

      const tableData = database.collection(finalTableName);
      const tableExists = await tableData.exists();

      if (tableExists === true) {
        const q = query;

        q.$limit = 1;

        const finalQuery = builder(finalTableName, q);

        const cursor = await database.query(finalQuery.query, finalQuery.values);

        result = await cursor.all();

        result = result.length > 0 ? result[0] : null;
      }
    }

    callback(result);
  } catch (error) {
    console.log('findOne:', error);
    callback(null);
  }
};

/**
 * insert a record in the table of a contract
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {String} record record to save in the table
 */
actions.insert = async (payload, callback) => { // eslint-disable-line no-unused-vars
  try {
    const { contract, table, record } = payload;
    const finalTableName = `${contract}_${table}`;
    let finalRec = null;

    const contractInDb = await actions.findContract({ name: contract });
    if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
      const tableInDb = database.collection(finalTableName);
      const tableExists = await tableInDb.exists();

      if (tableExists === true) {
        finalRec = await tableInDb.save(record, { returnNew: true });
        finalRec = finalRec.new;
        await updateTableHash(contract, finalTableName, record);
      }
    }

    callback(finalRec);
  } catch (error) {
    console.log('insert:', error);
    callback(null);
  }
};

/**
 * remove a record in the table of a contract
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {String} record record to remove from the table
 */
actions.remove = async (payload, callback) => { // eslint-disable-line no-unused-vars
  try {
    const { contract, table, record } = payload;
    const finalTableName = `${contract}_${table}`;

    const contractInDb = await actions.findContract({ name: contract });
    if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
      const tableInDb = database.collection(finalTableName);
      const tableExists = await tableInDb.exists();

      if (tableExists === true) {
        await updateTableHash(contract, finalTableName, record);
        tableInDb.remove(record); // eslint-disable-line no-underscore-dangle

        callback();
      }
    }
  } catch (error) {
    console.log('remove:', error);
    callback(null);
  }
};

/**
 * update a record in the table of a contract
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {String} record record to update in the table
 */
actions.update = async (payload, callback) => { // eslint-disable-line no-unused-vars
  try {
    const { contract, table, record } = payload;
    const finalTableName = `${contract}_${table}`;

    const contractInDb = await actions.findContract({ name: contract });
    if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
      const tableInDb = database.collection(finalTableName);
      const tableExists = await tableInDb.exists();

      if (tableExists === true) {
        await updateTableHash(contract, finalTableName, record);

        tableInDb.update(record, record); // eslint-disable-line
      }
    }

    callback();
  } catch (error) {
    console.log('update:', error);
    callback(null);
  }
};

/**
 * get the details of a smart contract table
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {String} record record to update in the table
 * @returns {Object} returns the table indexes, null otherwise
 */
actions.getTableDetails = async (payload, callback) => { // eslint-disable-line no-unused-vars
  const { contract, table } = payload;
  const finalTableName = `${contract}_${table}`;
  const contractInDb = await actions.findContract({ name: contract });
  let tableDetails = null;
  if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
    const tableInDb = await getCollection(finalTableName);
    tableDetails = {};
    tableDetails.indexes = await tableInDb.getIndexes();
  }

  callback(tableDetails);
};

/**
 * retrieve records from the table
 * @param {String} table table name
 * @param {JSON} query query to perform on the table
 * @param {Integer} limit limit the number of records to retrieve
 * @param {Integer} offset offset applied to the records set
 * @param {Array<Object>} indexes array of index definitions { index: string, descending: boolean }
 * @returns {Array<Object>} returns an array of objects if records found, an empty array otherwise
 */
actions.dfind = async (payload, callback) => { // eslint-disable-line no-unused-vars
  try {
    const {
      table,
      query,
      limit,
      offset,
      indexes,
    } = payload;

    const lim = limit || 1000;
    const off = offset || 0;
    const ind = indexes || [];

    const tableInDb = database.collection(table);
    const tableExists = await tableInDb.exists();

    let records = [];

    if (tableExists === true) {
      const q = query;

      q.$limit = lim;
      q.$skip = off;

      const nbIndexes = ind.length;
      if (nbIndexes > 0) {
        q.$orderby = {};
        for (let i = 0; i < nbIndexes; i += 1) {
          const idx = ind[i];
          q.$orderby[idx.index] = idx.descending === true ? 0 : 1;
        }
      }

      const finalQuery = builder(table, q);

      const cursor = await database.query(finalQuery.query, finalQuery.values);
      records = await cursor.all();
    }

    callback(records);
  } catch (error) {
    console.log('dfind:', error);
    callback(null);
  }
};

/**
 * retrieve a record from the table
 * @param {String} table table name
 * @param {JSON} query query to perform on the table
 * @returns {Object} returns a record if it exists, null otherwise
 */
actions.dfindOne = async (payload, callback) => { // eslint-disable-line no-unused-vars
  try {
    const { table, query } = payload;

    let record = null;
    const tableInDb = database.collection(table);
    const tableExists = await tableInDb.exists();

    if (tableExists === true) {
      const q = query;

      q.$limit = 1;

      const finalQuery = builder(table, q);

      const cursor = await database.query(finalQuery.query, finalQuery.values);
      record = await cursor.all();
      record = record.length > 0 ? record[0] : null;
    }

    callback(record);
  } catch (error) {
    console.log('dfindOne:', error);
    callback(null);
  }
};

/**
 * insert a record
 * @param {String} table table name
 * @param {String} record record to save in the table
 */
actions.dinsert = async (payload, callback) => { // eslint-disable-line no-unused-vars
  try {
    const { table, record } = payload;
    let finalRecord = null;

    const tableInDb = database.collection(table);
    const tableExists = await tableInDb.exists();

    if (tableExists === true) {
      finalRecord = await tableInDb.save(record, { returnNew: true });
      finalRecord = finalRecord.new;
      await updateTableHash(table.split('_')[0], table.split('_')[1], record);
    }

    callback(finalRecord);
  } catch (error) {
    console.log('dinsert:', error);
    callback(null);
  }
};

/**
 * update a record in the table
 * @param {String} table table name
 * @param {String} record record to update in the table
 */
actions.dupdate = async (payload, callback) => { // eslint-disable-line no-unused-vars
  try {
    const { table, record } = payload;

    const tableInDb = database.collection(table);
    const tableExists = await tableInDb.exists();

    if (tableExists === true) {
      await updateTableHash(table.split('_')[0], table.split('_')[1], record);
      await tableInDb.update(record, record);
    }

    callback();
  } catch (error) {
    console.log('dupdate:', error);
    callback(null);
  }
};

/**
 * remove a record
 * @param {String} table table name
 * @param {String} record record to remove from the table
 */
actions.dremove = async (payload, callback) => { // eslint-disable-line no-unused-vars
  try {
    const { table, record } = payload;

    const tableInDb = database.collection(table);
    const tableExists = await tableInDb.exists();

    if (tableExists === true) {
      await updateTableHash(table.split('_')[0], table.split('_')[1], record);
      await tableInDb.remove(record);
    }

    callback();
  } catch (error) {
    console.log('dremove:', error);
    callback(null);
  }
};

ipc.onReceiveMessage((message) => {
  const {
    action,
    payload,
    // from,
  } = message;

  if (action === 'init') {
    init(payload, (res) => {
      console.log('successfully initialized'); // eslint-disable-line no-console
      ipc.reply(message, res);
    });
  } else if (action === 'stop') {
    stop((res) => {
      console.log('successfully saved'); // eslint-disable-line no-console
      ipc.reply(message, res);
    });
  } else if (action === PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK) {
    generateGenesisBlock(payload, () => {
      ipc.reply(message);
    });
  } else if (action === PLUGIN_ACTIONS.SAVE) {
    actions.save((res) => {
      console.log('successfully saved'); // eslint-disable-line no-console
      ipc.reply(message, res);
    });
  } else if (action && typeof actions[action] === 'function') {
    if (!saving) {
      actions[action](payload, (res) => {
        // console.log('action', action, 'res', res, 'payload', payload);
        ipc.reply(message, res);
      });
    } else {
      ipc.reply(message);
    }
  } else {
    ipc.reply(message);
  }
});

module.exports.PLUGIN_PATH = PLUGIN_PATH;
module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLUGIN_ACTIONS = PLUGIN_ACTIONS;
