/* eslint-disable max-len */
/* eslint-disable no-await-in-loop */
const SHA256 = require('crypto-js/sha256');
const enchex = require('crypto-js/enc-hex');
const validator = require('validator');
const { MongoClient } = require('mongodb');
const { EJSON } = require('bson');

class Database {
  constructor() {
    this.database = null;
    this.chain = null;
    this.databaseHash = '';
    this.client = null;
  }

  async initSequence(name, startID = 1) {
    const sequences = this.database.collection('sequences');

    await sequences.insertOne({ _id: name, seq: startID });
  }

  async getNextSequence(name) {
    const sequences = this.database.collection('sequences');

    const sequence = await sequences.findOneAndUpdate(
      { _id: name }, { $inc: { seq: 1 } }, { new: true },
    );

    return sequence.value.seq;
  }

  async getLastSequence(name) {
    const sequences = this.database.collection('sequences');

    const sequence = await sequences.findOne({ _id: name });

    return sequence.seq;
  }

  getCollection(name) {
    return new Promise((resolve) => {
      this.database.collection(name, { strict: true }, (err, collection) => {
        // collection does not exist
        if (err) {
          resolve(null);
        }
        resolve(collection);
      });
    });
  }

  async init(databaseURL, databaseName) {
    // init the database
    this.client = await MongoClient.connect(databaseURL, { useNewUrlParser: true });
    this.database = await this.client.db(databaseName);
    // await database.dropDatabase();
    // return
    // get the chain collection and init the chain if not done yet

    const coll = await this.getCollection('chain');

    if (coll === null) {
      await this.initSequence('chain', 0);
      this.chain = await this.database.createCollection('chain');

      await this.database.createCollection('transactions');
      await this.database.createCollection('contracts');
    } else {
      this.chain = coll;
    }
  }

  close() {
    this.client.close();
  }

  async insertGenesisBlock(genesisBlock) {
    // eslint-disable-next-line
    genesisBlock._id = await this.getNextSequence('chain');

    await this.chain.insertOne(genesisBlock);
  }

  async addTransactions(block) {
    const transactionsTable = this.database.collection('transactions');
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
  }

  async updateTableHash(contract, table) {
    const contracts = this.database.collection('contracts');
    const contractInDb = await contracts.findOne({ _id: contract });

    if (contractInDb && contractInDb.tables[table] !== undefined) {
      const tableHash = contractInDb.tables[table].hash;

      contractInDb.tables[table].hash = SHA256(tableHash).toString(enchex);

      await contracts.updateOne({ _id: contract }, { $set: contractInDb });

      this.databaseHash = SHA256(this.databaseHash + contractInDb.tables[table].hash)
        .toString(enchex);
    }
  }

  initDatabaseHash(previousDatabaseHash) {
    this.databaseHash = previousDatabaseHash;
  }

  getDatabaseHash() {
    return this.databaseHash;
  }

  async getTransactionInfo(txid) {
    const transactionsTable = this.database.collection('transactions');

    const transaction = await transactionsTable.findOne({ _id: txid });

    let result = null;

    if (transaction) {
      const { index, blockNumber } = transaction;
      const block = await this.getBlockInfo(blockNumber);

      if (block) {
        result = Object.assign({}, { blockNumber }, block.transactions[index]);
      }
    }

    return result;
  }

  async addBlock(block) {
    const finalBlock = block;
    finalBlock._id = await this.getNextSequence('chain'); // eslint-disable-line no-underscore-dangle
    await this.chain.insertOne(finalBlock);
    await this.addTransactions(finalBlock);
  }

  async getLatestBlockInfo() {
    try {
      const _idNewBlock = await this.getLastSequence('chain'); // eslint-disable-line no-underscore-dangle

      const lastestBlock = await this.chain.findOne({ _id: _idNewBlock - 1 });

      return lastestBlock;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
      return null;
    }
  }

  async getLatestBlockMetadata() {
    try {
      const _idNewBlock = await this.getLastSequence('chain'); // eslint-disable-line no-underscore-dangle

      const lastestBlock = await this.chain.findOne({ _id: _idNewBlock - 1 });

      if (lastestBlock) {
        lastestBlock.transactions = [];
        lastestBlock.virtualTransactions = [];
      }

      return lastestBlock;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
      return null;
    }
  }

  async getBlockInfo(blockNumber) {
    try {
      const block = typeof blockNumber === 'number' && Number.isInteger(blockNumber)
        ? await this.chain.findOne({ _id: blockNumber })
        : null;

      return block;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
      return null;
    }
  }

  /**
   * Mark a block as verified by a witness
   * @param {Integer} blockNumber block umber to mark verified
   * @param {String} witness name of the witness that verified the block
   */
  async verifyBlock(payload) {
    try {
      const {
        blockNumber,
        witness,
        roundSignature,
        signingKey,
        round,
        roundHash,
      } = payload;
      const block = await this.chain.findOne({ _id: blockNumber });

      if (block) {
        block.witness = witness;
        block.round = round;
        block.roundHash = roundHash;
        block.signingKey = signingKey;
        block.roundSignature = roundSignature;

        await this.chain.updateOne(
          { _id: block._id }, // eslint-disable-line no-underscore-dangle
          { $set: block },
        );
      } else {
        // eslint-disable-next-line no-console
        console.error('verifyBlock', blockNumber, 'does not exist');
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
    }
  }

  /**
   * Get the information of a contract (owner, source code, etc...)
   * @param {String} contract name of the contract
   * @returns {Object} returns the contract info if it exists, null otherwise
   */
  async findContract(payload) {
    try {
      const { name } = payload;
      if (name && typeof name === 'string') {
        const contracts = this.database.collection('contracts');

        const contractInDb = await contracts.findOne({ _id: name });

        if (contractInDb) {
          return contractInDb;
        }
      }

      return null;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error);
      return null;
    }
  }

  /**
   * add a smart contract to the database
   * @param {String} _id _id of the contract
   * @param {String} owner owner of the contract
   * @param {String} code code of the contract
   * @param {String} tables tables linked to the contract
   */
  async addContract(payload) {
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
      const contracts = this.database.collection('contracts');
      await contracts.insertOne(payload);
    }
  }

  /**
   * update a smart contract in the database
   * @param {String} _id _id of the contract
   * @param {String} owner owner of the contract
   * @param {String} code code of the contract
   * @param {String} tables tables linked to the contract
   */

  async updateContract(payload) {
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
      const contracts = this.database.collection('contracts');

      const contract = await contracts.findOne({ _id, owner });
      if (contract !== null) {
        await contracts.updateOne({ _id }, { $set: payload });
      }
    }
  }

  /**
   * Add a table to the database
   * @param {String} contractName name of the contract
   * @param {String} tableName name of the table
   * @param {Array} indexes array of string containing the name of the indexes to create
   */
  async createTable(payload) {
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
      let table = await this.getCollection(finalTableName);
      if (table === null) {
        // if it doesn't exist, create it (with the binary indexes)
        await this.initSequence(finalTableName);
        await this.database.createCollection(finalTableName);
        table = this.database.collection(finalTableName);

        if (indexes.length > 0) {
          const nbIndexes = indexes.length;

          for (let i = 0; i < nbIndexes; i += 1) {
            const index = indexes[i];
            const finalIndex = {};
            finalIndex[index] = 1;

            await table.createIndex(finalIndex);
          }
        }

        result = true;
      }
    }

    return result;
  }

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
  async find(payload) {
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
        const tableData = await this.getCollection(finalTableName);

        if (tableData) {
          // if there is an index passed, check if it exists
          if (ind.length > 0) {
            const tableIndexes = await tableData.indexInformation();

            if (ind.every(el => tableIndexes[`${el.index}_1`] !== undefined || el.index === '$loki' || el.index === '_id')) {
              result = await tableData.find(EJSON.deserialize(query), {
                limit: lim,
                skip: off,
                sort: ind.map(el => [el.index === '$loki' ? '_id' : el.index, el.descending === true ? 'desc' : 'asc']),
              }).toArray();

              result = EJSON.serialize(result);
            }
          } else {
            result = await tableData.find(EJSON.deserialize(query), {
              limit: lim,
              skip: off,
            }).toArray();
            result = EJSON.serialize(result);
          }
        }
      }

      return result;
    } catch (error) {
      return null;
    }
  }

  /**
   * retrieve a record from the table of a contract
   * @param {String} contract contract name
   * @param {String} table table name
   * @param {JSON} query query to perform on the table
   * @returns {Object} returns a record if it exists, null otherwise
   */
  async findOne(payload) { // eslint-disable-line no-unused-vars
    try {
      const { contract, table, query } = payload;
      let result = null;
      if (contract && typeof contract === 'string'
        && table && typeof table === 'string'
        && query && typeof query === 'object'
        && JSON.stringify(query).indexOf('$regex') === -1) {
        if (query.$loki) {
          query._id = query.$loki; // eslint-disable-line no-underscore-dangle
          delete query.$loki;
        }
        const finalTableName = `${contract}_${table}`;

        const tableData = await this.getCollection(finalTableName);
        if (tableData) {
          result = await tableData.findOne(EJSON.deserialize(query));
          result = EJSON.serialize(result);
        }
      }

      return result;
    } catch (error) {
      return null;
    }
  }

  /**
   * insert a record in the table of a contract
   * @param {String} contract contract name
   * @param {String} table table name
   * @param {String} record record to save in the table
   */
  async insert(payload) { // eslint-disable-line no-unused-vars
    const { contract, table, record } = payload;
    const finalTableName = `${contract}_${table}`;
    let finalRecord = null;

    const contractInDb = await this.findContract({ name: contract });
    if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
      const tableInDb = await this.getCollection(finalTableName);
      if (tableInDb) {
        finalRecord = EJSON.deserialize(record);
        finalRecord._id = await this.getNextSequence(finalTableName); // eslint-disable-line
        await tableInDb.insertOne(finalRecord);
        await this.updateTableHash(contract, finalTableName);
      }
    }

    return finalRecord;
  }

  /**
   * remove a record in the table of a contract
   * @param {String} contract contract name
   * @param {String} table table name
   * @param {String} record record to remove from the table
   */
  async remove(payload) { // eslint-disable-line no-unused-vars
    const { contract, table, record } = payload;
    const finalTableName = `${contract}_${table}`;

    const contractInDb = await this.findContract({ name: contract });
    if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
      const tableInDb = await this.getCollection(finalTableName);
      if (tableInDb) {
        await this.updateTableHash(contract, finalTableName);
        await tableInDb.deleteOne({ _id: record._id }); // eslint-disable-line no-underscore-dangle
      }
    }
  }

  /**
   * update a record in the table of a contract
   * @param {String} contract contract name
   * @param {String} table table name
   * @param {String} record record to update in the table
   * @param {String} unsets record fields to be removed (optional)
   */
  async update(payload) {
    const {
      contract, table, record, unsets,
    } = payload;
    const finalTableName = `${contract}_${table}`;

    const contractInDb = await this.findContract({ name: contract });
    if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
      const tableInDb = await this.getCollection(finalTableName);
      if (tableInDb) {
        await this.updateTableHash(contract, finalTableName);

        if (unsets) {
          await tableInDb.updateOne({ _id: record._id }, { $set: EJSON.deserialize(record), $unset: EJSON.deserialize(unsets) }); // eslint-disable-line
        } else {
          await tableInDb.updateOne({ _id: record._id }, { $set: EJSON.deserialize(record) }); // eslint-disable-line
        }
      }
    }
  }

  /**
   * get the details of a smart contract table
   * @param {String} contract contract name
   * @param {String} table table name
   * @param {String} record record to update in the table
   * @returns {Object} returns the table details if it exists, null otherwise
   */
  async getTableDetails(payload) {
    const { contract, table } = payload;
    const finalTableName = `${contract}_${table}`;
    const contractInDb = await this.findContract({ name: contract });
    let tableDetails = null;
    if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
      const tableInDb = await this.getCollection(finalTableName);
      if (tableInDb) {
        tableDetails = Object.assign({}, contractInDb.tables[finalTableName]);
        tableDetails.indexes = await tableInDb.indexInformation();
      }
    }

    return tableDetails;
  }

  /**
   * check if a table exists
   * @param {String} contract contract name
   * @param {String} table table name
   * @returns {Object} returns true if the table exists, false otherwise
   */
  async tableExists(payload) {
    const { contract, table } = payload;
    const finalTableName = `${contract}_${table}`;
    let result = false;
    const contractInDb = await this.findContract({ name: contract });
    if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
      const tableInDb = await this.getCollection(finalTableName);
      if (tableInDb) {
        result = true;
      }
    }

    return result;
  }

  /**
   * retrieve records from the table
   * @param {String} table table name
   * @param {JSON} query query to perform on the table
   * @param {Integer} limit limit the number of records to retrieve
   * @param {Integer} offset offset applied to the records set
   * @param {Array<Object>} indexes array of index definitions { index: string, descending: boolean }
   * @returns {Array<Object>} returns an array of objects if records found, an empty array otherwise
   */
  async dfind(payload, callback) { // eslint-disable-line no-unused-vars
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

    const tableInDb = await this.getCollection(table);
    let records = [];

    if (tableInDb) {
      if (ind.length > 0) {
        records = await tableInDb.find(EJSON.deserialize(query), {
          limit: lim,
          skip: off,
          sort: ind.map(el => [el.index === '$loki' ? '_id' : el.index, el.descending === true ? 'desc' : 'asc']),
        });
        records = EJSON.serialize(records);
      } else {
        records = await tableInDb.find(EJSON.deserialize(query), {
          limit: lim,
          skip: off,
        });
        records = EJSON.serialize(records);
      }
    }

    return records;
  }

  /**
   * retrieve a record from the table
   * @param {String} table table name
   * @param {JSON} query query to perform on the table
   * @returns {Object} returns a record if it exists, null otherwise
   */
  async dfindOne(payload) {
    const { table, query } = payload;

    const tableInDb = await this.getCollection(table);
    let record = null;

    if (query.$loki) {
      query._id = query.$loki; // eslint-disable-line no-underscore-dangle
      delete query.$loki;
    }

    if (tableInDb) {
      record = await tableInDb.findOne(EJSON.deserialize(query));
      record = EJSON.serialize(record);
    }

    return record;
  }

  /**
   * insert a record
   * @param {String} table table name
   * @param {String} record record to save in the table
   */
  async dinsert(payload) {
    const { table, record } = payload;
    const tableInDb = this.database.collection(table);
    const finalRecord = record;
    finalRecord._id = await this.getNextSequence(table); // eslint-disable-line
    await tableInDb.insertOne(EJSON.deserialize(finalRecord));
    await this.updateTableHash(table.split('_')[0], table.split('_')[1]);

    return finalRecord;
  }

  /**
   * update a record in the table
   * @param {String} table table name
   * @param {String} record record to update in the table
   */
  async dupdate(payload) {
    const { table, record } = payload;

    const tableInDb = this.database.collection(table);
    await this.updateTableHash(table.split('_')[0], table.split('_')[1]);
    await tableInDb.updateOne(
      { _id: record._id }, // eslint-disable-line no-underscore-dangle
      { $set: EJSON.deserialize(record) },
    );
  }

  /**
   * remove a record
   * @param {String} table table name
   * @param {String} record record to remove from the table
   */
  async dremove(payload) { // eslint-disable-line no-unused-vars
    const { table, record } = payload;

    const tableInDb = this.database.collection(table);
    await this.updateTableHash(table.split('_')[0], table.split('_')[1]);
    await tableInDb.deleteOne({ _id: record._id }); // eslint-disable-line no-underscore-dangle
  }
}

module.exports.Database = Database;
