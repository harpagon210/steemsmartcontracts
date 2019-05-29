const CONSTANTS = {
  // utility token definition
  UTILITY_TOKEN_SYMBOL: 'ENG', // mainnet
  // UTILITY_TOKEN_SYMBOL: 'SSC', // testnet
  UTILITY_TOKEN_PRECISION: 8,

  // pegged token definition
  STEEM_PEGGED_SYMBOL: 'STEEMP',
  STEEM_PEGGED_ACCOUNT: 'steem-peg', // mainnet
  // STEEM_PEGGED_ACCOUNT: 'steemsc', // testnet

  // default values
  ACCOUNT_RECEIVING_FEES: 'steemsc',
  INITIAL_TOKEN_CREATION_FEE: '100', // mainnet
  // INITIAL_TOKEN_CREATION_FEE: '0', // testnet
  SSC_STORE_PRICE: '0.001',
  SSC_STORE_QTY: '0.001', // mainnet
  // SSC_STORE_QTY: '1', // testnet

  // forks definitions
  FORK_BLOCK_NUMBER: 30896500,
  FORK_BLOCK_NUMBER_TWO: 30983000,
  FORK_BLOCK_NUMBER_THREE: 31992326,
};

module.exports.CONSTANTS = CONSTANTS;
