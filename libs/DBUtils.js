class DBUtils {
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

  static findInTable(state, contract, table, query) {
    if (contract && typeof contract === 'string'
        && table && typeof table === 'string'
        && query && typeof query === 'object') {
      const contractInDb = DBUtils.getContract(state, contract);

      if (contractInDb) {
        const finalTableName = `${contract}_${table}`;
        if (contractInDb.tables.includes(finalTableName)) {
          const tableData = state.database.getCollection(finalTableName);
          return tableData.find(query);
        }
      }
    }

    return null;
  }

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
