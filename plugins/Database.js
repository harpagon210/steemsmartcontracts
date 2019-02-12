const fs = require('fs-extra');
const Loki = require('lokijs');
const validator = require('validator');
const lfsa = require('../libs/loki-fs-structured-adapter');
const { IPC } = require('../libs/IPC');
const { BlockProduction } = require('../libs/BlockProduction');

const BC_PLUGIN_NAME = require('./Blockchain.constants').PLUGIN_NAME;
const BC_PLUGIN_ACTIONS = require('./Blockchain.constants').PLUGIN_ACTIONS;

const { PLUGIN_NAME, PLUGIN_ACTIONS } = require('./Database.constants');

const PLUGIN_PATH = require.resolve(__filename);

const actions = {};

const ipc = new IPC(PLUGIN_NAME);

let database = null;
let chain = null;
let saving = false;

// load the database from the filesystem
async function init(conf, callback) {
  const {
    autosaveInterval,
    databaseFileName,
    dataDirectory,
  } = conf;

  const databaseFilePath = dataDirectory + databaseFileName;

  // init the database
  database = new Loki(databaseFilePath, {
    adapter: new lfsa(), // eslint-disable-line new-cap
    autosave: autosaveInterval > 0,
    autosaveInterval,
  });

  // check if the app has already be run
  if (fs.pathExistsSync(databaseFilePath)) {
    // load the database from the filesystem to the RAM
    database.loadDatabase({}, (errorDb) => {
      if (errorDb) {
        callback(errorDb);
      }

      // if the chain or the contracts collection doesn't exist we return an error
      chain = database.getCollection('chain');
      const contracts = database.getCollection('contracts');
      if (chain === null || contracts === null) {
        callback('The database is missing either the chain or the contracts table');
      }

      callback(null);
    });
  } else {
    // create the data directory if necessary and empty it if files exists
    fs.emptyDirSync(dataDirectory);

    // init the main tables
    chain = database.addCollection('chain', { indices: ['blockNumber'], disableMeta: true });
    database.addCollection('transactions', { indices: ['txid'], disableMeta: true });
    database.addCollection('contracts', { indices: ['name'], disableMeta: true });

    callback(null);
  }
}

async function generateGenesisBlock(conf, callback) {
  const {
    chainId,
    genesisSteemBlock,
  } = conf;

  // check if genesis block hasn't been generated already
  const genBlock = actions.getBlockInfo(0);

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
    chain.insert(res.payload);

    // initialize the block production tools
    BlockProduction.initialize(database, genesisSteemBlock);
  }

  callback();
}

// save the blockchain as well as the database on the filesystem
actions.save = (callback) => {
  saving = true;

  // save the database from the RAM to the filesystem
  database.saveDatabase((err) => {
    saving = false;
    if (err) {
      callback(err);
    }

    callback(null);
  });
};

// save the blockchain as well as the database on the filesystem
function stop(callback) {
  actions.save(callback);
}

function addTransactions(block) {
  const transactionsTable = database.getCollection('transactions');
  const { transactions } = block;
  const nbTransactions = transactions.length;

  for (let index = 0; index < nbTransactions; index += 1) {
    const transaction = transactions[index];
    const transactionToSave = {
      txid: transaction.transactionId,
      blockNumber: block.blockNumber,
      index,
    };

    transactionsTable.insert(transactionToSave);
  }
}

actions.getTransactionInfo = (txid) => { // eslint-disable-line no-unused-vars
  const transactionsTable = database.getCollection('transactions');

  const transaction = transactionsTable.findOne({ txid });

  if (transaction) {
    const { index, blockNumber } = transaction;
    const block = actions.getBlockInfo(blockNumber);

    if (block) {
      return Object.assign({}, { blockNumber }, block.transactions[index]);
    }
  }

  return null;
};


actions.addBlock = (block) => { // eslint-disable-line no-unused-vars
  chain.insert(block);
  addTransactions(block);
};

actions.getLatestBlockInfo = () => { // eslint-disable-line no-unused-vars
  const { maxId } = chain;
  return chain.get(maxId);
};

actions.getBlockInfo = blockNumber => chain.findOne({ blockNumber });

/**
 * Get the information of a contract (owner, source code, etc...)
 * @param {String} contract name of the contract
 * @returns {Object} returns the contract info if it exists, null otherwise
 */
actions.findContract = (payload) => {
  const { name } = payload;
  if (name && typeof name === 'string') {
    const contracts = database.getCollection('contracts');
    const contractInDb = contracts.findOne({ name });

    if (contractInDb) {
      return contractInDb;
    }
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
actions.addContract = (payload) => { // eslint-disable-line no-unused-vars
  const {
    name,
    owner,
    code,
    tables,
  } = payload;

  if (name && typeof name === 'string'
    && owner && typeof owner === 'string'
    && code && typeof code === 'string'
    && tables && Array.isArray(tables)) {
    const contracts = database.getCollection('contracts');
    contracts.insert(payload);
  }
};

/**
 * Add a table to the database
 * @param {String} contractName name of the contract
 * @param {String} tableName name of the table
 * @param {Array} indexes array of string containing the name of the indexes to create
 */
actions.createTable = (payload) => { // eslint-disable-line no-unused-vars
  const { contractName, tableName, indexes } = payload;

  // check that the params are correct
  // each element of the indexes array have to be a string if defined
  if (validator.isAlphanumeric(tableName)
    && Array.isArray(indexes)
    && (indexes.length === 0
    || (indexes.length > 0 && indexes.every(el => typeof el === 'string' && validator.isAlphanumeric(el))))) {
    const finalTableName = `${contractName}_${tableName}`;
    // get the table from the database
    const table = database.getCollection(finalTableName);
    if (table === null) {
      // if it doesn't exist, create it (with the binary indexes)
      database.addCollection(finalTableName, { indices: indexes, disableMeta: true });
      return true;
    }
  }

  return false;
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
actions.find = (payload) => { // eslint-disable-line no-unused-vars
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

    if (contract && typeof contract === 'string'
      && table && typeof table === 'string'
      && query && typeof query === 'object'
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
      const tableData = database.getCollection(finalTableName);

      if (tableData) {
        // if there is an index passed, check if it exists
        if (ind.length > 0 && ind.every(el => tableData.binaryIndices[el.index] !== undefined || el.index === '$loki')) {
          return tableData.chain()
            .find(query)
            .compoundsort(ind.map(el => [el.index, el.descending]))
            .offset(off)
            .limit(lim)
            .data();
        }

        return tableData.chain()
          .find(query)
          .offset(off)
          .limit(lim)
          .data();
      }
    }

    return null;
  } catch (error) {
    return null;
  }
};

/**
 * retrieve a record from the table of a contract
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {JSON} query query to perform on the table
 * @returns {Object} returns a record if it exists, null otherwise
 */
actions.findOne = (payload) => { // eslint-disable-line no-unused-vars
  try {
    const { contract, table, query } = payload;

    if (contract && typeof contract === 'string'
      && table && typeof table === 'string'
      && query && typeof query === 'object') {
      const finalTableName = `${contract}_${table}`;

      const tableData = database.getCollection(finalTableName);
      return tableData ? tableData.findOne(query) : null;
    }

    return null;
  } catch (error) {
    return null;
  }
};

/**
 * insert a record in the table of a contract
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {String} record record to save in the table
 */
actions.insert = (payload) => { // eslint-disable-line no-unused-vars
  const { contract, table, record } = payload;
  const finalTableName = `${contract}_${table}`;

  const contractInDb = actions.findContract({ name: contract });
  if (contractInDb && contractInDb.tables.includes(finalTableName)) {
    const tableInDb = database.getCollection(finalTableName);
    if (tableInDb) {
      return tableInDb.insert(record);
    }
  }
  return null;
};

/**
 * remove a record in the table of a contract
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {String} record record to remove from the table
 */
actions.remove = (payload) => { // eslint-disable-line no-unused-vars
  const { contract, table, record } = payload;
  const finalTableName = `${contract}_${table}`;

  const contractInDb = actions.findContract({ name: contract });
  if (contractInDb && contractInDb.tables.includes(finalTableName)) {
    const tableInDb = database.getCollection(finalTableName);
    if (tableInDb) {
      tableInDb.remove(record);
    }
  }
};

/**
 * update a record in the table of a contract
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {String} record record to update in the table
 */
actions.update = (payload) => { // eslint-disable-line no-unused-vars
  const { contract, table, record } = payload;
  const finalTableName = `${contract}_${table}`;

  const contractInDb = actions.findContract({ name: contract });
  if (contractInDb && contractInDb.tables.includes(finalTableName)) {
    const tableInDb = database.getCollection(finalTableName);
    if (tableInDb) {
      tableInDb.update(record);
    }
  }
};

/**
 * get the details of a smart contract table
 * @param {String} contract contract name
 * @param {String} table table name
 * @param {String} record record to update in the table
 * @returns {Object} returns the table details if it exists, null otherwise
 */
actions.getTableDetails = (payload) => { // eslint-disable-line no-unused-vars
  const { contract, table } = payload;
  const finalTableName = `${contract}_${table}`;
  const contractInDb = actions.findContract({ name: contract });
  if (contractInDb && contractInDb.tables.includes(finalTableName)) {
    const tableInDb = database.getCollection(finalTableName);
    if (tableInDb) {
      return { ...tableInDb, data: [] };
    }
  }

  return null;
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
actions.dfind = (payload) => { // eslint-disable-line no-unused-vars
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

  const tableData = database.getCollection(table);

  if (tableData) {
    // if there is an index passed, check if it exists
    if (ind.length > 0) {
      return tableData.chain()
        .find(query)
        .compoundsort(ind.map(el => [el.index, el.descending]))
        .offset(off)
        .limit(lim)
        .data();
    }

    return tableData.chain()
      .find(query)
      .offset(off)
      .limit(lim)
      .data();
  }

  return [];
};

/**
 * retrieve a record from the table
 * @param {String} table table name
 * @param {JSON} query query to perform on the table
 * @returns {Object} returns a record if it exists, null otherwise
 */
actions.dfindOne = (payload) => { // eslint-disable-line no-unused-vars
  const { table, query } = payload;

  const tableData = database.getCollection(table);
  if (tableData) {
    return tableData.findOne(query);
  }

  return null;
};

/**
 * insert a record
 * @param {String} table table name
 * @param {String} record record to save in the table
 */
actions.dinsert = (payload) => { // eslint-disable-line no-unused-vars
  const { table, record } = payload;
  const tableInDb = database.getCollection(table);
  return tableInDb.insert(record);
};

/**
 * update a record in the table
 * @param {String} table table name
 * @param {String} record record to update in the table
 */
actions.dupdate = (payload) => { // eslint-disable-line no-unused-vars
  const { table, record } = payload;

  const tableInDb = database.getCollection(table);
  tableInDb.update(record);
};

/**
 * remove a record
 * @param {String} table table name
 * @param {String} record record to remove from the table
 */
actions.dremove = (payload) => { // eslint-disable-line no-unused-vars
  const { table, record } = payload;

  const tableInDb = database.getCollection(table);
  tableInDb.remove(record);
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
      const res = actions[action](payload);
      // console.log('action', action, 'res', res, 'payload', payload);
      ipc.reply(message, res);
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
