class DBUtils {
  /**
   * Add a table to the database
   * @param {Object} state state of the blockchain
   * @param {String} contractName name of the contract
   * @param {String} tableName name of the table
   * @param {Array} indexes array of string containing the name of the indexes to create
   * @returns {Object} returns the contract info if it exists, null otherwise
   */
  static createTable(state, contractName, tableName, indexes = []) {
    const RegexLetters = /^[a-zA-Z_]+$/;

    // check that the params are correct
    if (!RegexLetters.test(tableName) || !Array.isArray(indexes)) return null;

    // each element of the indexes array have to be a string if defined
    if (indexes.length > 0 && !indexes.every(el => typeof el === 'string')) return null;

    const finalTableName = `${contractName}_${tableName}`;

    // get the table from the database
    const table = state.database.getCollection(finalTableName);
    if (table) return table;

    // if it doesn't exist, create it (with the binary indexes)

    return state.database.addCollection(finalTableName, { indices: indexes });
  }

  /**
   * Get the information of a contract (owner, source code, etc...)
   * @param {Object} state state of the blockchain
   * @param {String} contract name of the contract
   * @returns {Object} returns the contract info if it exists, null otherwise
   */
  static getContract(state, contract) {
    if (contract && typeof contract === 'string') {
      const contracts = state.database.getCollection('contracts');
      const contractInDb = contracts.findOne({ name: contract });

      if (contractInDb) {
        return contractInDb;
      }
    }

    return null;
  }

  /**
   * retrieve records from the table of a contract
   * @param {Object} state state of the blockchain
   * @param {String} contract contract name
   * @param {String} table table name
   * @param {JSON} query query to perform on the table
   * @param {Integer} limit limit the number of records to retrieve
   * @param {Integer} offset offset applied to the records set
   * @param {String} index name of the index to use for the query
   * @param {Boolean} descending the records set is sorted ascending if false, descending if true
   * @returns {Array<Object>} returns an array of objects if records found, an empty array otherwise
   */
  static findInTable(state, contract, table, query, limit = 1000, offset = 0, index = '', descending = false) {
    if (contract && typeof contract === 'string'
        && table && typeof table === 'string'
        && query && typeof query === 'object'
        && typeof index === 'string'
        && typeof descending === 'boolean'
        && Number.isInteger(limit)
        && Number.isInteger(offset)
        && limit > 0 && limit <= 1000
        && offset >= 0) {
      const contractInDb = DBUtils.getContract(state, contract);

      if (contractInDb) {
        const finalTableName = `${contract}_${table}`;
        if (contractInDb.tables.includes(finalTableName)) {
          const tableData = state.database.getCollection(finalTableName);

          // if there is an index passed, check if it exists
          if (index !== '' && tableData.binaryIndices[index] !== undefined) {
            return tableData.chain()
              .find(query)
              .simplesort(index, descending)
              .offset(offset)
              .limit(limit)
              .data();
          }

          return tableData.chain()
            .find(query)
            .offset(offset)
            .limit(limit)
            .data();
        }
      }
    }

    return null;
  }

  /**
   * retrieve a record from the table of a contract
   * @param {Object} state state of the blockchain
   * @param {String} contract contract name
   * @param {String} table table name
   * @param {JSON} query query to perform on the table
   * @returns {Object} returns a record if it exists, null otherwise
   */
  static findOneInTable(state, contract, table, query) {
    if (contract && typeof contract === 'string'
        && table && typeof table === 'string'
        && query && typeof query === 'object') {
      const contractInDb = DBUtils.getContract(state, contract);

      if (contractInDb) {
        const finalTableName = `${contract}_${table}`;
        if (contractInDb.tables.includes(finalTableName)) {
          const tableData = state.database.getCollection(finalTableName);
          return tableData.findOne(query);
        }
      }
    }

    return null;
  }
}

module.exports.DBUtils = DBUtils;
