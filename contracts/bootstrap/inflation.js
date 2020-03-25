/* eslint-disable no-await-in-loop */
/* global actions, api */

// eslint-disable-next-line no-template-curly-in-string
const UTILITY_TOKEN_SYMBOL = "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'";
// eslint-disable-next-line no-template-curly-in-string
const HIVE_ENGINE_ACCOUNT = "'${CONSTANTS.HIVE_ENGINE_ACCOUNT}$'";

actions.createSSC = async () => {

};

actions.issueNewTokens = async () => {
  if (api.sender !== 'null') return;

  // issue tokens to HIVE_ENGINE_ACCOUNT
  // 100k tokens per year = 11.41552511 tokens per hour (an hour = 1200 blocks)
  let nbTokens = '11.41552511';
  await api.executeSmartContract('tokens', 'issue',
    { symbol: UTILITY_TOKEN_SYMBOL, quantity: nbTokens, to: HIVE_ENGINE_ACCOUNT });

  // issue tokens to engpool
  // 100k tokens per year = 11.41552511 tokens per hour (an hour = 1200 blocks)
  nbTokens = '11.41552511';
  await api.executeSmartContract('tokens', 'issue', { symbol: UTILITY_TOKEN_SYMBOL, quantity: nbTokens, to: 'hive-miner' });

  // issue tokens to "witnesses" contract
  // 200k tokens per year = 22.83105022 tokens per hour (an hour = 1200 blocks)
  // nbTokens = '22.83105022';
  // await api.executeSmartContract('tokens', 'issueToContract',
  // { symbol: UTILITY_TOKEN_SYMBOL, quantity: nbTokens, to: 'witnesses' });
};
