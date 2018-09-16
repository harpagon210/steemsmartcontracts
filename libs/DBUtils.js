class DBUtils {
  // get the contract info from the database in the state, returns null if doesn't exist
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

  // find records in the contract table by using the query, returns empty array if no records found
  static findInTable(state, contract, table, query, limit = 1000, offset = 0) {
    if (contract && typeof contract === 'string'
        && table && typeof table === 'string'
        && query && typeof query === 'object'
        && Number.isInteger(limit)
        && Number.isInteger(offset)
        && limit > 0 && limit <= 1000
        && offset >= 0) {
      const contractInDb = DBUtils.getContract(state, contract);

      if (contractInDb) {
        const finalTableName = `${contract}_${table}`;
        if (contractInDb.tables.includes(finalTableName)) {
          const tableData = state.database.getCollection(finalTableName);
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

  // find one record in the table of a contract by using the query, returns nullrecord found
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
