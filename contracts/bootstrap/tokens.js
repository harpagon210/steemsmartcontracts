/* eslint-disable */

//const actions = {}
//const api = {}

actions.createSSC = async (payload) => {
  let tableExists = await api.db.tableExists('tokens');
  if (tableExists === false) {
    await api.db.createTable('tokens', ['symbol']);
    await api.db.createTable('balances', ['account']);
    await api.db.createTable('contractsBalances', ['account']);
    await api.db.createTable('params');

    const params = {};
    params.tokenCreationFee = '0';
    await api.db.insert('params', params);
  }

  tableExists = await api.db.tableExists('pendingUnstakes');
  if (tableExists === false) {
    await api.db.createTable('pendingUnstakes', ['account', 'unstakeCompleteTimestamp']);
  }
};

actions.updateParams = async (payload) => {
  if (api.sender !== api.owner) return;

  const { tokenCreationFee } = payload;

  const params = await api.db.findOne('params', {});

  params.tokenCreationFee = typeof tokenCreationFee === 'number' ? tokenCreationFee.toFixed('${BP_CONSTANTS.UTILITY_TOKEN_PRECISION}$') : tokenCreationFee;

  await api.db.update('params', params);
};

actions.updateUrl = async (payload) => {
  const { url, symbol } = payload;

  if (api.assert(symbol && typeof symbol === 'string'
    && url && typeof url === 'string', 'invalid params')
    && api.assert(url.length <= 255, 'invalid url: max length of 255')) {
    // check if the token exists
    const token = await api.db.findOne('tokens', { symbol });

    if (token) {
      if (api.assert(token.issuer === api.sender, 'must be the issuer')) {
        try {
          const metadata = JSON.parse(token.metadata);

          if (api.assert(metadata && metadata.url, 'an error occured when trying to update the url')) {
            metadata.url = url;
            token.metadata = JSON.stringify(metadata);
            await api.db.update('tokens', token);
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
    // check if the token exists
    const token = await api.db.findOne('tokens', { symbol });

    if (token) {
      if (api.assert(token.issuer === api.sender, 'must be the issuer')) {

        try {
          const finalMetadata = JSON.stringify(metadata);

          if (api.assert(finalMetadata.length <= 1000, 'invalid metadata: max length of 1000')) {
            token.metadata = finalMetadata;
            await api.db.update('tokens', token);
          }
        } catch (e) {
          // error when stringifying the metadata
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
    // check if the token exists
    let token = await api.db.findOne('tokens', { symbol });

    if (token) {
      if (api.assert(token.issuer === api.sender, 'must be the issuer')) {
        const finalTo = to.trim();

        // a valid steem account is between 3 and 16 characters in length
        if (api.assert(finalTo.length >= 3 && finalTo.length <= 16, 'invalid to')) {
          token.issuer = finalTo
          await api.db.update('tokens', token);
        }
      }
    }
  }
};

const createVOne = async (payload) => {
  const {
    name, symbol, url, precision, maxSupply, isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { tokenCreationFee } = params;

  // get api.sender's UTILITY_TOKEN_SYMBOL balance
  const utilityTokenBalance = await api.db.findOne('balances', { account: api.sender, symbol: "'${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(tokenCreationFee).lte('0') ? true : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(tokenCreationFee);

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fees')
    && api.assert(name && typeof name === 'string'
      && symbol && typeof symbol === 'string'
      && (url === undefined || (url && typeof url === 'string'))
      && ((precision && typeof precision === 'number') || precision === 0)
      && maxSupply && typeof maxSupply === 'number', 'invalid params')) {
    // the precision must be between 0 and 8 and must be an integer
    // the max supply must be positive
    if (api.assert(api.validator.isAlpha(symbol) && api.validator.isUppercase(symbol) && symbol.length > 0 && symbol.length <= 10, 'invalid symbol: uppercase letters only, max length of 10')
      && api.assert(api.validator.isAlphanumeric(api.validator.blacklist(name, ' ')) && name.length > 0 && name.length <= 50, 'invalid name: letters, numbers, whitespaces only, max length of 50')
      && api.assert(url === undefined || url.length <= 255, 'invalid url: max length of 255')
      && api.assert((precision >= 0 && precision <= 8) && (Number.isInteger(precision)), 'invalid precision')
      && api.assert(maxSupply > 0, 'maxSupply must be positive')
      && api.assert(api.blockNumber === 0 || (api.blockNumber > 0 && maxSupply <= 1000000000000), 'maxSupply must be lower than 1000000000000')) {
      // check if the token already exists
      const token = await api.db.findOne('tokens', { symbol });

      if (api.assert(token === null, 'symbol already exists')) {
        const finalUrl = url === undefined ? '' : url;

        let metadata = {
          url: finalUrl,
        };

        metadata = JSON.stringify(metadata);

        const newToken = {
          issuer: api.sender,
          symbol,
          name,
          metadata,
          precision,
          maxSupply,
          supply: 0,
          circulatingSupply: 0,
        };

        await api.db.insert('tokens', newToken);

        // burn the token creation fees
        if (api.BigNumber(tokenCreationFee).gt(0)) {
          await actions.transfer({
            to: 'null', symbol: "'${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: api.BigNumber(tokenCreationFee).toNumber(), isSignedWithActiveKey,
          });
        }
      }
    }
  }
};

const createVTwo = async (payload) => {
  const {
    name, symbol, url, precision, maxSupply, isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { tokenCreationFee } = params;

  // get api.sender's UTILITY_TOKEN_SYMBOL balance
  const utilityTokenBalance = await api.db.findOne('balances', { account: api.sender, symbol: "'${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(tokenCreationFee).lte(0)
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(tokenCreationFee);

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fees')
    && api.assert(name && typeof name === 'string'
      && symbol && typeof symbol === 'string'
      && (url === undefined || (url && typeof url === 'string'))
      && ((precision && typeof precision === 'number') || precision === 0)
      && maxSupply && typeof maxSupply === 'string' && !api.BigNumber(maxSupply).isNaN(), 'invalid params')) {

    // the precision must be between 0 and 8 and must be an integer
    // the max supply must be positive
    if (api.assert(api.validator.isAlpha(symbol) && api.validator.isUppercase(symbol) && symbol.length > 0 && symbol.length <= 10, 'invalid symbol: uppercase letters only, max length of 10')
      && api.assert(api.validator.isAlphanumeric(api.validator.blacklist(name, ' ')) && name.length > 0 && name.length <= 50, 'invalid name: letters, numbers, whitespaces only, max length of 50')
      && api.assert(url === undefined || url.length <= 255, 'invalid url: max length of 255')
      && api.assert((precision >= 0 && precision <= 8) && (Number.isInteger(precision)), 'invalid precision')
      && api.assert(api.BigNumber(maxSupply).gt(0), 'maxSupply must be positive')
      && api.assert(api.BigNumber(maxSupply).lte(Number.MAX_SAFE_INTEGER), 'maxSupply must be lower than ' + Number.MAX_SAFE_INTEGER)) {

      // check if the token already exists
      const token = await api.db.findOne('tokens', { symbol });

      if (api.assert(token === null, 'symbol already exists')) {
        const finalUrl = url === undefined ? '' : url;

        let metadata = {
          url: finalUrl,
        };

        metadata = JSON.stringify(metadata);
        const newToken = {
          issuer: api.sender,
          symbol,
          name,
          metadata,
          precision,
          maxSupply: api.BigNumber(maxSupply).toFixed(precision),
          supply: '0',
          circulatingSupply: '0',
        };

        await api.db.insert('tokens', newToken);

        // burn the token creation fees
        if (api.BigNumber(tokenCreationFee).gt(0)) {
          await actions.transfer({
            to: 'null', symbol: "'${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: tokenCreationFee, isSignedWithActiveKey,
          });
        }
      }
    }
  }
};

actions.create = async (payload) => {
  if (api.refSteemBlockNumber < '${FORK_BLOCK_NUMBER}$') {
    await createVOne(payload);
  } else {
    await createVTwo(payload);
  }
};

const issueVOne = async (payload) => {
  const {
    to, symbol, quantity, isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(to && typeof to === 'string'
      && symbol && typeof symbol === 'string'
      && quantity && typeof quantity === 'number', 'invalid params')) {
    const finalTo = to.trim();

    const token = await api.db.findOne('tokens', { symbol });

    // the symbol must exist
    // the api.sender must be the issuer
    // then we need to check that the quantity is correct
    if (api.assert(token !== null, 'symbol does not exist')
      && api.assert(token.issuer === api.sender, 'not allowed to issue tokens')
      && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
      && api.assert(quantity > 0, 'must issue positive quantity')
      && api.assert(quantity <= (api.BigNumber(token.maxSupply).minus(token.supply).toNumber()), 'quantity exceeds available supply')) {

      // a valid steem account is between 3 and 16 characters in length
      if (api.assert(finalTo.length >= 3 && finalTo.length <= 16, 'invalid to')) {
        // we made all the required verification, let's now issue the tokens

        let res = await addBalanceVOne(token.issuer, token, quantity, 'balances');

        if (res === true && finalTo !== token.issuer) {
          if (await subBalanceVOne(token.issuer, token, quantity, 'balances')) {
            res = await addBalanceVOne(finalTo, token, quantity, 'balances');

            if (res === false) {
              await addBalanceVOne(token.issuer, token, quantity, 'balances');
            }
          }
        }

        if (res === true) {
          token.supply = calculateBalanceVOne(token.supply, quantity, token.precision, true);

          if (finalTo !== 'null') {
            token.circulatingSupply = calculateBalanceVOne(
              token.circulatingSupply, quantity, token.precision, true,
            );
          }

          await api.db.update('tokens', token);

          api.emit('transferFromContract', {
            from: 'tokens', to: finalTo, symbol, quantity,
          });
        }
      }
    }
  }
};

const issueVTwo = async (payload) => {
  const {
    to, symbol, quantity, isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(to && typeof to === 'string'
      && symbol && typeof symbol === 'string'
      && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN(), 'invalid params')) {
    const finalTo = to.trim();
    const token = await api.db.findOne('tokens', { symbol });

    // the symbol must exist
    // the api.sender must be the issuer
    // then we need to check that the quantity is correct
    if (api.assert(token !== null, 'symbol does not exist')
      && api.assert(token.issuer === api.sender, 'not allowed to issue tokens')
      && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
      && api.assert(api.BigNumber(quantity).gt(0), 'must issue positive quantity')
      && api.assert(api.BigNumber(token.maxSupply).minus(token.supply).gte(quantity), 'quantity exceeds available supply')) {

      // a valid steem account is between 3 and 16 characters in length
      if (api.assert(finalTo.length >= 3 && finalTo.length <= 16, 'invalid to')) {
        // we made all the required verification, let's now issue the tokens

        let res = await addBalanceVTwo(token.issuer, token, quantity, 'balances');

        if (res === true && finalTo !== token.issuer) {
          if (await subBalanceVTwo(token.issuer, token, quantity, 'balances')) {
            res = await addBalanceVTwo(finalTo, token, quantity, 'balances');

            if (res === false) {
              await addBalanceVTwo(token.issuer, token, quantity, 'balances');
            }
          }
        }

        if (res === true) {
          token.supply = calculateBalanceVTwo(token.supply, quantity, token.precision, true);

          if (finalTo !== 'null') {
            token.circulatingSupply = calculateBalanceVTwo(
              token.circulatingSupply, quantity, token.precision, true,
            );
          }

          await api.db.update('tokens', token);

          api.emit('transferFromContract', {
            from: 'tokens', to: finalTo, symbol, quantity,
          });
        }
      }
    }
  }
};

actions.issue = async (payload) => {
  if (api.refSteemBlockNumber < '${FORK_BLOCK_NUMBER}$') {
    await issueVOne(payload);
  } else {
    await issueVTwo(payload);
  }
};

const transferVOne = async (payload) => {
  const {
    to, symbol, quantity, isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(to && typeof to === 'string'
      && symbol && typeof symbol === 'string'
      && quantity && typeof quantity === 'number', 'invalid params')) {
    const finalTo = to.trim();
    if (api.assert(finalTo !== api.sender, 'cannot transfer to self')) {
      // a valid steem account is between 3 and 16 characters in length
      if (api.assert(finalTo.length >= 3 && finalTo.length <= 16, 'invalid to')) {
        const token = await api.db.findOne('tokens', { symbol });

        // the symbol must exist
        // then we need to check that the quantity is correct
        if (api.assert(token !== null, 'symbol does not exist')
          && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
          && api.assert(quantity > 0, 'must transfer positive quantity')) {

          if (await subBalanceVOne(api.sender, token, quantity, 'balances')) {
            const res = await addBalanceVOne(finalTo, token, quantity, 'balances');

            if (res === false) {
              await addBalanceVOne(api.sender, token, quantity, 'balances');

              return false;
            }

            if (finalTo === 'null') {
              token.circulatingSupply = calculateBalanceVOne(
                token.circulatingSupply, quantity, token.precision, false,
              );
              await api.db.update('tokens', token);
            }

            api.emit('transfer', {
              from: api.sender, to: finalTo, symbol, quantity,
            });

            return true;
          }
        }
      }
    }
  }

  return false;
};

const transferVTwo = async (payload) => {
  const {
    to, symbol, quantity, isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(to && typeof to === 'string'
      && symbol && typeof symbol === 'string'
      && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN(), 'invalid params')) {
    const finalTo = to.trim();
    if (api.assert(finalTo !== api.sender, 'cannot transfer to self')) {
      // a valid steem account is between 3 and 16 characters in length
      if (api.assert(finalTo.length >= 3 && finalTo.length <= 16, 'invalid to')) {
        const token = await api.db.findOne('tokens', { symbol });

        // the symbol must exist
        // then we need to check that the quantity is correct
        if (api.assert(token !== null, 'symbol does not exist')
          && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
          && api.assert(api.BigNumber(quantity).gt(0), 'must transfer positive quantity')) {
          if (await subBalanceVTwo(api.sender, token, quantity, 'balances')) {
            const res = await addBalanceVTwo(finalTo, token, quantity, 'balances');

            if (res === false) {
              await addBalanceVTwo(api.sender, token, quantity, 'balances');

              return false;
            }

            if (finalTo === 'null') {
              token.circulatingSupply = calculateBalanceVTwo(
                token.circulatingSupply, quantity, token.precision, false,
              );
              await api.db.update('tokens', token);
            }

            api.emit('transfer', {
              from: api.sender, to: finalTo, symbol, quantity,
            });

            return true;
          }
        }
      }
    }
  }

  return false;
};

actions.transfer = async (payload) => {
  if (api.refSteemBlockNumber < '${FORK_BLOCK_NUMBER}$') {
    await transferVOne(payload);
  } else {
    await transferVTwo(payload);
  }
};

actions.transferToContract = async (payload) => {
  const {
    to, symbol, quantity, isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(to && typeof to === 'string'
      && symbol && typeof symbol === 'string'
      && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN(), 'invalid params')) {
    const finalTo = to.trim();
    if (api.assert(finalTo !== api.sender, 'cannot transfer to self')) {
      // a valid contract account is between 3 and 50 characters in length
      if (api.assert(finalTo.length >= 3 && finalTo.length <= 50, 'invalid to')) {
        const token = await api.db.findOne('tokens', { symbol });

        // the symbol must exist
        // then we need to check that the quantity is correct
        if (api.assert(token !== null, 'symbol does not exist')
          && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
          && api.assert(api.BigNumber(quantity).gt(0), 'must transfer positive quantity')) {
          if (await subBalanceVTwo(api.sender, token, quantity, 'balances')) {
            const res = await addBalanceVTwo(finalTo, token, quantity, 'contractsBalances');

            if (res === false) {
              await addBalanceVTwo(api.sender, token, quantity, 'balances');
            } else {
              if (finalTo === 'null') {
                token.circulatingSupply = calculateBalanceVTwo(
                  token.circulatingSupply, quantity, token.precision, false,
                );
                await api.db.update('tokens', token);
              }

              api.emit('transferToContract', {
                from: api.sender, to: finalTo, symbol, quantity,
              });
            }
          }
        }
      }
    }
  }
};

actions.transferFromContract = async (payload) => {
  // this action can only be called by the 'null' account which only the core code can use
  if (api.assert(api.sender === 'null', 'not authorized')) {
    const {
      from, to, symbol, quantity, type, isSignedWithActiveKey,
    } = payload;
    const types = ['user', 'contract'];

    if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
      && api.assert(to && typeof to === 'string'
        && from && typeof from === 'string'
        && symbol && typeof symbol === 'string'
        && type && (types.includes(type))
        && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN(), 'invalid params')) {
      const finalTo = to.trim();
      const table = type === 'user' ? 'balances' : 'contractsBalances';

      if (api.assert(type === 'user' || (type === 'contract' && finalTo !== from), 'cannot transfer to self')) {
        // validate the "to"
        const toValid = type === 'user' ? finalTo.length >= 3 && finalTo.length <= 16 : finalTo.length >= 3 && finalTo.length <= 50;

        // the account must exist
        if (api.assert(toValid === true, 'invalid to')) {
          const token = await api.db.findOne('tokens', { symbol });

          // the symbol must exist
          // then we need to check that the quantity is correct
          if (api.assert(token !== null, 'symbol does not exist')
            && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
            && api.assert(api.BigNumber(quantity).gt(0), 'must transfer positive quantity')) {

            if (await subBalanceVTwo(from, token, quantity, 'contractsBalances')) {
              const res = await addBalanceVTwo(finalTo, token, quantity, table);

              if (res === false) {
                await addBalanceVTwo(from, token, quantity, 'contractsBalances');
              } else {
                if (finalTo === 'null') {
                  token.circulatingSupply = calculateBalanceVTwo(
                    token.circulatingSupply, quantity, token.precision, false,
                  );
                  await api.db.update('tokens', token);
                }

                api.emit('transferFromContract', {
                  from, to: finalTo, symbol, quantity,
                });
              }
            }
          }
        }
      }
    }
  }
};

const subBalanceVOne = async (account, token, quantity, table) => {
  const balance = await api.db.findOne(table, { account, symbol: token.symbol });
  if (api.assert(balance !== null, 'balance does not exist') 
    && api.assert(balance.balance >= quantity, 'overdrawn balance')) {
    const originalBalance = balance.balance;

    balance.balance = calculateBalanceVOne(balance.balance, quantity, token.precision, false);

    if (api.assert(balance.balance < originalBalance, 'cannot subtract')) {
      await api.db.update(table, balance);

      return true;
    }
  }

  return false;
};

const subBalanceVTwo = async (account, token, quantity, table) => {
  const balance = await api.db.findOne(table, { account, symbol: token.symbol });

  if (api.assert(balance !== null, 'balance does not exist')
    && api.assert(api.BigNumber(balance.balance).gte(quantity), 'overdrawn balance')) {
    const originalBalance = balance.balance;

    balance.balance = calculateBalanceVTwo(balance.balance, quantity, token.precision, false);

    if (api.assert(api.BigNumber(balance.balance).lt(originalBalance), 'cannot subtract')) {
      await api.db.update(table, balance);

      return true;
    }
  }

  return false;
};

const addBalanceVOne = async (account, token, quantity, table) => {
  let balance = await api.db.findOne(table, { account, symbol: token.symbol });
  if (balance === null) {
    balance = {
      account,
      symbol: token.symbol,
      balance: quantity
    };

    await api.db.insert(table, balance);

    return true;
  }
  const originalBalance = balance.balance;

  balance.balance = calculateBalanceVOne(balance.balance, quantity, token.precision, true);
  if (api.assert(balance.balance > originalBalance, 'cannot add')) {
    await api.db.update(table, balance);
    return true;
  }

  return false;
};

const addBalanceVTwo = async (account, token, quantity, table) => {
  let balance = await api.db.findOne(table, { account, symbol: token.symbol });
  if (balance === null) {
    balance = {
      account,
      symbol: token.symbol,
      balance: quantity,
    };

    await api.db.insert(table, balance);

    return true;
  }

  const originalBalance = balance.balance;

  balance.balance = calculateBalanceVTwo(balance.balance, quantity, token.precision, true);
  if (api.assert(api.BigNumber(balance.balance).gt(originalBalance), 'cannot add')) {
    await api.db.update(table, balance);
    return true;
  }

  return false;
};

const calculateBalanceVOne = (balance, quantity, precision, add) => {
  if (precision === 0) {
    return add ? balance + quantity : balance - quantity;
  }

  return add
    ? api.BigNumber(balance).plus(quantity).toNumber()
    : api.BigNumber(balance).minus(quantity).toNumber();
};

const calculateBalanceVTwo = (balance, quantity, precision, add) => {
  return add
    ? api.BigNumber(balance).plus(quantity).toFixed(precision)
    : api.BigNumber(balance).minus(quantity).toFixed(precision);
};

const countDecimals = value => api.BigNumber(value).dp();
