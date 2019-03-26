const fs = require('fs-extra');
// const Loki = require('lokijs');
const { MongoClient } = require('mongodb');
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

const initSequence = async (name, startID = 1) => {
  const sequences = database.collection('sequences');

  await sequences.insertOne({ _id: name, seq: startID });
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
  // init the database
  const client = await MongoClient.connect(databaseURL, { useNewUrlParser: true });
  database = await client.db(databaseName);
  // await database.dropDatabase();
  // return 
  // get the chain collection and init the chain if not done yet

  const coll = await getCollection('chain');

  if (coll === null) {
    await initSequence('chain', 0);
    chain = await database.createCollection('chain');

    await database.createCollection('transactions');
    await database.createCollection('contracts');
  } else {
    chain = coll;
  }

  callback(null);
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
    genBlock._id = await getNextSequence('chain'); // eslint-disable-line no-underscore-dangle

    await chain.insertOne(genBlock);
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
      _id: transaction.transactionId,
      blockNumber: block.blockNumber,
      index,
    };

    await transactionsTable.insertOne(transactionToSave); // eslint-disable-line no-await-in-loop
  }
};

const updateTableHash = async (contract, table, record) => {
  const contracts = database.collection('contracts');
  const contractInDb = await contracts.findOne({ _id: contract });

  if (contractInDb && contractInDb.tables[table] !== undefined) {
    const recordHash = SHA256(JSON.stringify(record)).toString(enchex);
    const tableHash = contractInDb.tables[table].hash;

    contractInDb.tables[table].hash = SHA256(tableHash + recordHash).toString(enchex);

    await contracts.updateOne({ _id: contract }, { $set: contractInDb });

    databaseHash = SHA256(databaseHash + contractInDb.tables[table].hash).toString(enchex);
  }
};

actions.initDatabaseHash = (previousDatabaseHash, callback) => {
  databaseHash = previousDatabaseHash;
  callback();
};

actions.getDatabaseHash = (payload, callback) => {
  callback(databaseHash);
};

actions.getTransactionInfo = async (txid, callback) => { // eslint-disable-line no-unused-vars
  const transactionsTable = database.collection('transactions');

  const transaction = await transactionsTable.findOne({ _id: txid });

  let result = null;

  if (transaction) {
    const { index, blockNumber } = transaction;
    const block = await actions.getBlockInfo(blockNumber);

    if (block) {
      result = Object.assign({}, { blockNumber }, block.transactions[index]);
    }
  }

  callback(result);
};

actions.addBlock = async (block, callback) => { // eslint-disable-line no-unused-vars
  block._id = await getNextSequence('chain'); // eslint-disable-line
  await chain.insertOne(block);
  await addTransactions(block);

  callback();
};

actions.getLatestBlockInfo = async (payload, callback) => { // eslint-disable-line no-unused-vars
  const _idNewBlock = await getLastSequence('chain'); // eslint-disable-line no-underscore-dangle

  const lastestBlock = await chain.findOne({ _id: _idNewBlock - 1 });

  callback(lastestBlock);
};

actions.getBlockInfo = async (blockNumber, callback) => {
  const block = await chain.findOne({ _id: blockNumber });

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
  const { name } = payload;
  if (name && typeof name === 'string') {
    const contracts = database.collection('contracts');

    const contractInDb = await contracts.findOne({ _id: name });

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
};

/**
 * add a smart contract to the database
 * @param {String} name name of the contract
 * @param {String} owner owner of the contract
 * @param {String} code code of the contract
 * @param {String} tables tables linked to the contract
 */
actions.addContract = async (payload, callback) => { // eslint-disable-line no-unused-vars
  const {
    _id,
    owner,
    code,
    tables,
  } = payload;

  if (_id && typeof _id === 'string'
    && owner && typeof owner === 'string'
    && code && typeof code === 'string'
    && tables && typeof tables === 'object') {
    const contracts = database.collection('contracts');
    await contracts.insertOne(payload);
  }

  callback();
};

/**
 * Add a table to the database
 * @param {String} contractName name of the contract
 * @param {String} tableName name of the table
 * @param {Array} indexes array of string containing the name of the indexes to create
 */
actions.createTable = async (payload, callback) => { // eslint-disable-line no-unused-vars
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
    let table = await getCollection(finalTableName);
    if (table === null) {
      // if it doesn't exist, create it (with the binary indexes)
      await initSequence(finalTableName);
      await database.createCollection(finalTableName);
      table = database.collection(finalTableName);

      if (indexes.length > 0) {
        const finalIndexes = {};
        indexes.forEach((index) => {
          finalIndexes[index] = 1;
        });

        await table.createIndex(finalIndexes);
      }

      result = true;
    }
  }

  callback(result);
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
      const tableData = await getCollection(finalTableName);

      if (tableData) {
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

        result = await tableData.find(query, {
          limit: lim,
          skip: off,
          sort: ind.map(el => [el.index, el.descending === true ? 'desc' : 'asc']),
        }).toArray();
      }
    }

    callback(result);
  } catch (error) {
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

      const tableData = await getCollection(finalTableName);
      if (tableData) {
        result = await tableData.findOne(query);
      }
    }

    callback(result);
  } catch (error) {
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
  const { contract, table, record } = payload;
  const finalTableName = `${contract}_${table}`;
  let finalRecord = null;

  const contractInDb = await actions.findContract({ name: contract });
  if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
    const tableInDb = await getCollection(finalTableName);
    if (tableInDb) {
      finalRecord = record;
      finalRecord._id = await getNextSequence(finalTableName); // eslint-disable-line
      await tableInDb.insertOne(finalRecord);
      await updateTableHash(contract, finalTableName, finalRecord);
    }
  }

  callback(finalRecord);
};

/**
 * remove a record in the table of a contract
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {String} record record to remove from the table
 */
actions.remove = async (payload, callback) => { // eslint-disable-line no-unused-vars
  const { contract, table, record } = payload;
  const finalTableName = `${contract}_${table}`;

  const contractInDb = await actions.findContract({ name: contract });
  if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
    const tableInDb = await getCollection(finalTableName);
    if (tableInDb) {
      await (contract, finalTableName, record);
      tableInDb.deleteOne({ _id: record._id }); // eslint-disable-line no-underscore-dangle

      callback();
    }
  }
};

/**
 * update a record in the table of a contract
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {String} record record to update in the table
 */
actions.update = async (payload, callback) => { // eslint-disable-line no-unused-vars
  const { contract, table, record } = payload;
  const finalTableName = `${contract}_${table}`;

  const contractInDb = await actions.findContract({ name: contract });
  if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
    const tableInDb = await getCollection(finalTableName);
    if (tableInDb) {
      await updateTableHash(contract, finalTableName, record);

      tableInDb.updateOne({ _id: record._id }, { $set: record }); // eslint-disable-line
    }
  }

  callback();
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

  const tableInDb = await getCollection(table);
  let records = [];

  if (tableInDb) {
    records = await tableInDb.find(query, {
      limit: lim,
      skip: off,
      sort: ind.map(el => [el.index, el.descending === true ? 'desc' : 'asc']),
    });
  }

  callback(records);
};

/**
 * retrieve a record from the table
 * @param {String} table table name
 * @param {JSON} query query to perform on the table
 * @returns {Object} returns a record if it exists, null otherwise
 */
actions.dfindOne = async (payload, callback) => { // eslint-disable-line no-unused-vars
  const { table, query } = payload;

  const tableInDb = await getCollection(table);
  let record = null;

  if (tableInDb) {
    record = await tableInDb.findOne(query);
  }

  callback(record);
};

/**
 * insert a record
 * @param {String} table table name
 * @param {String} record record to save in the table
 */
actions.dinsert = async (payload, callback) => { // eslint-disable-line no-unused-vars
  const { table, record } = payload;
  const tableInDb = database.collection(table);
  const finalRecord = record;
  finalRecord._id = await getNextSequence(table); // eslint-disable-line
  await tableInDb.insertOne(finalRecord);
  await updateTableHash(table.split('_')[0], table.split('_')[1], record);

  callback(finalRecord);
};

/**
 * update a record in the table
 * @param {String} table table name
 * @param {String} record record to update in the table
 */
actions.dupdate = async (payload, callback) => { // eslint-disable-line no-unused-vars
  const { table, record } = payload;

  const tableInDb = database.collection(table);
  await updateTableHash(table.split('_')[0], table.split('_')[1], record);
  await tableInDb.updateOne(
    { _id: record._id }, { $set: record }, // eslint-disable-line no-underscore-dangle
  );

  callback();
};

/**
 * remove a record
 * @param {String} table table name
 * @param {String} record record to remove from the table
 */
actions.dremove = async (payload, callback) => { // eslint-disable-line no-unused-vars
  const { table, record } = payload;

  const tableInDb = database.collection(table);
  await updateTableHash(table.split('_')[0], table.split('_')[1], record);
  await tableInDb.deleteOne({ _id: record._id }); // eslint-disable-line no-underscore-dangle

  callback();
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
