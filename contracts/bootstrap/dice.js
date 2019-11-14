
/* eslint-disable */
const STEEM_PEGGED_SYMBOL = 'STEEMP';
const CONTRACT_NAME = 'dice';

actions.createSSC = async (payload) => {
  await api.db.createTable('params');

  const params = {};
  params.houseEdge = '0.01';
  params.minBet = '0.1';
  params.maxBet = '100';
  await api.db.insert('params', params);
};

actions.roll = async (payload) => {
  // get the action parameters
  const { roll, amount } = payload;

  // check the action parameters
  if (api.assert(roll && Number.isInteger(roll) && roll >= 2 && roll <= 96, 'roll must be an integer and must be between 2 and 96')
    && api.assert(amount && typeof amount === 'string' && api.BigNumber(amount).dp() <= 3 && api.BigNumber(amount).gt(0), 'invalid amount')) {
    // get the contract parameters
    const params = await api.db.findOne('params', {});

    // check that the amount bet is in thr allowed range
    if (api.assert(api.BigNumber(amount).gte(params.minBet) && api.BigNumber(amount).lte(params.maxBet), 'amount must be between minBet and maxBet')) {
      // request lock of amount STEEMP tokens
      const res = await api.executeSmartContract('tokens', 'transferToContract', { symbol: STEEM_PEGGED_SYMBOL, quantity: amount, to: CONTRACT_NAME });

      // check if the tokens were locked
      if (res.errors === undefined
        && res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === api.sender && el.data.to === CONTRACT_NAME && el.data.quantity === amount && el.data.symbol === STEEM_PEGGED_SYMBOL) !== undefined) {

        // get a deterministic random number
        const random = api.random();

        // calculate the roll
        const randomRoll = Math.floor(random * 100) + 1;

        // check if the dice rolled under "roll"
        if (randomRoll < roll) {
          const multiplier = api.BigNumber(1)
            .minus(params.houseEdge)
            .multipliedBy(100)
            .dividedBy(roll);

          // calculate the number of tokens won
          const tokensWon = api.BigNumber(amount)
            .multipliedBy(multiplier)
            .toFixed(3, api.BigNumber.ROUND_DOWN);

          // send the tokens out
          await api.transferTokens(api.sender, STEEM_PEGGED_SYMBOL, tokensWon, 'user');

          // emit an event
          api.emit('results', { memo: `you won. roll: ${randomRoll}, your bet: ${roll}` });
        } else {
          // emit an event
          api.emit('results', { memo: `you lost. roll: ${randomRoll}, your bet: ${roll}` });
        }
      }
      // else,
      // errors will be displayed in the logs of the transaction
    }
  }
};
