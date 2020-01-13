/* eslint-disable no-await-in-loop */
/* global actions, api */

// eslint-disable-next-line no-template-curly-in-string
const UTILITY_TOKEN_SYMBOL = "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'";

actions.createSSC = async () => {

};

actions.issueNewTokens = async () => {
  if (api.sender !== 'null') return;

  // issue tokens to steemsc
  // 100k tokens per year = 11.41552511 tokens per hour (an hour = 1200 blocks)
  let nbTokens = '11.41552511';
  await api.executeSmartContract('tokens', 'issue', { symbol: UTILITY_TOKEN_SYMBOL, quantity: nbTokens, to: 'steemsc' });

  // issue tokens to engpool
  // 100k tokens per year = 11.41552511 tokens per hour (an hour = 1200 blocks)
  nbTokens = '11.41552511';
  await api.executeSmartContract('tokens', 'issue', { symbol: UTILITY_TOKEN_SYMBOL, quantity: nbTokens, to: 'engpool' });

  // issue tokens to "witnesses" contract
  // 200k tokens per year = 22.83105022 tokens per hour (an hour = 1200 blocks)
  nbTokens = '22.83105022';
  await api.executeSmartContract('tokens', 'issueToContract', { symbol: UTILITY_TOKEN_SYMBOL, quantity: nbTokens, to: 'witnesses' });
};
