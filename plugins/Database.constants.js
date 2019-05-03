const PLUGIN_NAME = 'Database';

const PLUGIN_ACTIONS = {
  ADD_BLOCK: 'addBlock',
  GET_LATEST_BLOCK_INFO: 'getLatestBlockInfo',
  GET_BLOCK_INFO: 'getBlockInfo',
  GET_TRANSACTION_INFO: 'getTransactionInfo',
  FIND_CONTRACT: 'findContract',
  ADD_CONTRACT: 'addContract',
  UPDATE_CONTRACT: 'updateContract',
  CREATE_TABLE: 'createTable',
  FIND: 'find',
  FIND_ONE: 'findOne',
  INSERT: 'insert',
  REMOVE: 'remove',
  UPDATE: 'update',
  DFIND: 'dfind',
  DFIND_ONE: 'dfindOne',
  DINSERT: 'dinsert',
  DREMOVE: 'dremove',
  DUPDATE: 'dupdate',
  GET_TABLE_DETAILS: 'getTableDetails',
  SAVE: 'save',
  GENERATE_GENESIS_BLOCK: 'generateGenesisBlock',
  INIT_DATABASE_HASH: 'initDatabaseHash',
  GET_DATABASE_HASH: 'getDatabaseHash',
};

module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLUGIN_ACTIONS = PLUGIN_ACTIONS;
