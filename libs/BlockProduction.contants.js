const CONTRACT_NAME = 'blockProduction';
const TOKENS_CONTRACT_NAME = 'tokens';

const STAKE_ACTION = 'stake'; // action to stake UTILITY_TOKEN_SYMBOL in order to vote and run validator tools
const UNSTAKE_ACTION = 'unstake'; // action to unstake UTILITY_TOKEN_SYMBOL afer the STAKE_WITHDRAWAL_COOLDOWN period
const REGISTER_NODE_ACTION = 'registerNode'; // action to register a block production node

const UTILITY_TOKEN_SYMBOL = 'SSC';
const UTILITY_TOKEN_PRECISION = 4;
const UTILITY_TOKEN_INITIAL_SUPPLY = 350000000;

const CONSTANTS = {
  CONTRACT_NAME,
  TOKENS_CONTRACT_NAME,
  NB_BLOCK_PRODUCERS: 8, // number of block producers that can be rewarded
  NB_VOTES_ALLOWED: 12, // number of votes that an account can cast for a producer
  STAKE_ACTION,
  UNSTAKE_ACTION,
  REGISTER_NODE_ACTION,

  AUTHORIZED_ACTIONS: [STAKE_ACTION, UNSTAKE_ACTION, REGISTER_NODE_ACTION],

  // 1200: number of Steem blocks per hour, meaning to unstake you will have to wait one week
  STAKE_WITHDRAWAL_COOLDOWN: 1200 * 24 * 7,

  // table names used by the library
  BP_PRODUCERS_TABLE: 'producers',
  BP_STAKES_TABLE: 'stakes',
  BP_VOTES_TABLE: 'votes',
  TOKENS_TABLE: 'tokens',
  BALANCES_TABLE: 'balances',

  // utility token definition
  UTILITY_TOKEN_SYMBOL,
  UTILITY_TOKEN_PRECISION,
  UTILITY_TOKEN_INITIAL_SUPPLY,

  UTILITY_TOKEN: {
    issuer: 'null', // by setting the issuer to 'null', nobody can issue UTILITY_TOKEN (except for the tool itself)
    symbol: UTILITY_TOKEN_SYMBOL,
    precision: UTILITY_TOKEN_PRECISION,
    maxSupply: Number.MAX_SAFE_INTEGER,
    supply: UTILITY_TOKEN_INITIAL_SUPPLY,
  },

  // initial balances definition, UTILITY_TOKEN_SYMBOL will be minted and issued to these accounts
  INITIAL_BALANCES: [
    {
      account: 'steemsc',
      symbol: UTILITY_TOKEN_SYMBOL,
      balance: UTILITY_TOKEN_INITIAL_SUPPLY,
    },
  ],
};

module.exports.CONSTANTS = CONSTANTS;
