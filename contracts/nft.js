/* eslint-disable no-await-in-loop */
/* eslint-disable valid-typeof */
/* eslint-disable max-len */
/* global actions, api */

const CONTRACT_NAME = 'nft';

// eslint-disable-next-line no-template-curly-in-string
const UTILITY_TOKEN_SYMBOL = "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'";
const MAX_NUM_AUTHORIZED_ISSUERS = 10;
const MAX_NUM_LOCKED_TOKEN_TYPES = 10;
const MAX_SYMBOL_LENGTH = 10;
const MAX_DATA_PROPERTY_LENGTH = 100;

// cannot issue more than this number of NFT instances in one action
const MAX_NUM_NFTS_ISSUABLE = 10;

// cannot set properties on more than this number of NFT instances in one action
const MAX_NUM_NFTS_EDITABLE = 50;

// cannot burn, transfer, delegate, or undelegate more than
// this number of NFT instances in one action
const MAX_NUM_NFTS_OPERABLE = 50;

// cannot issue or burn more than this number of NFT
// instances in one action, when the list of NFT instances
// to act on includes a token with locked NFT instances
// contained within it
const MAX_NUM_CONTAINER_NFTS_OPERABLE = 1;

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('nfts');
  if (tableExists === false) {
    await api.db.createTable('nfts', ['symbol']);
    await api.db.createTable('params');
    // NFT instance delegations that are in cooldown after being undelegated
    await api.db.createTable('pendingUndelegations', ['symbol', 'completeTimestamp']);

    const params = {};
    params.nftCreationFee = '100';
    // issuance fee can be paid in one of several different tokens
    params.nftIssuanceFee = {
      // eslint-disable-next-line no-template-curly-in-string
      "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'": '0.001',
      PAL: '0.001',
    };
    // first 3 properties are free, then this fee applies for each one after the initial 3
    params.dataPropertyCreationFee = '100';
    params.enableDelegationFee = '1000';
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  if (api.sender !== api.owner) return;

  const {
    nftCreationFee,
    nftIssuanceFee,
    dataPropertyCreationFee,
    enableDelegationFee,
  } = payload;

  const params = await api.db.findOne('params', {});

  if (nftCreationFee && typeof nftCreationFee === 'string' && !api.BigNumber(nftCreationFee).isNaN() && api.BigNumber(nftCreationFee).gte(0)) {
    params.nftCreationFee = nftCreationFee;
  }
  if (nftIssuanceFee && typeof nftIssuanceFee === 'object') {
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
const isTokenTransferVerified = (result, from, to, symbol, quantity, eventStr) => {
  if (result.errors === undefined
    && result.events && result.events.find(el => el.contract === 'tokens' && el.event === eventStr
    && el.data.from === from && el.data.to === to && el.data.quantity === quantity && el.data.symbol === symbol) !== undefined) {
    return true;
  }
  return false;
};

const calculateBalance = (balance, quantity, precision, add) => (add
  ? api.BigNumber(balance).plus(quantity).toFixed(precision)
  : api.BigNumber(balance).minus(quantity).toFixed(precision));

const countDecimals = value => api.BigNumber(value).dp();

// check if duplicate elements in array
const containsDuplicates = arr => new Set(arr).size !== arr.length;

// a valid Steem account is between 3 and 16 characters in length
const isValidSteemAccountLength = account => account.length >= 3 && account.length <= 16;

// a valid contract name is between 3 and 50 characters in length
const isValidContractLength = contract => contract.length >= 3 && contract.length <= 50;

const isValidAccountsArray = (arr) => {
  let validContents = true;
  arr.forEach((account) => {
    if (!(typeof account === 'string') || !isValidSteemAccountLength(account)) {
      validContents = false;
    }
  });
  return validContents;
};

const isValidContractsArray = (arr) => {
  let validContents = true;
  arr.forEach((contract) => {
    if (!(typeof contract === 'string') || !isValidContractLength(contract)) {
      validContents = false;
    }
  });
  return validContents;
};

// used by issue action to validate user input
const isValidDataProperties = (from, fromType, nft, properties) => {
  const propertyCount = Object.keys(properties).length;
  const nftPropertyCount = Object.keys(nft.properties).length;
  if (!api.assert(propertyCount <= nftPropertyCount, 'cannot set more data properties than NFT has')) {
    return false;
  }

  // eslint-disable-next-line no-restricted-syntax
  for (const [name, data] of Object.entries(properties)) {
    let validContents = false;
    if (api.assert(name && typeof name === 'string'
      && api.validator.isAlphanumeric(name) && name.length > 0 && name.length <= 25, 'invalid data property name: letters & numbers only, max length of 25')) {
      if (api.assert(name in nft.properties, 'data property must exist')) {
        const propertySchema = nft.properties[name];
        if (api.assert(data !== undefined && data !== null
          && (typeof data === propertySchema.type
          || (propertySchema.type === 'number' && typeof data === 'string' && !api.BigNumber(data).isNaN())), `data property type mismatch: expected ${propertySchema.type} but got ${typeof data} for property ${name}`)
          && api.assert(typeof data !== 'string' || data.length <= MAX_DATA_PROPERTY_LENGTH, `string property max length is ${MAX_DATA_PROPERTY_LENGTH} characters`)
          && api.assert((fromType === 'contract' && propertySchema.authorizedEditingContracts.includes(from))
          || (fromType === 'user' && propertySchema.authorizedEditingAccounts.includes(from)), 'not allowed to set data properties')) {
          validContents = true;

          // if we have a number type represented as a string, then need to do type conversion
          if (propertySchema.type === 'number' && typeof data === 'string') {
            // eslint-disable-next-line no-param-reassign
            properties[name] = api.BigNumber(data).toNumber();
          }
        }
      }
    }
    if (!validContents) {
      return false;
    }
  }

  return true;
};

// used by setProperties action to validate user input
const isValidDataPropertiesArray = (from, fromType, nft, arr) => {
  try {
    for (let i = 0; i < arr.length; i += 1) {
      let validContents = false;
      const { id, properties } = arr[i];
      if (api.assert(id && typeof id === 'string' && !api.BigNumber(id).isNaN() && api.BigNumber(id).gt(0)
        && properties && typeof properties === 'object', 'invalid data properties')) {
        if (isValidDataProperties(from, fromType, nft, properties)) {
          validContents = true;
        }
      }
      if (!validContents) {
        return false;
      }
    }
  } catch (e) {
    return false;
  }
  return true;
};

const isValidNftIdArray = (arr) => {
  try {
    let instanceCount = 0;
    for (let i = 0; i < arr.length; i += 1) {
      let validContents = false;
      const { symbol, ids } = arr[i];
      if (api.assert(symbol && typeof symbol === 'string'
        && api.validator.isAlpha(symbol) && api.validator.isUppercase(symbol) && symbol.length > 0 && symbol.length <= MAX_SYMBOL_LENGTH
        && ids && typeof ids === 'object' && Array.isArray(ids), 'invalid nft list')) {
        instanceCount += ids.length;
        if (api.assert(instanceCount <= MAX_NUM_NFTS_OPERABLE, `cannot operate on more than ${MAX_NUM_NFTS_OPERABLE} NFT instances at once`)) {
          for (let j = 0; j < ids.length; j += 1) {
            const id = ids[j];
            if (!api.assert(id && typeof id === 'string' && !api.BigNumber(id).isNaN() && api.BigNumber(id).gt(0), 'invalid nft list')) {
              return false;
            }
          }
          validContents = true;
        }
      }
      if (!validContents) {
        return false;
      }
    }
  } catch (e) {
    return false;
  }
  return true;
};

// used to validate bundles of tokens to be locked in an NFT upon issuance
// (tokens must exist, basket must not consist of too many token types, and issuing account
// must have enough of each token)
const isValidTokenBasket = async (basket, balanceTableName, accountName, feeSymbol, feeQuantity) => {
  try {
    const symbolCount = Object.keys(basket).length;
    if (symbolCount > MAX_NUM_LOCKED_TOKEN_TYPES) {
      return false;
    }
    // eslint-disable-next-line no-restricted-syntax
    for (const [symbol, quantity] of Object.entries(basket)) {
      let validContents = false;
      if (typeof symbol === 'string' && api.validator.isAlpha(symbol) && api.validator.isUppercase(symbol) && symbol.length > 0 && symbol.length <= MAX_SYMBOL_LENGTH) {
        const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });
        if (token) {
          if (quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN() && api.BigNumber(quantity).gt(0) && countDecimals(quantity) <= token.precision) {
            const finalQuantity = symbol === feeSymbol ? calculateBalance(quantity, feeQuantity, token.precision, true) : quantity;
            const basketTokenBalance = await api.db.findOneInTable('tokens', balanceTableName, { account: accountName, symbol });
            if (basketTokenBalance && api.BigNumber(basketTokenBalance.balance).gte(finalQuantity)) {
              validContents = true;
            }
          }
        }
      }
      if (!validContents) {
        return false;
      }
    }
  } catch (e) {
    return false;
  }
  return true;
};

// used by issue & burn actions to lock/unlock NFT instances within tokens
// performs a transfer and does extended verification on the results
const transferAndVerifyNfts = async (from, fromType, to, toType, nfts, isSignedWithActiveKey, callingContractInfo) => {
  const results = {
    success: [],
    fail: [],
  };

  const finalFromType = fromType === 'user' ? 'u' : 'c';
  const finalToType = toType === 'user' ? 'u' : 'c';

  await actions.transfer({
    fromType,
    to,
    toType,
    nfts,
    isSignedWithActiveKey,
    callingContractInfo,
  });
  const logs = api.logs();
  const tokenMap = {};
  const countedMap = {};

  if (logs.events) {
    for (let i = 0; i < logs.events.length; i += 1) {
      const ev = logs.events[i];
      if (ev.contract && ev.event && ev.data
        && ev.contract === 'nft'
        && ev.event === 'transfer'
        && ev.data.from === from
        && ev.data.fromType === finalFromType
        && ev.data.to === to
        && ev.data.toType === finalToType) {
        // transfer is verified, save it so we can match against nfts
        // eslint-disable-next-line prefer-template
        const key = ev.data.symbol + '-' + ev.data.id;
        tokenMap[key] = 1;
      }
    }
  }

  // generate result data
  for (let index = 0; index < nfts.length; index += 1) {
    const { symbol, ids } = nfts[index];
    const success = [];
    const fail = [];
    for (let j = 0; j < ids.length; j += 1) {
      // eslint-disable-next-line prefer-template
      const inputKey = symbol + '-' + ids[j];
      if (!(inputKey in countedMap)) {
        if (inputKey in tokenMap) {
          success.push(ids[j].toString());
        } else {
          fail.push(ids[j].toString());
        }
        countedMap[inputKey] = 1;
      }
    }

    if (success.length > 0) {
      results.success.push({
        symbol,
        ids: success,
      });
    }
    if (fail.length > 0) {
      results.fail.push({
        symbol,
        ids: fail,
      });
    }
  }

  return results;
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

actions.updateOrgName = async (payload) => {
  const { orgName, symbol } = payload;

  if (api.assert(symbol && typeof symbol === 'string'
    && orgName && typeof orgName === 'string', 'invalid params')
    && api.assert(api.validator.isAlphanumeric(api.validator.blacklist(orgName, ' ')) && orgName.length > 0 && orgName.length <= 50, 'invalid org name: letters, numbers, whitespaces only, max length of 50')) {
    // check if the NFT exists
    const nft = await api.db.findOne('nfts', { symbol });

    if (nft) {
      if (api.assert(nft.issuer === api.sender, 'must be the issuer')) {
        nft.orgName = orgName;
        await api.db.update('nfts', nft);
      }
    }
  }
};

actions.updateProductName = async (payload) => {
  const { productName, symbol } = payload;

  if (api.assert(symbol && typeof symbol === 'string'
    && productName && typeof productName === 'string', 'invalid params')
    && api.assert(api.validator.isAlphanumeric(api.validator.blacklist(productName, ' ')) && productName.length > 0 && productName.length <= 50, 'invalid product name: letters, numbers, whitespaces only, max length of 50')) {
    // check if the NFT exists
    const nft = await api.db.findOne('nfts', { symbol });

    if (nft) {
      if (api.assert(nft.issuer === api.sender, 'must be the issuer')) {
        nft.productName = productName;
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
    const validContents = isValidAccountsArray(accounts);
    if (api.assert(validContents, 'invalid account list')) {
      // check if the NFT exists
      const nft = await api.db.findOne('nfts', { symbol });

      if (nft) {
        const sanitizedList = [];
        // filter out duplicate accounts
        accounts.forEach((account) => {
          const finalAccount = account.trim().toLowerCase();
          let isDuplicate = false;
          for (let i = 0; i < nft.authorizedIssuingAccounts.length; i += 1) {
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
    const validContents = isValidContractsArray(contracts);
    if (api.assert(validContents, 'invalid contract list')) {
      // check if the NFT exists
      const nft = await api.db.findOne('nfts', { symbol });

      if (nft) {
        const sanitizedList = [];
        // filter out duplicate contracts
        contracts.forEach((contract) => {
          const finalContract = contract.trim();
          let isDuplicate = false;
          for (let i = 0; i < nft.authorizedIssuingContracts.length; i += 1) {
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
    const validContents = isValidAccountsArray(accounts);
    if (api.assert(validContents, 'invalid account list')) {
      // check if the NFT exists
      const nft = await api.db.findOne('nfts', { symbol });

      if (nft) {
        if (api.assert(nft.issuer === api.sender, 'must be the issuer')) {
          // build final list, removing entries that are both in the input list & current authorized list
          const finalAccountList = nft.authorizedIssuingAccounts.filter((currentValue) => {
            for (let i = 0; i < accounts.length; i += 1) {
              const finalAccount = accounts[i].trim().toLowerCase();
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
    const validContents = isValidContractsArray(contracts);
    if (api.assert(validContents, 'invalid contract list')) {
      // check if the NFT exists
      const nft = await api.db.findOne('nfts', { symbol });

      if (nft) {
        if (api.assert(nft.issuer === api.sender, 'must be the issuer')) {
          // build final list, removing entries that are both in the input list & current authorized list
          const finalContractList = nft.authorizedIssuingContracts.filter((currentValue) => {
            for (let i = 0; i < contracts.length; i += 1) {
              const finalContract = contracts[i].trim();
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

        if (api.assert(isValidSteemAccountLength(finalTo), 'invalid to')) {
          nft.issuer = finalTo;
          await api.db.update('nfts', nft);
        }
      }
    }
  }
};

actions.enableDelegation = async (payload) => {
  const {
    symbol,
    undelegationCooldown,
    isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { enableDelegationFee } = params;

  // get api.sender's UTILITY_TOKEN_SYMBOL balance
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: UTILITY_TOKEN_SYMBOL });

  const authorized = api.BigNumber(enableDelegationFee).lte(0)
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(enableDelegationFee);

  if (api.assert(authorized, 'you must have enough tokens to cover fees')
    && api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string', 'invalid symbol')
    && api.assert(undelegationCooldown && Number.isInteger(undelegationCooldown) && undelegationCooldown > 0 && undelegationCooldown <= 18250, 'undelegationCooldown must be an integer between 1 and 18250')) {
    const nft = await api.db.findOne('nfts', { symbol });

    if (api.assert(nft !== null, 'symbol does not exist')
      && api.assert(nft.issuer === api.sender, 'must be the issuer')
      && api.assert(nft.delegationEnabled === undefined || nft.delegationEnabled === false, 'delegation already enabled')) {
      // burn the fees
      if (api.BigNumber(enableDelegationFee).gt(0)) {
        const res = await api.executeSmartContract('tokens', 'transfer', {
          to: 'null', symbol: UTILITY_TOKEN_SYMBOL, quantity: enableDelegationFee, isSignedWithActiveKey,
        });
        // check if the tokens were sent
        if (!isTokenTransferVerified(res, api.sender, 'null', UTILITY_TOKEN_SYMBOL, enableDelegationFee, 'transfer')) {
          return false;
        }
      }

      nft.delegationEnabled = true;
      nft.undelegationCooldown = undelegationCooldown;
      await api.db.update('nfts', nft);
      return true;
    }
  }
  return false;
};

actions.updatePropertyDefinition = async (payload) => {
  const {
    symbol, name, newName, type, isReadOnly, isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
    && name && typeof name === 'string', 'invalid params')
    && api.assert(api.validator.isAlphanumeric(name) && name.length > 0 && name.length <= 25, 'invalid name: letters & numbers only, max length of 25')
    && api.assert(newName === undefined
    || (typeof newName === 'string' && api.validator.isAlphanumeric(newName) && newName.length > 0 && newName.length <= 25), 'invalid new name: letters & numbers only, max length of 25')
    && api.assert(type === undefined
    || (typeof type === 'string' && (type === 'number' || type === 'string' || type === 'boolean')), 'invalid type: must be number, string, or boolean')
    && api.assert(isReadOnly === undefined || typeof isReadOnly === 'boolean', 'invalid isReadOnly: must be true or false')) {
    // check if the NFT exists
    const nft = await api.db.findOne('nfts', { symbol });

    if (nft) {
      if (api.assert(nft.supply === 0, 'cannot change data property definition; tokens already issued')
        && api.assert(name in nft.properties, 'property must exist')
        && api.assert(nft.issuer === api.sender, 'must be the issuer')) {
        // extra validations for changing the name of a property
        if (newName !== undefined) {
          if (nft.groupBy !== undefined && nft.groupBy.length > 0) {
            if (!api.assert(!nft.groupBy.includes(name), 'cannot change data property name; property is part of groupBy')) {
              return false;
            }
          }
          if (!api.assert(newName !== name, 'new name must be different from old name')
            || !api.assert(!(newName in nft.properties), 'there is already a data property with the given new name')) {
            return false;
          }
        }

        let shouldUpdate = false;
        const originalType = nft.properties[name].type;
        const originalIsReadOnly = nft.properties[name].isReadOnly;
        if (type !== undefined && type !== originalType) {
          nft.properties[name].type = type;
          shouldUpdate = true;
        }
        if (isReadOnly !== undefined && isReadOnly !== originalIsReadOnly) {
          nft.properties[name].isReadOnly = isReadOnly;
          shouldUpdate = true;
        }
        if (newName !== undefined && newName !== name) {
          nft.properties[newName] = nft.properties[name];
          delete nft.properties[name];
          shouldUpdate = true;
        }

        if (shouldUpdate) {
          await api.db.update('nfts', nft);

          api.emit('updatePropertyDefinition', {
            symbol, originalName: name, originalType, originalIsReadOnly, newName, newType: type, newIsReadOnly: isReadOnly,
          });
        }

        return true;
      }
    }
  }
  return false;
};

actions.addProperty = async (payload) => {
  const {
    symbol, name, type, isReadOnly, authorizedEditingAccounts, authorizedEditingContracts, isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const {
    dataPropertyCreationFee,
  } = params;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
    && name && typeof name === 'string'
    && (isReadOnly === undefined || typeof isReadOnly === 'boolean')
    && (authorizedEditingAccounts === undefined || (authorizedEditingAccounts && typeof authorizedEditingAccounts === 'object' && Array.isArray(authorizedEditingAccounts)))
    && (authorizedEditingContracts === undefined || (authorizedEditingContracts && typeof authorizedEditingContracts === 'object' && Array.isArray(authorizedEditingContracts)))
    && type && typeof type === 'string', 'invalid params')
    && api.assert(api.validator.isAlphanumeric(name) && name.length > 0 && name.length <= 25, 'invalid name: letters & numbers only, max length of 25')
    && api.assert(type === 'number' || type === 'string' || type === 'boolean', 'invalid type: must be number, string, or boolean')) {
    // check if the NFT exists
    const nft = await api.db.findOne('nfts', { symbol });

    if (nft) {
      if (api.assert(!(name in nft.properties), 'cannot add the same property twice')
        && api.assert(nft.issuer === api.sender, 'must be the issuer')) {
        const propertyCount = Object.keys(nft.properties).length;
        if (propertyCount >= 3) {
          // first 3 properties are free, after that you need to pay the fee for each additional property
          const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', {
            account: api.sender, symbol: UTILITY_TOKEN_SYMBOL,
          });
          const authorizedCreation = api.BigNumber(dataPropertyCreationFee).lte(0)
            ? true
            : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(dataPropertyCreationFee);

          if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fees')) {
            if (api.BigNumber(dataPropertyCreationFee).gt(0)) {
              const res = await api.executeSmartContract('tokens', 'transfer', {
                to: 'null', symbol: UTILITY_TOKEN_SYMBOL, quantity: dataPropertyCreationFee, isSignedWithActiveKey,
              });
              // check if the tokens were sent
              if (!isTokenTransferVerified(res, api.sender, 'null', UTILITY_TOKEN_SYMBOL, dataPropertyCreationFee, 'transfer')) {
                return false;
              }
            }
          } else {
            return false;
          }
        }

        const finalIsReadOnly = isReadOnly === undefined ? false : isReadOnly;
        const initialAccountList = authorizedEditingAccounts === undefined ? [api.sender] : [];

        const newProperty = {
          type,
          isReadOnly: finalIsReadOnly,
          authorizedEditingAccounts: initialAccountList,
          authorizedEditingContracts: [],
        };

        nft.properties[name] = newProperty;
        await api.db.update('nfts', nft);

        // optionally can add list of authorized accounts & contracts now
        if (authorizedEditingAccounts || authorizedEditingContracts) {
          await actions.setPropertyPermissions({
            symbol, name, accounts: authorizedEditingAccounts, contracts: authorizedEditingContracts, isSignedWithActiveKey,
          });
        }
        return true;
      }
    }
  }
  return false;
};

actions.setPropertyPermissions = async (payload) => {
  const {
    symbol, name, accounts, contracts, isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
    && name && typeof name === 'string'
    && (accounts === undefined || (accounts && typeof accounts === 'object' && Array.isArray(accounts)))
    && (contracts === undefined || (contracts && typeof contracts === 'object' && Array.isArray(contracts))), 'invalid params')
    && api.assert(api.validator.isAlphanumeric(name) && name.length > 0 && name.length <= 25, 'invalid name: letters & numbers only, max length of 25')
    && api.assert(accounts === undefined || accounts.length <= MAX_NUM_AUTHORIZED_ISSUERS, `cannot have more than ${MAX_NUM_AUTHORIZED_ISSUERS} authorized accounts`)
    && api.assert(contracts === undefined || contracts.length <= MAX_NUM_AUTHORIZED_ISSUERS, `cannot have more than ${MAX_NUM_AUTHORIZED_ISSUERS} authorized contracts`)
    && api.assert(accounts === undefined || isValidAccountsArray(accounts), 'invalid account list')
    && api.assert(contracts === undefined || isValidContractsArray(contracts), 'invalid contract list')) {
    // check if the NFT exists
    const nft = await api.db.findOne('nfts', { symbol });

    if (nft) {
      if (api.assert(name in nft.properties, 'property must exist')
        && api.assert(nft.issuer === api.sender, 'must be the issuer')) {
        let sanitizedAccountList = [];
        let sanitizedContractList = [];

        if (accounts) {
          sanitizedAccountList = accounts.map(account => account.trim().toLowerCase());
        }
        if (contracts) {
          sanitizedContractList = contracts.map(contract => contract.trim());
        }

        if (api.assert(accounts === undefined || !containsDuplicates(sanitizedAccountList), 'cannot add the same account twice')
          && api.assert(contracts === undefined || !containsDuplicates(sanitizedContractList), 'cannot add the same contract twice')) {
          let shouldUpdate = false;
          if (accounts) {
            nft.properties[name].authorizedEditingAccounts = sanitizedAccountList;
            shouldUpdate = true;
          }
          if (contracts) {
            nft.properties[name].authorizedEditingContracts = sanitizedContractList;
            shouldUpdate = true;
          }
          if (shouldUpdate) {
            await api.db.update('nfts', nft);
          }
        }
      }
    }
  }
};

actions.setGroupBy = async (payload) => {
  const {
    symbol, properties, isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
    && properties && typeof properties === 'object' && Array.isArray(properties), 'invalid params')) {
    // check if the NFT exists
    const nft = await api.db.findOne('nfts', { symbol });

    if (nft) {
      const nftPropertyCount = Object.keys(nft.properties).length;
      if (api.assert(nft.issuer === api.sender, 'must be the issuer')
        && api.assert(nft.groupBy === undefined || nft.groupBy.length === 0, 'list is already set')
        && api.assert(properties.length <= nftPropertyCount, 'cannot set more data properties than NFT has')
        && api.assert(!containsDuplicates(properties), 'list cannot contain duplicates')) {
        for (let i = 0; i < properties.length; i += 1) {
          const name = properties[i];
          if (!api.assert(name && typeof name === 'string'
            && name in nft.properties, 'data property must exist')) {
            return false;
          }
        }

        nft.groupBy = properties;
        await api.db.update('nfts', nft);
        return true;
      }
    }
  }
  return false;
};

actions.setProperties = async (payload) => {
  const {
    symbol, fromType, nfts, callingContractInfo,
  } = payload;
  const types = ['user', 'contract'];

  const finalFromType = fromType === undefined ? 'user' : fromType;

  if (api.assert(nfts && typeof nfts === 'object' && Array.isArray(nfts)
    && finalFromType && typeof finalFromType === 'string' && types.includes(finalFromType)
    && symbol && typeof symbol === 'string'
    && (callingContractInfo || (callingContractInfo === undefined && finalFromType === 'user')), 'invalid params')
    && api.assert(nfts.length <= MAX_NUM_NFTS_EDITABLE, `cannot set properties on more than ${MAX_NUM_NFTS_EDITABLE} NFT instances at once`)) {
    const finalFrom = finalFromType === 'user' ? api.sender : callingContractInfo.name;
    // check if the NFT exists
    const nft = await api.db.findOne('nfts', { symbol });

    if (api.assert(nft !== null, 'symbol does not exist')) {
      if (!isValidDataPropertiesArray(finalFrom, finalFromType, nft, nfts)) {
        return false;
      }
      // eslint-disable-next-line prefer-template
      const instanceTableName = symbol + 'instances';
      for (let i = 0; i < nfts.length; i += 1) {
        const { id, properties } = nfts[i];
        if (Object.keys(properties).length === 0) {
          // eslint-disable-next-line no-continue
          continue; // don't bother processing empty properties
        }

        const nftInstance = await api.db.findOne(instanceTableName, { _id: api.BigNumber(id).toNumber() });
        if (api.assert(nftInstance !== null, 'nft instance does not exist')) {
          let shouldUpdate = false;
          // eslint-disable-next-line no-restricted-syntax
          for (const [name, data] of Object.entries(properties)) {
            const propertySchema = nft.properties[name];
            if (propertySchema.isReadOnly) {
              // read-only properties can only be set once
              if (api.assert(!(name in nftInstance.properties), 'cannot edit read-only properties')) {
                nftInstance.properties[name] = data;
                shouldUpdate = true;
              }
            } else {
              nftInstance.properties[name] = data;
              shouldUpdate = true;
            }
          }
          if (shouldUpdate) {
            await api.db.update(instanceTableName, nftInstance);
          }
        }
      }

      return true;
    }
  }
  return false;
};

actions.burn = async (payload) => {
  const {
    fromType, nfts, isSignedWithActiveKey, callingContractInfo,
  } = payload;
  const types = ['user', 'contract'];

  const finalFromType = fromType === undefined ? 'user' : fromType;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(finalFromType && typeof finalFromType === 'string' && types.includes(finalFromType)
    && (callingContractInfo || (callingContractInfo === undefined && finalFromType === 'user'))
    && nfts && typeof nfts === 'object' && Array.isArray(nfts), 'invalid params')
    && isValidNftIdArray(nfts)) {
    const finalFrom = finalFromType === 'user' ? api.sender : callingContractInfo.name;

    let containerCount = 0;
    let tokenCount = 0;
    let isFirstInstanceContainer = false;
    for (let i = 0; i < nfts.length; i += 1) {
      const { symbol, ids } = nfts[i];
      // check if the NFT exists
      const nft = await api.db.findOne('nfts', { symbol });
      if (nft) {
        // eslint-disable-next-line prefer-template
        const instanceTableName = symbol + 'instances';
        for (let j = 0; j < ids.length; j += 1) {
          const id = ids[j];
          const nftInstance = await api.db.findOne(instanceTableName, { _id: api.BigNumber(id).toNumber() });
          if (nftInstance) {
            // can't mix container and non-container NFT instances, also
            // limit how many container NFT instances can be burned at once
            let isBurnAuthorized = true;
            if (nftInstance.lockedNfts && nftInstance.lockedNfts.length > 0) {
              if (tokenCount === 0) {
                isFirstInstanceContainer = true;
              }
              containerCount += 1;
              if (containerCount > MAX_NUM_CONTAINER_NFTS_OPERABLE || !isFirstInstanceContainer) {
                isBurnAuthorized = false;
              }
            } else if (isFirstInstanceContainer) {
              isBurnAuthorized = false;
            }
            tokenCount += 1;

            // verify action is being performed by the account that owns this instance
            // and there is no existing delegation and container restrictions are satisfied
            if (nftInstance.account === finalFrom
              && ((nftInstance.ownedBy === 'u' && finalFromType === 'user')
              || (nftInstance.ownedBy === 'c' && finalFromType === 'contract'))
              && nftInstance.delegatedTo === undefined
              && isBurnAuthorized) {
              // release any locked tokens back to the owning account
              const finalLockTokens = {};
              let isTransferSuccess = true;
              // eslint-disable-next-line no-restricted-syntax
              for (const [locksymbol, quantity] of Object.entries(nftInstance.lockedTokens)) {
                const res = await api.transferTokens(finalFrom, locksymbol, quantity, finalFromType);
                if (!isTokenTransferVerified(res, 'nft', finalFrom, locksymbol, quantity, 'transferFromContract')) {
                  finalLockTokens[locksymbol] = quantity;
                  isTransferSuccess = false;
                }
              }
              api.assert(isTransferSuccess, `unable to release locked tokens in: ${symbol}, id ${id}`);
              // release any locked NFT instances back to the owning account
              const origLockNfts = (nftInstance.lockedNfts && nftInstance.lockedNfts.length > 0) ? nftInstance.lockedNfts : [];
              if (isTransferSuccess && nftInstance.lockedNfts && nftInstance.lockedNfts.length > 0) {
                const res = await transferAndVerifyNfts(CONTRACT_NAME, 'contract', finalFrom, finalFromType, nftInstance.lockedNfts, isSignedWithActiveKey, { name: CONTRACT_NAME });
                nftInstance.lockedNfts = res.fail;
                if (nftInstance.lockedNfts.length > 0) {
                  isTransferSuccess = false;
                }
                api.assert(isTransferSuccess, `unable to release locked NFT instances in: ${symbol}, id ${id}`);
              }
              const origOwnedBy = nftInstance.ownedBy;
              const origLockTokens = nftInstance.lockedTokens;
              nftInstance.lockedTokens = finalLockTokens;
              if (isTransferSuccess) {
                nftInstance.previousAccount = nftInstance.account;
                nftInstance.previousOwnedBy = nftInstance.ownedBy;
                nftInstance.account = 'null';
                nftInstance.ownedBy = 'u';
                nft.circulatingSupply -= 1;
              }

              await api.db.update(instanceTableName, nftInstance);
              if (isTransferSuccess) {
                api.emit('burn', {
                  account: finalFrom, ownedBy: origOwnedBy, unlockedTokens: origLockTokens, unlockedNfts: origLockNfts, symbol, id,
                });
              }
            }
          }
        }

        // make sure circulating supply is updated
        await api.db.update('nfts', nft);
      }
    }
  }
};

actions.transfer = async (payload) => {
  const {
    fromType, to, toType, nfts, isSignedWithActiveKey, callingContractInfo,
  } = payload;
  const types = ['user', 'contract'];

  const finalToType = toType === undefined ? 'user' : toType;
  const finalFromType = fromType === undefined ? 'user' : fromType;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(finalFromType && typeof finalFromType === 'string' && types.includes(finalFromType)
    && to && typeof to === 'string'
    && finalToType && typeof finalToType === 'string' && types.includes(finalToType)
    && (callingContractInfo || (callingContractInfo === undefined && finalFromType === 'user'))
    && nfts && typeof nfts === 'object' && Array.isArray(nfts), 'invalid params')
    && isValidNftIdArray(nfts)) {
    const finalTo = finalToType === 'user' ? to.trim().toLowerCase() : to.trim();
    const toValid = finalToType === 'user' ? isValidSteemAccountLength(finalTo) : isValidContractLength(finalTo);
    const finalFrom = finalFromType === 'user' ? api.sender : callingContractInfo.name;

    if (api.assert(toValid, 'invalid to')
      && api.assert(!(finalToType === finalFromType && finalTo === finalFrom), 'cannot transfer to self')
      && api.assert(!(finalToType === 'user' && finalTo === 'null'), 'cannot transfer to null; use burn action instead')) {
      for (let i = 0; i < nfts.length; i += 1) {
        const { symbol, ids } = nfts[i];
        // check if the NFT exists
        const nft = await api.db.findOne('nfts', { symbol });
        if (nft) {
          // eslint-disable-next-line prefer-template
          const instanceTableName = symbol + 'instances';
          for (let j = 0; j < ids.length; j += 1) {
            const id = ids[j];
            const nftInstance = await api.db.findOne(instanceTableName, { _id: api.BigNumber(id).toNumber() });
            if (nftInstance) {
              // verify action is being performed by the account that owns this instance
              // and there is no existing delegation
              if (nftInstance.account === finalFrom
                && ((nftInstance.ownedBy === 'u' && finalFromType === 'user')
                || (nftInstance.ownedBy === 'c' && finalFromType === 'contract'))
                && nftInstance.delegatedTo === undefined) {
                const origOwnedBy = nftInstance.ownedBy;
                const newOwnedBy = finalToType === 'user' ? 'u' : 'c';

                nftInstance.previousAccount = nftInstance.account;
                nftInstance.previousOwnedBy = nftInstance.ownedBy;
                nftInstance.account = finalTo;
                nftInstance.ownedBy = newOwnedBy;

                await api.db.update(instanceTableName, nftInstance);

                api.emit('transfer', {
                  from: finalFrom, fromType: origOwnedBy, to: finalTo, toType: newOwnedBy, symbol, id,
                });
              }
            }
          }
        }
      }
    }
  }
};

actions.delegate = async (payload) => {
  const {
    fromType, to, toType, nfts, isSignedWithActiveKey, callingContractInfo,
  } = payload;
  const types = ['user', 'contract'];

  const finalToType = toType === undefined ? 'user' : toType;
  const finalFromType = fromType === undefined ? 'user' : fromType;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(finalFromType && typeof finalFromType === 'string' && types.includes(finalFromType)
    && to && typeof to === 'string'
    && finalToType && typeof finalToType === 'string' && types.includes(finalToType)
    && (callingContractInfo || (callingContractInfo === undefined && finalFromType === 'user'))
    && nfts && typeof nfts === 'object' && Array.isArray(nfts), 'invalid params')
    && isValidNftIdArray(nfts)) {
    const finalTo = finalToType === 'user' ? to.trim().toLowerCase() : to.trim();
    const toValid = finalToType === 'user' ? isValidSteemAccountLength(finalTo) : isValidContractLength(finalTo);
    const finalFrom = finalFromType === 'user' ? api.sender : callingContractInfo.name;

    if (api.assert(toValid, 'invalid to')
      && api.assert(!(finalToType === finalFromType && finalTo === finalFrom), 'cannot delegate to self')
      && api.assert(!(finalToType === 'user' && finalTo === 'null'), 'cannot delegate to null')) {
      for (let i = 0; i < nfts.length; i += 1) {
        const { symbol, ids } = nfts[i];
        // check if the NFT exists
        const nft = await api.db.findOne('nfts', { symbol });
        if (nft) {
          if (api.assert(nft.delegationEnabled === true, `delegation not enabled for ${symbol}`)) {
            // eslint-disable-next-line prefer-template
            const instanceTableName = symbol + 'instances';
            for (let j = 0; j < ids.length; j += 1) {
              const id = ids[j];
              const nftInstance = await api.db.findOne(instanceTableName, { _id: api.BigNumber(id).toNumber() });
              if (nftInstance) {
                // verify action is being performed by the account that owns this instance
                // and there is no existing delegation
                if (nftInstance.account === finalFrom
                  && ((nftInstance.ownedBy === 'u' && finalFromType === 'user')
                  || (nftInstance.ownedBy === 'c' && finalFromType === 'contract'))
                  && nftInstance.delegatedTo === undefined) {
                  const newOwnedBy = finalToType === 'user' ? 'u' : 'c';

                  const newDelegation = {
                    account: finalTo,
                    ownedBy: newOwnedBy,
                  };

                  nftInstance.delegatedTo = newDelegation;

                  await api.db.update(instanceTableName, nftInstance);

                  api.emit('delegate', {
                    from: finalFrom, fromType: nftInstance.ownedBy, to: finalTo, toType: newOwnedBy, symbol, id,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
};

actions.undelegate = async (payload) => {
  const {
    fromType, nfts, isSignedWithActiveKey, callingContractInfo,
  } = payload;
  const types = ['user', 'contract'];

  const finalFromType = fromType === undefined ? 'user' : fromType;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(finalFromType && typeof finalFromType === 'string' && types.includes(finalFromType)
    && (callingContractInfo || (callingContractInfo === undefined && finalFromType === 'user'))
    && nfts && typeof nfts === 'object' && Array.isArray(nfts), 'invalid params')
    && isValidNftIdArray(nfts)) {
    const finalFrom = finalFromType === 'user' ? api.sender : callingContractInfo.name;
    const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);

    for (let i = 0; i < nfts.length; i += 1) {
      const { symbol, ids } = nfts[i];
      // check if the NFT exists
      const nft = await api.db.findOne('nfts', { symbol });
      if (nft) {
        if (api.assert(nft.delegationEnabled === true, `delegation not enabled for ${symbol}`)) {
          // calculate the undelegation completion time
          const cooldownPeriodMillisec = nft.undelegationCooldown * 24 * 3600 * 1000;
          const completeTimestamp = blockDate.getTime() + cooldownPeriodMillisec;
          // eslint-disable-next-line prefer-template
          const instanceTableName = symbol + 'instances';

          const undelegation = {
            symbol,
            ids: [],
            completeTimestamp,
          };

          for (let j = 0; j < ids.length; j += 1) {
            const id = ids[j];
            const nftInstance = await api.db.findOne(instanceTableName, { _id: api.BigNumber(id).toNumber() });
            if (nftInstance) {
              // verify action is being performed by the account that owns this instance
              // and there is an existing delegation that is not pending undelegation
              if (nftInstance.account === finalFrom
                && ((nftInstance.ownedBy === 'u' && finalFromType === 'user')
                || (nftInstance.ownedBy === 'c' && finalFromType === 'contract'))
                && nftInstance.delegatedTo
                && nftInstance.delegatedTo.undelegateAt === undefined) {
                nftInstance.delegatedTo.undelegateAt = completeTimestamp;
                // eslint-disable-next-line no-underscore-dangle
                undelegation.ids.push(nftInstance._id);

                await api.db.update(instanceTableName, nftInstance);

                api.emit('undelegateStart', {
                  from: nftInstance.delegatedTo.account, fromType: nftInstance.delegatedTo.ownedBy, symbol, id,
                });
              }
            }
          }

          if (undelegation.ids.length > 0) {
            await api.db.insert('pendingUndelegations', undelegation);
          }
        }
      }
    }
  }
};

const processUndelegation = async (undelegation) => {
  const {
    symbol,
    ids,
  } = undelegation;

  // eslint-disable-next-line prefer-template
  const instanceTableName = symbol + 'instances';

  const instances = await api.db.find(
    instanceTableName,
    {
      _id: {
        $in: ids,
      },
    },
    MAX_NUM_NFTS_OPERABLE,
    0,
    [{ index: '_id', descending: false }],
  );

  // remove the delegation information from each NFT instance
  for (let i = 0; i < instances.length; i += 1) {
    delete instances[i].delegatedTo;
    await api.db.update(instanceTableName, instances[i], { delegatedTo: '' });
  }

  // remove the pending undelegation itself
  await api.db.remove('pendingUndelegations', undelegation);

  api.emit('undelegateDone', { symbol, ids });
};

actions.checkPendingUndelegations = async () => {
  if (api.assert(api.sender === 'null', 'not authorized')) {
    const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);
    const timestamp = blockDate.getTime();

    // get all the pending undelegations that are ready to be released
    let pendingUndelegations = await api.db.find(
      'pendingUndelegations',
      {
        completeTimestamp: {
          $lte: timestamp,
        },
      },
    );

    let nbPendingUndelegations = pendingUndelegations.length;
    while (nbPendingUndelegations > 0) {
      for (let index = 0; index < nbPendingUndelegations; index += 1) {
        const pendingUndelegation = pendingUndelegations[index];
        await processUndelegation(pendingUndelegation);
      }

      pendingUndelegations = await api.db.find(
        'pendingUndelegations',
        {
          completeTimestamp: {
            $lte: timestamp,
          },
        },
      );

      nbPendingUndelegations = pendingUndelegations.length;
    }
  }
};

actions.create = async (payload) => {
  const {
    name, orgName, productName, symbol, url, maxSupply, authorizedIssuingAccounts, authorizedIssuingContracts, isSignedWithActiveKey,
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
      && (orgName === undefined || (orgName && typeof orgName === 'string'))
      && (productName === undefined || (productName && typeof productName === 'string'))
      && (authorizedIssuingAccounts === undefined || (authorizedIssuingAccounts && typeof authorizedIssuingAccounts === 'object' && Array.isArray(authorizedIssuingAccounts)))
      && (authorizedIssuingContracts === undefined || (authorizedIssuingContracts && typeof authorizedIssuingContracts === 'object' && Array.isArray(authorizedIssuingContracts)))
      && (maxSupply === undefined || (maxSupply && typeof maxSupply === 'string' && !api.BigNumber(maxSupply).isNaN())), 'invalid params')) {
    if (api.assert(api.validator.isAlpha(symbol) && api.validator.isUppercase(symbol) && symbol.length > 0 && symbol.length <= MAX_SYMBOL_LENGTH, `invalid symbol: uppercase letters only, max length of ${MAX_SYMBOL_LENGTH}`)
      && api.assert(api.validator.isAlphanumeric(api.validator.blacklist(name, ' ')) && name.length > 0 && name.length <= 50, 'invalid name: letters, numbers, whitespaces only, max length of 50')
      && api.assert(orgName === undefined
      || (api.validator.isAlphanumeric(api.validator.blacklist(orgName, ' ')) && orgName.length > 0 && orgName.length <= 50), 'invalid org name: letters, numbers, whitespaces only, max length of 50')
      && api.assert(productName === undefined
      || (api.validator.isAlphanumeric(api.validator.blacklist(productName, ' ')) && productName.length > 0 && productName.length <= 50), 'invalid product name: letters, numbers, whitespaces only, max length of 50')
      && api.assert(url === undefined || url.length <= 255, 'invalid url: max length of 255')
      && api.assert(maxSupply === undefined || api.BigNumber(maxSupply).gt(0), 'maxSupply must be positive')
      && api.assert(maxSupply === undefined || api.BigNumber(maxSupply).lte(Number.MAX_SAFE_INTEGER), `maxSupply must be lower than ${Number.MAX_SAFE_INTEGER}`)) {
      // check if the NFT already exists
      const nft = await api.db.findOne('nfts', { symbol });

      if (api.assert(nft === null, 'symbol already exists')) {
        // burn the token creation fees
        if (api.BigNumber(nftCreationFee).gt(0)) {
          const res = await api.executeSmartContract('tokens', 'transfer', {
            to: 'null', symbol: UTILITY_TOKEN_SYMBOL, quantity: nftCreationFee, isSignedWithActiveKey,
          });
          // check if the tokens were sent
          if (!isTokenTransferVerified(res, api.sender, 'null', UTILITY_TOKEN_SYMBOL, nftCreationFee, 'transfer')) {
            return false;
          }
        }

        const finalMaxSupply = maxSupply === undefined ? 0 : api.BigNumber(maxSupply).integerValue(api.BigNumber.ROUND_DOWN).toNumber();
        const finalOrgName = orgName === undefined ? '' : orgName;
        const finalProductName = productName === undefined ? '' : productName;
        const finalUrl = url === undefined ? '' : url;
        let metadata = {
          url: finalUrl,
        };
        metadata = JSON.stringify(metadata);

        const initialAccountList = authorizedIssuingAccounts === undefined ? [api.sender] : [];

        const newNft = {
          issuer: api.sender,
          symbol,
          name,
          orgName: finalOrgName,
          productName: finalProductName,
          metadata,
          maxSupply: finalMaxSupply,
          supply: 0,
          circulatingSupply: 0,
          delegationEnabled: false,
          undelegationCooldown: 0,
          authorizedIssuingAccounts: initialAccountList,
          authorizedIssuingContracts: [],
          properties: {},
          groupBy: [],
        };

        // create a new table to hold issued instances of this NFT
        // eslint-disable-next-line prefer-template
        const instanceTableName = symbol + 'instances';
        const tableExists = await api.db.tableExists(instanceTableName);
        if (tableExists === false) {
          await api.db.createTable(instanceTableName, ['account', 'ownedBy']);
        }

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

actions.issue = async (payload) => {
  const {
    symbol, fromType, to, toType, feeSymbol, lockTokens, lockNfts, properties, isSignedWithActiveKey, callingContractInfo,
  } = payload;
  const types = ['user', 'contract'];

  const finalToType = toType === undefined ? 'user' : toType;
  const finalFromType = fromType === undefined ? 'user' : fromType;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { nftIssuanceFee } = params;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
    && finalFromType && typeof finalFromType === 'string' && types.includes(finalFromType)
    && (callingContractInfo || (callingContractInfo === undefined && finalFromType === 'user'))
    && to && typeof to === 'string'
    && finalToType && typeof finalToType === 'string' && types.includes(finalToType)
    && feeSymbol && typeof feeSymbol === 'string' && feeSymbol in nftIssuanceFee
    && (properties === undefined || (properties && typeof properties === 'object'))
    && (lockTokens === undefined || (lockTokens && typeof lockTokens === 'object'))
    && (lockNfts === undefined || (lockNfts && typeof lockNfts === 'object' && Array.isArray(lockNfts))), 'invalid params')
    && (lockNfts === undefined || isValidNftIdArray(lockNfts))) {
    const finalTo = finalToType === 'user' ? to.trim().toLowerCase() : to.trim();
    const toValid = finalToType === 'user' ? isValidSteemAccountLength(finalTo) : isValidContractLength(finalTo);
    const finalFrom = finalFromType === 'user' ? api.sender : callingContractInfo.name;
    const balanceTableName = finalFromType === 'user' ? 'balances' : 'contractsBalances';
    if (api.assert(toValid, 'invalid to')) {
      // check if the NFT and fee token exist
      const nft = await api.db.findOne('nfts', { symbol });
      const feeToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: feeSymbol });

      if (api.assert(nft !== null, 'symbol does not exist')
        && api.assert(feeToken !== null, 'fee symbol does not exist')) {
        // eslint-disable-next-line prefer-template
        const instanceTableName = symbol + 'instances';
        // verify caller has authority to issue this NFT & we have not reached max supply
        if (api.assert((finalFromType === 'contract' && nft.authorizedIssuingContracts.includes(finalFrom))
          || (finalFromType === 'user' && nft.authorizedIssuingAccounts.includes(finalFrom)), 'not allowed to issue tokens')
          && api.assert(nft.maxSupply === 0 || (nft.supply < nft.maxSupply), 'max supply limit reached')) {
          // calculate the cost of issuing this NFT
          const propertyCount = Object.keys(nft.properties).length;
          const propertyFee = api.BigNumber(nftIssuanceFee[feeSymbol]).multipliedBy(propertyCount); // extra fees per property
          const issuanceFee = calculateBalance(nftIssuanceFee[feeSymbol], propertyFee, feeToken.precision, true); // base fee + property fees
          const feeTokenBalance = await api.db.findOneInTable('tokens', balanceTableName, { account: finalFrom, symbol: feeSymbol });
          const authorizedCreation = api.BigNumber(issuanceFee).lte(0)
            ? true
            : feeTokenBalance && api.BigNumber(feeTokenBalance.balance).gte(issuanceFee);
          // sanity checks on any tokens the issuer wants to lock up in this NFT
          if (lockTokens) {
            const isLockValid = await isValidTokenBasket(lockTokens, balanceTableName, finalFrom, feeSymbol, issuanceFee);
            if (!api.assert(isLockValid,
              `invalid basket of tokens to lock (cannot lock more than ${MAX_NUM_LOCKED_TOKEN_TYPES} token types; issuing account must have enough balance)`)) {
              return false;
            }
          }

          // ensure any included data properties are valid
          let finalProperties = {};
          if (!(properties === undefined)) {
            try {
              if (!isValidDataProperties(finalFrom, finalFromType, nft, properties)) {
                return false;
              }
            } catch (e) {
              return false;
            }
            finalProperties = properties;
          }

          if (api.assert(authorizedCreation, 'you must have enough tokens to cover the issuance fees')) {
            // burn the token issuance fees
            if (api.BigNumber(issuanceFee).gt(0)) {
              if (finalFromType === 'contract') {
                const res = await api.transferTokensFromCallingContract('null', feeSymbol, issuanceFee, 'user');
                if (!api.assert(isTokenTransferVerified(res, finalFrom, 'null', feeSymbol, issuanceFee, 'transferFromContract'), 'unable to transfer issuance fee')) {
                  return false;
                }
              } else {
                const res = await api.executeSmartContract('tokens', 'transfer', {
                  to: 'null', symbol: feeSymbol, quantity: issuanceFee, isSignedWithActiveKey,
                });
                if (!api.assert(isTokenTransferVerified(res, finalFrom, 'null', feeSymbol, issuanceFee, 'transfer'), 'unable to transfer issuance fee')) {
                  return false;
                }
              }
            }

            // any locked tokens should be sent to the nft contract for custodianship
            const finalLockTokens = {};
            if (lockTokens) {
              // eslint-disable-next-line no-restricted-syntax
              for (const [locksymbol, quantity] of Object.entries(lockTokens)) {
                if (finalFromType === 'contract') {
                  const res = await api.transferTokensFromCallingContract(CONTRACT_NAME, locksymbol, quantity, 'contract');
                  if (isTokenTransferVerified(res, finalFrom, CONTRACT_NAME, locksymbol, quantity, 'transferFromContract')) {
                    finalLockTokens[locksymbol] = quantity;
                  }
                } else {
                  const res = await api.executeSmartContract('tokens', 'transferToContract', {
                    to: CONTRACT_NAME, symbol: locksymbol, quantity, isSignedWithActiveKey,
                  });
                  if (isTokenTransferVerified(res, finalFrom, CONTRACT_NAME, locksymbol, quantity, 'transferToContract')) {
                    finalLockTokens[locksymbol] = quantity;
                  }
                }
              }
            }

            // any locked NFT instances should be sent to the nft contract for custodianship
            let finalLockNfts = [];
            if (lockNfts && lockNfts.length > 0) {
              const res = await transferAndVerifyNfts(finalFrom, finalFromType, CONTRACT_NAME, 'contract', lockNfts, isSignedWithActiveKey, callingContractInfo);
              finalLockNfts = res.success;
            }

            const ownedBy = finalToType === 'user' ? 'u' : 'c';

            // finally, we can issue the NFT!
            let newInstance = {};
            if (finalLockNfts.length > 0) {
              newInstance = {
                account: finalTo,
                ownedBy,
                lockedTokens: finalLockTokens,
                lockedNfts: finalLockNfts,
                properties: finalProperties,
              };
            } else {
              newInstance = {
                account: finalTo,
                ownedBy,
                lockedTokens: finalLockTokens,
                properties: finalProperties,
              };
            }

            const result = await api.db.insert(instanceTableName, newInstance);

            // update supply and circulating supply for main NFT record
            nft.supply += 1;
            if (finalTo !== 'null' || finalToType === 'contract') {
              nft.circulatingSupply += 1;
            }
            await api.db.update('nfts', nft);

            api.emit('issue', {
              // eslint-disable-next-line no-underscore-dangle
              from: finalFrom, fromType: finalFromType, to: finalTo, toType: finalToType, symbol, lockedTokens: finalLockTokens, lockedNfts: finalLockNfts, properties: finalProperties, id: result._id,
            });
            return true;
          }
        }
      }
    }
  }
  return false;
};

actions.issueMultiple = async (payload) => {
  const {
    instances, isSignedWithActiveKey, callingContractInfo,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(instances && typeof instances === 'object' && Array.isArray(instances), 'invalid params')
    && api.assert(instances.length <= MAX_NUM_NFTS_ISSUABLE, `cannot issue more than ${MAX_NUM_NFTS_ISSUABLE} NFT instances at once`)) {
    // additional check for locked NFT instances
    let containerCount = 0;
    instances.forEach((instance) => {
      if (instance.lockNfts) {
        containerCount += 1;
      }
    });

    if (api.assert(containerCount <= MAX_NUM_CONTAINER_NFTS_OPERABLE, `cannot issue more than ${MAX_NUM_CONTAINER_NFTS_OPERABLE} container NFT instances at once`)
      && api.assert(containerCount === 0 || containerCount === instances.length, 'cannot issue a mix of container and non-container NFT instances simultaneously')) {
      // do the issuance
      for (let i = 0; i < instances.length; i += 1) {
        const {
          symbol, fromType, to, toType, feeSymbol, lockTokens, lockNfts, properties,
        } = instances[i];
        await actions.issue({
          symbol, fromType, to, toType, feeSymbol, lockTokens, lockNfts, properties, isSignedWithActiveKey, callingContractInfo,
        });
      }
    }
  }
};
