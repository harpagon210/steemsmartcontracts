const CONTRACT_NAME = 'blockProduction';
const TOKENS_CONTRACT_NAME = 'tokens';

const STAKE_ACTION = 'stake'; // action to stake UTILITY_TOKEN_SYMBOL in order to vote and run validator tools
const UNSTAKE_ACTION = 'unstake'; // action to unstake UTILITY_TOKEN_SYMBOL afer the STAKE_WITHDRAWAL_COOLDOWN period
const REGISTER_NODE_ACTION = 'registerNode'; // action to register a block production node
const VOTE = 'vote'; // vote for a block producer
const UNVOTE = 'unvote'; // unvote for a block producer

const UTILITY_TOKEN_SYMBOL = 'ROX';
const UTILITY_TOKEN_NAME = 'Rocketx';
const UTILITY_TOKEN_METADA = '{}';
const UTILITY_TOKEN_PRECISION = 8;
const MINIMUM_TOKEN_VALUE = 0.00000001;
const UTILITY_TOKEN_INITIAL_SUPPLY = 1000000000;

const CONSTANTS = {
  CONTRACT_NAME,
  TOKENS_CONTRACT_NAME,
  NB_BLOCK_PRODUCERS: 21, // number of block producers that can be rewarded
  NB_VOTES_ALLOWED: 30, // number of votes that an account can cast for producers
  STAKE_ACTION,
  UNSTAKE_ACTION,
  REGISTER_NODE_ACTION,
  VOTE,
  UNVOTE,

  AUTHORIZED_ACTIONS: [STAKE_ACTION, UNSTAKE_ACTION, REGISTER_NODE_ACTION, VOTE, UNVOTE],

  // 1200: number of Steem blocks per hour, meaning to unstake you will have to wait one week
  STAKE_WITHDRAWAL_COOLDOWN: 1200 * 24 * 7,
  // 1200: number of Steem blocks per hour
  NB_BLOCKS_UPDATE_INFLATION_RATE: 1200 * 24 * 7,
  NB_INFLATION_DECREASE_PER_YEAR: 52,
  INITIAL_INFLATION_RATE: 0.095, // 9.5%
  MINIMUM_INFLATION_RATE: 0.01, // 1%
  INFLATION_RATE_DECREASING_RATE: 0.0001, // 0.01%

  // meaning that the system will consider 21 block producers and 21 more units tor reward
  // (rewards for 1 block will be divided by 21+21=42
  // so 1/2 of the rewards goes to the proposal system)
  PROPOSAL_SYSTEM_REWARD_UNITS: 21,

  // table names used by the library
  BP_PRODUCERS_TABLE: 'producers',
  BP_STAKES_TABLE: 'stakes',
  BP_VOTES_TABLE: 'votes',
  BP_REWARDS_TABLE: 'rewards',
  TOKENS_TABLE: 'tokens',
  BALANCES_TABLE: 'balances',
  CONTRACTS_BALANCES_TABLE: 'contractsBalances',

  // utility token definition
  UTILITY_TOKEN_SYMBOL,
  UTILITY_TOKEN_PRECISION,
  MINIMUM_TOKEN_VALUE,
  UTILITY_TOKEN_INITIAL_SUPPLY,

  UTILITY_TOKEN: {
    issuer: 'null', // by setting the issuer to 'null', nobody can issue UTILITY_TOKENs (except for the tool itself)
    symbol: UTILITY_TOKEN_SYMBOL,
    name: UTILITY_TOKEN_NAME,
    metadata: UTILITY_TOKEN_METADA,
    precision: UTILITY_TOKEN_PRECISION,
    maxSupply: Number.MAX_SAFE_INTEGER,
    supply: UTILITY_TOKEN_INITIAL_SUPPLY,
    circulatingSupply: UTILITY_TOKEN_INITIAL_SUPPLY,
  },

  // initial balances definition, UTILITY_TOKEN_SYMBOL will be minted and issued to these accounts
  INITIAL_BALANCES: [
    {
      account: 'rocketx',
      symbol: UTILITY_TOKEN_SYMBOL,
      balance: UTILITY_TOKEN_INITIAL_SUPPLY,
    },
  ],
};

module.exports.CONSTANTS = CONSTANTS;
