/* eslint-disable no-await-in-loop */
/* eslint-disable max-len */
/* global actions, api */

const CONTRACT_NAME = 'nftmarket';

// eslint-disable-next-line no-template-curly-in-string
const UTILITY_TOKEN_SYMBOL = "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'";

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('sellBook');

  if (tableExists === false) {
    await api.db.createTable('sellBook', ['symbol', 'account', 'priceDec', 'expiration', 'txId']);
    await api.db.createTable('tradesHistory', ['symbol']);
    await api.db.createTable('metrics', ['symbol']);
  }
};
