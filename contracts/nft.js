const CONTRACT_NAME = 'nft';

// eslint-disable-next-line no-template-curly-in-string
const UTILITY_TOKEN_SYMBOL = "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'";

actions.createSSC = async (payload) => {
  let tableExists = await api.db.tableExists('nfts');
  if (tableExists === false) {
    await api.db.createTable('nfts', ['symbol']);                           // token definition
    await api.db.createTable('instances', ['symbol', 'account']);           // stores ownership of individual NFT instances by Steem accounts
    await api.db.createTable('contractInstances', ['symbol', 'account']);   // stores ownership of individual NFT instances by other smart contracts
    await api.db.createTable('params');                                     // contract parameters
    await api.db.createTable('delegations', ['from', 'to']);                // NFT instance delegations
    await api.db.createTable('pendingUndelegations', ['account', 'completeTimestamp']);    // NFT instance delegations that are in cooldown after being removed
    await api.db.createTable('issuingAccounts', ['symbol', 'account']);                    // Steem accounts that are authorized to issue NFTs
    await api.db.createTable('issuingContractAccounts', ['symbol', 'account']);            // Smart contracts that are authorized to issue NFTs
    await api.db.createTable('propertySchema', ['symbol']);                 // data property definition for each NFT
    await api.db.createTable('properties', ['symbol', 'id']);               // data property values for individual NFT instances

    const params = {};
    params.nftCreationFee = '100';
    params.nftIssuanceFee = '0.001';
    params.dataPropertyCreationFee = '10';
    params.enableDelegationFee = '1000';
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  if (api.sender !== api.owner) return;

  const { nftCreationFee, nftIssuanceFee, dataPropertyCreationFee, enableDelegationFee } = payload;

  const params = await api.db.findOne('params', {});

  if (nftCreationFee && typeof nftCreationFee === 'string' && !api.BigNumber(nftCreationFee).isNaN() && api.BigNumber(nftCreationFee).gte(0)) {
    params.nftCreationFee = nftCreationFee;
  }
  if (nftIssuanceFee && typeof nftIssuanceFee === 'string' && !api.BigNumber(nftIssuanceFee).isNaN() && api.BigNumber(nftIssuanceFee).gte(0)) {
    params.nftIssuanceFee = nftIssuanceFee;
  }
  if (dataPropertyCreationFee && typeof dataPropertyCreationFee === 'string' && !api.BigNumber(dataPropertyCreationFee).isNaN() && api.BigNumber(dataPropertyCreationFee).gte(0)) {
    params.dataPropertyCreationFee = dataPropertyCreationFee;
  }
  if (enableDelegationFee && typeof enableDelegationFee === 'string' && !api.BigNumber(enableDelegationFee).isNaN() && api.BigNumber(enableDelegationFee).gte(0)) {
    params.enableDelegationFee = enableDelegationFee;
  }  

  await api.db.update('params', params);
};

// check that token transfers succeeded
const isTokenTransferVerified = (result, from, to, symbol, quantity) => {
  if (res.errors === undefined
    && res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transfer'
    && el.data.from === from && el.data.to === to && el.data.quantity === quantity && el.data.symbol === symbol) !== undefined) {
    return true;
  }
  return false;
};

actions.create = async (payload) => {
  const {
    name, symbol, isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { nftCreationFee } = params;

  // get api.sender's UTILITY_TOKEN_SYMBOL balance
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: UTILITY_TOKEN_SYMBOL });

  const authorizedCreation = api.BigNumber(nftCreationFee).lte(0)
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(nftCreationFee);

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fees')
      && api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
      && api.assert(name && typeof name === 'string'
      && symbol && typeof symbol === 'string', 'invalid params')) {
    if (api.assert(api.validator.isAlpha(symbol) && api.validator.isUppercase(symbol) && symbol.length > 0 && symbol.length <= 10, 'invalid symbol: uppercase letters only, max length of 10')
      && api.assert(api.validator.isAlphanumeric(api.validator.blacklist(name, ' ')) && name.length > 0 && name.length <= 50, 'invalid name: letters, numbers, whitespaces only, max length of 50')) {
      // check if the NFT already exists
      const nft = await api.db.findOne('nfts', { symbol });

      if (api.assert(nft === null, 'symbol already exists')) {
        // burn the token creation fees
        if (api.BigNumber(nftCreationFee).gt(0)) {
          const res = await api.executeSmartContract('tokens', 'transfer', { to: 'null', symbol: UTILITY_TOKEN_SYMBOL, quantity: nftCreationFee, isSignedWithActiveKey });
          // check if the tokens were sent
          if (!isTokenTransferVerified(res, api.sender, 'null', UTILITY_TOKEN_SYMBOL, nftCreationFee)) {
            return false;
          }
        }

        const newNft = {
          issuer: api.sender,
          symbol,
          name,
          supply: 0,
          delegationEnabled: false,
          undelegationCooldown: 0,
        };

        await api.db.insert('nfts', newNft);
        return true;
      }
    }
  }
  return false;
};

/*actions.swap = async (payload) => {
  // get the action parameters
  const { amount, isSignedWithActiveKey, } = payload;

  // check the action parameters
  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(amount && typeof amount === 'string' && !api.BigNumber(amount).isNaN() && api.BigNumber(amount).dp() <= 3 && api.BigNumber(amount).gt(0), 'invalid amount')) {
    // get the contract parameters
    const params = await api.db.findOne('params', {});

    // find sender's balance
    const inputTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: params.inputTknSymbol });
    if (api.assert(inputTokenBalance && inputTokenBalance.balance && api.BigNumber(inputTokenBalance.balance).gte(amount), 'you must have enough tokens to cover the swap amount')) {
      // calculate amount of tokens to send back
      const inputTknAmount = api.BigNumber(params.inputTknAmount)
      const outputTknAmount = api.BigNumber(params.outputTknAmount)
      const sendAmount = api.BigNumber(amount)
        .dividedBy(inputTknAmount)
        .multipliedBy(outputTknAmount)
        .toFixed(3, api.BigNumber.ROUND_DOWN);

      // now make sure the contract has enough tokens to send back
      const outputTokenBalance = await api.db.findOneInTable('tokens', 'contractsBalances', { account: CONTRACT_NAME, symbol: params.outputTknSymbol });
      if (api.assert(outputTokenBalance && outputTokenBalance.balance && api.BigNumber(outputTokenBalance.balance).gte(sendAmount), 'contract does not have enough tokens to send back')) {
        const res = await api.executeSmartContract('tokens', 'transferToContract', { symbol: params.inputTknSymbol, quantity: amount, to: CONTRACT_NAME });
        // check if the tokens were sent
        if (res.errors === undefined
          && res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === api.sender && el.data.to === CONTRACT_NAME && el.data.quantity === amount && el.data.symbol === params.inputTknSymbol) !== undefined) {
          // send the tokens out
          await api.transferTokens(api.sender, params.outputTknSymbol, sendAmount, 'user');

          api.emit('swap', { target: api.sender, symbolFrom: params.inputTknSymbol, inputAmount: amount, symbolTo: params.outputTknSymbol, outputAmount: sendAmount });
          return true;
        }
      }
    }
  }

  return false;
};*/
