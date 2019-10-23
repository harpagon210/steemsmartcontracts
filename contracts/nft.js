const CONTRACT_NAME = 'nft';

// eslint-disable-next-line no-template-curly-in-string
const UTILITY_TOKEN_SYMBOL = "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'";
const MAX_NUM_AUTHORIZED_ISSUERS = 10;

actions.createSSC = async (payload) => {
  let tableExists = await api.db.tableExists('nfts');
  if (tableExists === false) {
    await api.db.createTable('nfts', ['symbol']);                           // token definition
    await api.db.createTable('instances', ['symbol', 'account']);           // stores ownership of individual NFT instances by Steem accounts
    await api.db.createTable('contractInstances', ['symbol', 'account']);   // stores ownership of individual NFT instances by other smart contracts
    await api.db.createTable('params');                                     // contract parameters
    await api.db.createTable('delegations', ['from', 'to']);                // NFT instance delegations
    await api.db.createTable('pendingUndelegations', ['account', 'completeTimestamp']);    // NFT instance delegations that are in cooldown after being removed
    await api.db.createTable('propertySchema', ['symbol']);                 // data property definition for each NFT
    await api.db.createTable('properties', ['symbol', 'id']);               // data property values for individual NFT instances

    const params = {};
    params.nftCreationFee = '100';
    params.nftIssuanceFee = '0.001';
    params.dataPropertyCreationFee = '100';     // first 3 properties are free, then this fee applies for each one after the initial 3
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
  if (result.errors === undefined
    && result.events && result.events.find(el => el.contract === 'tokens' && el.event === 'transfer'
    && el.data.from === from && el.data.to === to && el.data.quantity === quantity && el.data.symbol === symbol) !== undefined) {
    return true;
  }
  return false;
};

// check if duplicate elements in array
const containsDuplicates = (arr) => {
  return new Set(arr).size !== arr.length
};

actions.updateUrl = async (payload) => {
  const { url, symbol } = payload;

  if (api.assert(symbol && typeof symbol === 'string'
    && url && typeof url === 'string', 'invalid params')
    && api.assert(url.length <= 255, 'invalid url: max length of 255')) {
    // check if the NFT exists
    const nft = await api.db.findOne('nfts', { symbol });

    if (nft) {
      if (api.assert(nft.issuer === api.sender, 'must be the issuer')) {
        try {
          const metadata = JSON.parse(nft.metadata);

          if (api.assert(metadata && metadata.url, 'an error occured when trying to update the url')) {
            metadata.url = url;
            nft.metadata = JSON.stringify(metadata);
            await api.db.update('nfts', nft);
          }
        } catch (e) {
          // error when parsing the metadata
        }
      }
    }
  }
};

actions.updateMetadata = async (payload) => {
  const { metadata, symbol } = payload;

  if (api.assert(symbol && typeof symbol === 'string'
    && metadata && typeof metadata === 'object', 'invalid params')) {
    // check if the NFT exists
    const nft = await api.db.findOne('nfts', { symbol });

    if (nft) {
      if (api.assert(nft.issuer === api.sender, 'must be the issuer')) {
        try {
          const finalMetadata = JSON.stringify(metadata);

          if (api.assert(finalMetadata.length <= 1000, 'invalid metadata: max length of 1000')) {
            nft.metadata = finalMetadata;
            await api.db.update('nfts', nft);
          }
        } catch (e) {
          // error when stringifying the metadata
        }
      }
    }
  }
};

actions.updateName = async (payload) => {
  const { name, symbol } = payload;

  if (api.assert(symbol && typeof symbol === 'string'
    && name && typeof name === 'string', 'invalid params')
    && api.assert(api.validator.isAlphanumeric(api.validator.blacklist(name, ' ')) && name.length > 0 && name.length <= 50, 'invalid name: letters, numbers, whitespaces only, max length of 50')) {
    // check if the NFT exists
    const nft = await api.db.findOne('nfts', { symbol });

    if (nft) {
      if (api.assert(nft.issuer === api.sender, 'must be the issuer')) {
        nft.name = name;
        await api.db.update('nfts', nft);
      }
    }
  }
};

actions.addAuthorizedIssuingAccounts = async (payload) => {
  const { accounts, symbol, isSignedWithActiveKey } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
    && accounts && typeof accounts === 'object' && Array.isArray(accounts), 'invalid params')
    && api.assert(accounts.length <= MAX_NUM_AUTHORIZED_ISSUERS, `cannot have more than ${MAX_NUM_AUTHORIZED_ISSUERS} authorized issuing accounts`)) {
    let validContents = true;
    accounts.forEach(account => {
      // a valid Steem account is between 3 and 16 characters in length
      if (!(typeof account === 'string') || !(account.length >= 3 && account.length <= 16)) {
        validContents = false;
      }
    });
    if (api.assert(validContents, 'invalid account list')) {
      // check if the NFT exists
      const nft = await api.db.findOne('nfts', { symbol });
      
      if (nft) {
        let sanitizedList = []
        // filter out duplicate accounts
        accounts.forEach(account => {
          let finalAccount = account.trim().toLowerCase();
          let isDuplicate = false;
          for (var i = 0; i < nft.authorizedIssuingAccounts.length; i++) {
            if (finalAccount === nft.authorizedIssuingAccounts[i]) {
              isDuplicate = true;
              break;
            }
          }
          if (!isDuplicate) {
            sanitizedList.push(finalAccount);
          }
        });

        if (api.assert(nft.issuer === api.sender, 'must be the issuer')
          && api.assert(!containsDuplicates(sanitizedList), 'cannot add the same account twice')
          && api.assert(nft.authorizedIssuingAccounts.length + sanitizedList.length <= MAX_NUM_AUTHORIZED_ISSUERS, `cannot have more than ${MAX_NUM_AUTHORIZED_ISSUERS} authorized issuing accounts`)) {
          const finalAccountList = nft.authorizedIssuingAccounts.concat(sanitizedList);
          nft.authorizedIssuingAccounts = finalAccountList;
          await api.db.update('nfts', nft);
        }
      }
    }
  }
};

actions.addAuthorizedIssuingContracts = async (payload) => {
  const { contracts, symbol, isSignedWithActiveKey } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
    && contracts && typeof contracts === 'object' && Array.isArray(contracts), 'invalid params')
    && api.assert(contracts.length <= MAX_NUM_AUTHORIZED_ISSUERS, `cannot have more than ${MAX_NUM_AUTHORIZED_ISSUERS} authorized issuing contracts`)) {
    let validContents = true;
    contracts.forEach(contract => {
      // a valid contract name is between 3 and 50 characters in length
      if (!(typeof contract === 'string') || !(contract.length >= 3 && contract.length <= 50)) {
        validContents = false;
      }
    });
    if (api.assert(validContents, 'invalid contract list')) {
      // check if the NFT exists
      const nft = await api.db.findOne('nfts', { symbol });

      if (nft) {
        let sanitizedList = []
        // filter out duplicate contracts
        contracts.forEach(contract => {
          let finalContract = contract.trim();
          let isDuplicate = false;
          for (var i = 0; i < nft.authorizedIssuingContracts.length; i++) {
            if (finalContract === nft.authorizedIssuingContracts[i]) {
              isDuplicate = true;
              break;
            }
          }
          if (!isDuplicate) {
            sanitizedList.push(finalContract);
          }
        });

        if (api.assert(nft.issuer === api.sender, 'must be the issuer')
          && api.assert(!containsDuplicates(sanitizedList), 'cannot add the same contract twice')
          && api.assert(nft.authorizedIssuingContracts.length + sanitizedList.length <= MAX_NUM_AUTHORIZED_ISSUERS, `cannot have more than ${MAX_NUM_AUTHORIZED_ISSUERS} authorized issuing contracts`)) {
          const finalContractList = nft.authorizedIssuingContracts.concat(sanitizedList);
          nft.authorizedIssuingContracts = finalContractList;
          await api.db.update('nfts', nft);
        }
      }
    }
  }
};

actions.removeAuthorizedIssuingAccounts = async (payload) => {
  const { accounts, symbol, isSignedWithActiveKey } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
    && accounts && typeof accounts === 'object' && Array.isArray(accounts), 'invalid params')
    && api.assert(accounts.length <= MAX_NUM_AUTHORIZED_ISSUERS, `cannot remove more than ${MAX_NUM_AUTHORIZED_ISSUERS} authorized issuing accounts`)) {
    let validContents = true;
    accounts.forEach(account => {
      // a valid Steem account is between 3 and 16 characters in length
      if (!(typeof account === 'string') || !(account.length >= 3 && account.length <= 16)) {
        validContents = false;
      }
    });
    if (api.assert(validContents, 'invalid account list')) {
      // check if the NFT exists
      const nft = await api.db.findOne('nfts', { symbol });

      if (nft) {
        if (api.assert(nft.issuer === api.sender, 'must be the issuer')) {
          // build final list, removing entries that are both in the input list & current authorized list
          let finalAccountList = nft.authorizedIssuingAccounts.filter(currentValue => {
            for (var i = 0; i < accounts.length; i++) {
              let finalAccount = accounts[i].trim().toLowerCase();
              if (currentValue === finalAccount) {
                return false;
              }
            }
            return true;
          });

          nft.authorizedIssuingAccounts = finalAccountList;
          await api.db.update('nfts', nft);
        }
      }
    }
  }
};

actions.removeAuthorizedIssuingContracts = async (payload) => {
  const { contracts, symbol, isSignedWithActiveKey } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
    && contracts && typeof contracts === 'object' && Array.isArray(contracts), 'invalid params')
    && api.assert(contracts.length <= MAX_NUM_AUTHORIZED_ISSUERS, `cannot remove more than ${MAX_NUM_AUTHORIZED_ISSUERS} authorized issuing contracts`)) {
    let validContents = true;
    contracts.forEach(contract => {
      // a valid contract name is between 3 and 50 characters in length
      if (!(typeof contract === 'string') || !(contract.length >= 3 && contract.length <= 50)) {
        validContents = false;
      }
    });
    if (api.assert(validContents, 'invalid contract list')) {
      // check if the NFT exists
      const nft = await api.db.findOne('nfts', { symbol });

      if (nft) {
        if (api.assert(nft.issuer === api.sender, 'must be the issuer')) {
          // build final list, removing entries that are both in the input list & current authorized list
          let finalContractList = nft.authorizedIssuingContracts.filter(currentValue => {
            for (var i = 0; i < contracts.length; i++) {
              let finalContract = contracts[i].trim();
              if (currentValue === finalContract) {
                return false;
              }
            }
            return true;
          });

          nft.authorizedIssuingContracts = finalContractList;
          await api.db.update('nfts', nft);
        }
      }
    }
  }
};

actions.transferOwnership = async (payload) => {
  const { symbol, to, isSignedWithActiveKey } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
    && to && typeof to === 'string', 'invalid params')) {
    // check if the NFT exists
    const nft = await api.db.findOne('nfts', { symbol });

    if (nft) {
      if (api.assert(nft.issuer === api.sender, 'must be the issuer')) {
        const finalTo = to.trim().toLowerCase();

        // a valid Steem account is between 3 and 16 characters in length
        if (api.assert(finalTo.length >= 3 && finalTo.length <= 16, 'invalid to')) {
          nft.issuer = finalTo;
          await api.db.update('nfts', nft);
        }
      }
    }
  }
};

actions.addProperty = async (payload) => {
  const { symbol, name, type, isReadOnly, isSignedWithActiveKey } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { dataPropertyCreationFee } = params;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
    && name && typeof name === 'string'
    && (isReadOnly === undefined || typeof isReadOnly === 'boolean')
    && type && typeof type === 'string', 'invalid params')
    && api.assert(api.validator.isAlphanumeric(name) && name.length > 0 && name.length <= 25, 'invalid name: letters & numbers only, max length of 25')
    && api.assert(type === 'number' || type === 'string' || type === 'boolean', 'invalid type: must be number, string, or boolean')) {
    // check if the NFT exists
    const nft = await api.db.findOne('nfts', { symbol });

    if (nft) {
      if (api.assert(!(name in nft.properties), 'cannot add the same property twice')
        && api.assert(nft.issuer === api.sender, 'must be the issuer')) {
        let propertyCount = Object.keys(nft.properties).length;
        if (propertyCount >= 3) {
          // first 3 properties are free, after that you need to pay the fee for each additional property
          const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: UTILITY_TOKEN_SYMBOL });
          const authorizedCreation = api.BigNumber(dataPropertyCreationFee).lte(0)
            ? true
            : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(dataPropertyCreationFee);

          if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fees')) {
            if (api.BigNumber(dataPropertyCreationFee).gt(0)) {
              const res = await api.executeSmartContract('tokens', 'transfer', { to: 'null', symbol: UTILITY_TOKEN_SYMBOL, quantity: dataPropertyCreationFee, isSignedWithActiveKey });
              // check if the tokens were sent
              if (!isTokenTransferVerified(res, api.sender, 'null', UTILITY_TOKEN_SYMBOL, dataPropertyCreationFee)) {
                return false;
              }
            }
          } else {
            return false;
          }
        }

        const finalIsReadOnly = isReadOnly === undefined ? false : isReadOnly;

        const newProperty = {
          type,
          isReadOnly: finalIsReadOnly,
          authorizedEditingAccounts: [],
          authorizedEditingContracts: [],
        };

        nft.properties[name] = newProperty;
        await api.db.update('nfts', nft);
        return true;
      }
    }
  }
  return false;
};

actions.create = async (payload) => {
  const {
    name, symbol, url, maxSupply, authorizedIssuingAccounts, authorizedIssuingContracts, isSignedWithActiveKey,
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
      && symbol && typeof symbol === 'string'
      && (url === undefined || (url && typeof url === 'string'))
      && (authorizedIssuingAccounts === undefined || (authorizedIssuingAccounts && typeof authorizedIssuingAccounts === 'object' && Array.isArray(authorizedIssuingAccounts)))
      && (authorizedIssuingContracts === undefined || (authorizedIssuingContracts && typeof authorizedIssuingContracts === 'object' && Array.isArray(authorizedIssuingContracts)))
      && (maxSupply === undefined || (maxSupply && typeof maxSupply === 'string' && !api.BigNumber(maxSupply).isNaN())), 'invalid params')) {
    if (api.assert(api.validator.isAlpha(symbol) && api.validator.isUppercase(symbol) && symbol.length > 0 && symbol.length <= 10, 'invalid symbol: uppercase letters only, max length of 10')
      && api.assert(api.validator.isAlphanumeric(api.validator.blacklist(name, ' ')) && name.length > 0 && name.length <= 50, 'invalid name: letters, numbers, whitespaces only, max length of 50')
      && api.assert(url === undefined || url.length <= 255, 'invalid url: max length of 255')
      && api.assert(maxSupply === undefined || api.BigNumber(maxSupply).gt(0), 'maxSupply must be positive')
      && api.assert(maxSupply === undefined || api.BigNumber(maxSupply).lte(Number.MAX_SAFE_INTEGER), `maxSupply must be lower than ${Number.MAX_SAFE_INTEGER}`)) {
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

        const finalMaxSupply = maxSupply === undefined ? 0 : api.BigNumber(maxSupply).integerValue(api.BigNumber.ROUND_DOWN).toNumber()

        const finalUrl = url === undefined ? '' : url;
        let metadata = {
          url: finalUrl,
        };
        metadata = JSON.stringify(metadata);

        let initialAccountList = authorizedIssuingAccounts === undefined ? [api.sender] : [];

        const newNft = {
          issuer: api.sender,
          symbol,
          name,
          metadata,
          maxSupply: finalMaxSupply,
          supply: 0,
          circulatingSupply: 0,
          delegationEnabled: false,
          undelegationCooldown: 0,
          authorizedIssuingAccounts: initialAccountList,
          authorizedIssuingContracts: [],
          properties: {},
        };

        await api.db.insert('nfts', newNft);

        // optionally can add list of authorized accounts & contracts now
        if (!(authorizedIssuingAccounts === undefined)) {
          await actions.addAuthorizedIssuingAccounts({ accounts: authorizedIssuingAccounts, symbol, isSignedWithActiveKey });
        }
        if (!(authorizedIssuingContracts === undefined)) {
          await actions.addAuthorizedIssuingContracts({ contracts: authorizedIssuingContracts, symbol, isSignedWithActiveKey });
        }
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
