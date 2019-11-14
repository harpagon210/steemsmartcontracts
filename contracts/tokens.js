/* eslint-disable no-await-in-loop */
/* global actions, api */

actions.createSSC = async () => {
  let tableExists = await api.db.tableExists('tokens');
  if (tableExists === false) {
    await api.db.createTable('tokens', ['symbol']);
    await api.db.createTable('balances', ['account']);
    await api.db.createTable('contractsBalances', ['account']);
    await api.db.createTable('params');

    const params = {};
    params.tokenCreationFee = '0';
    // params.updateStakingParamsFee = '100';
    // params.updateDelegationParamsFee = '100';
    await api.db.insert('params', params);
  } else {
    const params = await api.db.findOne('params', {});
    params.enableDelegationFee = '1000';
    params.enableStakingFee = '1000';
    await api.db.update('params', params);
  }

  tableExists = await api.db.tableExists('pendingUnstakes');
  if (tableExists === false) {
    await api.db.createTable('pendingUnstakes', ['account', 'unstakeCompleteTimestamp']);
  }

  tableExists = await api.db.tableExists('delegations');
  if (tableExists === false) {
    await api.db.createTable('delegations', ['from', 'to']);
    await api.db.createTable('pendingUndelegations', ['account', 'completeTimestamp']);
  }

  // update STEEMP decimal places
  let token = await api.db.findOne('tokens', { symbol: 'STEEMP' });

  if (token && token.precision < 8) {
    token.precision = 8;
    await api.db.update('tokens', token);
  }

  // enable staking and delegation for ENG
  // eslint-disable-next-line no-template-curly-in-string
  token = await api.db.findOne('tokens', { symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  if (token.stakingEnabled === undefined || token.stakingEnabled === false) {
    token.stakingEnabled = true;
    token.totalStaked = '0';
    token.unstakingCooldown = 40;
    token.numberTransactions = 4;
    token.delegationEnabled = true;
    token.undelegationCooldown = 7;
    await api.db.update('tokens', token);
  }
};

const balanceTemplate = {
  account: null,
  symbol: null,
  balance: '0',
  stake: '0',
  pendingUnstake: '0',
  delegationsIn: '0',
  delegationsOut: '0',
  pendingUndelegations: '0',
};

const calculateBalance = (balance, quantity, precision, add) => (add
  ? api.BigNumber(balance).plus(quantity).toFixed(precision)
  : api.BigNumber(balance).minus(quantity).toFixed(precision));

const countDecimals = value => api.BigNumber(value).dp();

const addStake = async (account, token, quantity) => {
  let balance = await api.db.findOne('balances', { account, symbol: token.symbol });

  if (balance === null) {
    balance = balanceTemplate;
    balance.account = account;
    balance.symbol = token.symbol;

    balance = await api.db.insert('balances', balance);
  }

  if (balance.stake === undefined) {
    balance.stake = '0';
    balance.pendingUnstake = '0';
  }

  const originalStake = balance.stake;

  balance.stake = calculateBalance(balance.stake, quantity, token.precision, true);
  if (api.assert(api.BigNumber(balance.stake).gt(originalStake), 'cannot add')) {
    await api.db.update('balances', balance);

    if (token.totalStaked === undefined) {
      // eslint-disable-next-line no-param-reassign
      token.totalStaked = '0';
    }

    // eslint-disable-next-line no-param-reassign
    token.totalStaked = calculateBalance(token.totalStaked, quantity, token.precision, true);
    await api.db.update('tokens', token);

    return true;
  }

  return false;
};

const subStake = async (account, token, quantity) => {
  const balance = await api.db.findOne('balances', { account, symbol: token.symbol });

  if (api.assert(balance !== null, 'balance does not exist')
    && api.assert(api.BigNumber(balance.stake).gte(quantity), 'overdrawn stake')) {
    const originalStake = balance.stake;
    const originalPendingStake = balance.pendingUnstake;

    balance.stake = calculateBalance(balance.stake, quantity, token.precision, false);
    balance.pendingUnstake = calculateBalance(
      balance.pendingUnstake, quantity, token.precision, true,
    );

    if (api.assert(api.BigNumber(balance.stake).lt(originalStake)
      && api.BigNumber(balance.pendingUnstake).gt(originalPendingStake), 'cannot subtract')) {
      await api.db.update('balances', balance);

      return true;
    }
  }

  return false;
};

const subBalance = async (account, token, quantity, table) => {
  const balance = await api.db.findOne(table, { account, symbol: token.symbol });

  if (api.assert(balance !== null, 'balance does not exist')
    && api.assert(api.BigNumber(balance.balance).gte(quantity), 'overdrawn balance')) {
    const originalBalance = balance.balance;

    balance.balance = calculateBalance(balance.balance, quantity, token.precision, false);

    if (api.assert(api.BigNumber(balance.balance).lt(originalBalance), 'cannot subtract')) {
      await api.db.update(table, balance);

      return true;
    }
  }

  return false;
};

const addBalance = async (account, token, quantity, table) => {
  let balance = await api.db.findOne(table, { account, symbol: token.symbol });
  if (balance === null) {
    balance = balanceTemplate;
    balance.account = account;
    balance.symbol = token.symbol;
    balance.balance = quantity;


    await api.db.insert(table, balance);

    return true;
  }

  const originalBalance = balance.balance;

  balance.balance = calculateBalance(balance.balance, quantity, token.precision, true);
  if (api.assert(api.BigNumber(balance.balance).gt(originalBalance), 'cannot add')) {
    await api.db.update(table, balance);
    return true;
  }

  return false;
};

actions.updateParams = async (payload) => {
  if (api.sender !== api.owner) return;

  const { tokenCreationFee /* , updateStakingParamsFee, updateDelegationParamsFee */ } = payload;

  const params = await api.db.findOne('params', {});

  params.tokenCreationFee = tokenCreationFee;
  // params.updateStakingParamsFee = updateStakingParamsFee;
  // params.updateDelegationParamsFee = updateDelegationParamsFee;

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

actions.updatePrecision = async (payload) => {
  const { symbol, precision, isSignedWithActiveKey } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string')
    && api.assert((precision > 0 && precision <= 8) && (Number.isInteger(precision)), 'invalid precision')) {
    // check if the token exists
    const token = await api.db.findOne('tokens', { symbol });

    if (token) {
      if (api.assert(token.issuer === api.sender, 'must be the issuer')
        && api.assert(precision > token.precision, 'precision can only be increased')) {
        token.precision = precision;
        await api.db.update('tokens', token);
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
    const token = await api.db.findOne('tokens', { symbol });

    if (token) {
      if (api.assert(token.issuer === api.sender, 'must be the issuer')) {
        const finalTo = to.trim();

        if (api.assert(api.isValidAccountName(finalTo), 'invalid to')) {
          token.issuer = finalTo;
          await api.db.update('tokens', token);
        }
      }
    }
  }
};

actions.create = async (payload) => {
  const {
    name, symbol, url, precision, maxSupply, isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { tokenCreationFee } = params;

  // get api.sender's UTILITY_TOKEN_SYMBOL balance
  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOne('balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(tokenCreationFee).lte(0)
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(tokenCreationFee);

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fees')
      && api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
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
      && api.assert(api.BigNumber(maxSupply).lte(Number.MAX_SAFE_INTEGER), `maxSupply must be lower than ${Number.MAX_SAFE_INTEGER}`)) {
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
          stakingEnabled: false,
          unstakingCooldown: 1,
          delegationEnabled: false,
          undelegationCooldown: 0,
        };

        await api.db.insert('tokens', newToken);

        // burn the token creation fees
        if (api.BigNumber(tokenCreationFee).gt(0)) {
          await actions.transfer({
            // eslint-disable-next-line no-template-curly-in-string
            to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: tokenCreationFee, isSignedWithActiveKey,
          });
        }
      }
    }
  }
};

actions.issue = async (payload) => {
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
      if (api.assert(api.isValidAccountName(finalTo), 'invalid to')) {
        // we made all the required verification, let's now issue the tokens

        let res = await addBalance(token.issuer, token, quantity, 'balances');

        if (res === true && finalTo !== token.issuer) {
          if (await subBalance(token.issuer, token, quantity, 'balances')) {
            res = await addBalance(finalTo, token, quantity, 'balances');

            if (res === false) {
              await addBalance(token.issuer, token, quantity, 'balances');
            }
          }
        }

        if (res === true) {
          token.supply = calculateBalance(token.supply, quantity, token.precision, true);

          if (finalTo !== 'null') {
            token.circulatingSupply = calculateBalance(
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

actions.issueToContract = async (payload) => {
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

      // a valid contract name is between 3 and 50 characters in length
      if (api.assert(finalTo.length >= 3 && finalTo.length <= 50, 'invalid to')) {
        // we made all the required verification, let's now issue the tokens

        const res = await addBalance(finalTo, token, quantity, 'contractsBalances');

        if (res === true) {
          token.supply = calculateBalance(token.supply, quantity, token.precision, true);

          if (finalTo !== 'null') {
            token.circulatingSupply = calculateBalance(
              token.circulatingSupply, quantity, token.precision, true,
            );
          }

          await api.db.update('tokens', token);

          api.emit('issueToContract', {
            from: 'tokens', to: finalTo, symbol, quantity,
          });
        }
      }
    }
  }
};

actions.transfer = async (payload) => {
  const {
    to, symbol, quantity, isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(to && typeof to === 'string'
      && symbol && typeof symbol === 'string'
      && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN(), 'invalid params')) {
    const finalTo = to.trim();
    if (api.assert(finalTo !== api.sender, 'cannot transfer to self')) {
      if (api.assert(api.isValidAccountName(finalTo), 'invalid to')) {
        const token = await api.db.findOne('tokens', { symbol });

        // the symbol must exist
        // then we need to check that the quantity is correct
        if (api.assert(token !== null, 'symbol does not exist')
          && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
          && api.assert(api.BigNumber(quantity).gt(0), 'must transfer positive quantity')) {
          if (await subBalance(api.sender, token, quantity, 'balances')) {
            const res = await addBalance(finalTo, token, quantity, 'balances');

            if (res === false) {
              await addBalance(api.sender, token, quantity, 'balances');

              return false;
            }

            if (finalTo === 'null') {
              token.circulatingSupply = calculateBalance(
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

actions.transferToContract = async (payload) => {
  const {
    to, symbol, quantity, isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(to && typeof to === 'string'
      && symbol && typeof symbol === 'string'
      && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN(), 'invalid params')) {
    const finalTo = to.trim().toLowerCase();
    if (api.assert(finalTo !== api.sender, 'cannot transfer to self')) {
      // a valid contract account is between 3 and 50 characters in length
      if (api.assert(finalTo.length >= 3 && finalTo.length <= 50, 'invalid to')) {
        const token = await api.db.findOne('tokens', { symbol });

        // the symbol must exist
        // then we need to check that the quantity is correct
        if (api.assert(token !== null, 'symbol does not exist')
          && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
          && api.assert(api.BigNumber(quantity).gt(0), 'must transfer positive quantity')) {
          if (await subBalance(api.sender, token, quantity, 'balances')) {
            const res = await addBalance(finalTo, token, quantity, 'contractsBalances');

            if (res === false) {
              await addBalance(api.sender, token, quantity, 'balances');
            } else {
              if (finalTo === 'null') {
                token.circulatingSupply = calculateBalance(
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
        const toValid = type === 'user' ? api.isValidAccountName(finalTo) : finalTo.length >= 3 && finalTo.length <= 50;

        // the account must exist
        if (api.assert(toValid === true, 'invalid to')) {
          const token = await api.db.findOne('tokens', { symbol });

          // the symbol must exist
          // then we need to check that the quantity is correct
          if (api.assert(token !== null, 'symbol does not exist')
            && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
            && api.assert(api.BigNumber(quantity).gt(0), 'must transfer positive quantity')) {
            if (await subBalance(from, token, quantity, 'contractsBalances')) {
              const res = await addBalance(finalTo, token, quantity, table);

              if (res === false) {
                await addBalance(from, token, quantity, 'contractsBalances');
              } else {
                if (finalTo === 'null') {
                  token.circulatingSupply = calculateBalance(
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

const processUnstake = async (unstake) => {
  const {
    account,
    symbol,
    quantity,
    quantityLeft,
    numberTransactionsLeft,
  } = unstake;

  const newUnstake = unstake;

  const balance = await api.db.findOne('balances', { account, symbol });
  const token = await api.db.findOne('tokens', { symbol });
  let tokensToRelease = 0;

  if (api.assert(balance !== null, 'balance does not exist')) {
    // if last transaction to process
    if (numberTransactionsLeft === 1) {
      tokensToRelease = quantityLeft;
      await api.db.remove('pendingUnstakes', unstake);
    } else {
      tokensToRelease = api.BigNumber(quantity)
        .dividedBy(token.numberTransactions)
        .toFixed(token.precision, api.BigNumber.ROUND_DOWN);

      newUnstake.quantityLeft = api.BigNumber(newUnstake.quantityLeft)
        .minus(tokensToRelease)
        .toFixed(token.precision);

      newUnstake.numberTransactionsLeft -= 1;

      newUnstake.nextTransactionTimestamp = api.BigNumber(newUnstake.nextTransactionTimestamp)
        .plus(newUnstake.millisecPerPeriod)
        .toNumber();

      await api.db.update('pendingUnstakes', newUnstake);
    }

    if (api.BigNumber(tokensToRelease).gt(0)) {
      const originalBalance = balance.balance;
      const originalPendingStake = balance.pendingUnstake;

      balance.balance = calculateBalance(
        balance.balance, tokensToRelease, token.precision, true,
      );
      balance.pendingUnstake = calculateBalance(
        balance.pendingUnstake, tokensToRelease, token.precision, false,
      );

      if (api.assert(api.BigNumber(balance.pendingUnstake).lt(originalPendingStake)
        && api.BigNumber(balance.balance).gt(originalBalance), 'cannot subtract')) {
        await api.db.update('balances', balance);

        token.totalStaked = calculateBalance(
          token.totalStaked, tokensToRelease, token.precision, false,
        );

        await api.db.update('tokens', token);

        api.emit('unstake', { account, symbol, quantity: tokensToRelease });

        // update witnesses rank
        // eslint-disable-next-line no-template-curly-in-string
        if (symbol === "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'") {
          await api.executeSmartContract('witnesses', 'updateWitnessesApprovals', { account });
        }
      }
    }
  }
};

actions.checkPendingUnstakes = async () => {
  if (api.assert(api.sender === 'null', 'not authorized')) {
    const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);
    const timestamp = blockDate.getTime();

    // get all the pending unstakes that are ready to be released
    let pendingUnstakes = await api.db.find(
      'pendingUnstakes',
      {
        nextTransactionTimestamp: {
          $lte: timestamp,
        },
      },
    );

    let nbPendingUnstakes = pendingUnstakes.length;
    while (nbPendingUnstakes > 0) {
      for (let index = 0; index < nbPendingUnstakes; index += 1) {
        const pendingUnstake = pendingUnstakes[index];
        await processUnstake(pendingUnstake);
      }

      pendingUnstakes = await api.db.find(
        'pendingUnstakes',
        {
          nextTransactionTimestamp: {
            $lte: timestamp,
          },
        },
      );

      nbPendingUnstakes = pendingUnstakes.length;
    }
  }
};

actions.enableStaking = async (payload) => {
  const {
    symbol,
    unstakingCooldown,
    numberTransactions,
    isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { enableStakingFee } = params;

  // get api.sender's UTILITY_TOKEN_SYMBOL balance
  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOne('balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });
  const enoughFunds = utilityTokenBalance
    && api.BigNumber(utilityTokenBalance.balance).gte(enableStakingFee);
  const authorized = enableStakingFee === undefined
    || api.BigNumber(enableStakingFee).lte(0)
    || enoughFunds;

  if (api.assert(authorized, 'you must have enough tokens to cover  fees')
    && api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string', 'invalid symbol')
    && api.assert(unstakingCooldown && Number.isInteger(unstakingCooldown) && unstakingCooldown > 0 && unstakingCooldown <= 18250, 'unstakingCooldown must be an integer between 1 and 18250')
    && api.assert(numberTransactions && Number.isInteger(numberTransactions) && numberTransactions > 0 && numberTransactions <= 18250, 'numberTransactions must be an integer between 1 and 18250')) {
    const token = await api.db.findOne('tokens', { symbol });

    if (api.assert(token !== null, 'symbol does not exist')
      && api.assert(token.issuer === api.sender, 'must be the issuer')
      && api.assert(token.stakingEnabled === undefined || token.stakingEnabled === false, 'staking already enabled')) {
      token.stakingEnabled = true;
      token.totalStaked = '0';
      token.unstakingCooldown = unstakingCooldown;
      token.numberTransactions = numberTransactions;
      await api.db.update('tokens', token);

      // burn the fees
      if (api.BigNumber(enableStakingFee).gt(0)) {
        await actions.transfer({
          // eslint-disable-next-line no-template-curly-in-string
          to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: enableStakingFee, isSignedWithActiveKey,
        });
      }
    }
  }
};

actions.stake = async (payload) => {
  const {
    symbol,
    quantity,
    to,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
    && to && typeof to === 'string'
    && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN(), 'invalid params')) {
    // a valid steem account is between 3 and 16 characters in length
    const token = await api.db.findOne('tokens', { symbol });

    const finalTo = to.trim();

    // the symbol must exist
    // then we need to check that the quantity is correct
    if (api.assert(api.isValidAccountName(finalTo), 'invalid to')
      && api.assert(token !== null, 'symbol does not exist')
      && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
      && api.assert(token.stakingEnabled === true, 'staking not enabled')
      && api.assert(api.BigNumber(quantity).gt(0), 'must stake positive quantity')) {
      if (await subBalance(api.sender, token, quantity, 'balances')) {
        const res = await addStake(finalTo, token, quantity);

        if (res === false) {
          await addBalance(api.sender, token, quantity, 'balances');
        } else {
          api.emit('stake', { account: finalTo, symbol, quantity });

          // update witnesses rank
          // eslint-disable-next-line no-template-curly-in-string
          if (symbol === "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'") {
            await api.executeSmartContract('witnesses', 'updateWitnessesApprovals', { account: api.sender });
          }
        }
      }
    }
  }
};

actions.stakeFromContract = async (payload) => {
  const {
    symbol,
    quantity,
    to,
    callingContractInfo,
  } = payload;

  // can only be called from a contract
  if (callingContractInfo
    && api.assert(symbol && typeof symbol === 'string'
    && to && typeof to === 'string'
    && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN(), 'invalid params')) {
    const token = await api.db.findOne('tokens', { symbol });
    const finalTo = to.trim();

    // the symbol must exist
    // then we need to check that the quantity is correct
    if (api.assert(api.isValidAccountName(finalTo), 'invalid to')
      && api.assert(token !== null, 'symbol does not exist')
      && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
      && api.assert(token.stakingEnabled === true, 'staking not enabled')
      && api.assert(api.BigNumber(quantity).gt(0), 'must stake positive quantity')) {
      if (await subBalance(callingContractInfo.name, token, quantity, 'contractsBalances')) {
        const res = await addStake(finalTo, token, quantity);

        if (res === false) {
          await addBalance(callingContractInfo.name, token, quantity, 'balances');
        } else {
          api.emit('stakeFromContract', { account: finalTo, symbol, quantity });

          // update witnesses rank
          // eslint-disable-next-line no-template-curly-in-string
          if (symbol === "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'") {
            await api.executeSmartContract('witnesses', 'updateWitnessesApprovals', { account: finalTo });
          }
        }
      }
    }
  }
};

const startUnstake = async (account, token, quantity) => {
  const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);
  const cooldownPeriodMillisec = token.unstakingCooldown * 24 * 3600 * 1000;
  const millisecPerPeriod = api.BigNumber(cooldownPeriodMillisec)
    .dividedBy(token.numberTransactions)
    .integerValue(api.BigNumber.ROUND_DOWN);

  const nextTransactionTimestamp = api.BigNumber(blockDate.getTime())
    .plus(millisecPerPeriod)
    .toNumber();

  const unstake = {
    account,
    symbol: token.symbol,
    quantity,
    quantityLeft: quantity,
    nextTransactionTimestamp,
    numberTransactionsLeft: token.numberTransactions,
    millisecPerPeriod,
    txID: api.transactionId,
  };

  await api.db.insert('pendingUnstakes', unstake);
};

actions.unstake = async (payload) => {
  const { symbol, quantity, isSignedWithActiveKey } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
      && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN(), 'invalid params')) {
    // a valid steem account is between 3 and 16 characters in length
    const token = await api.db.findOne('tokens', { symbol });

    // the symbol must exist
    // then we need to check that the quantity is correct
    if (api.assert(token !== null, 'symbol does not exist')
      && api.assert(token.stakingEnabled === true, 'staking not enabled')
      && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
      && api.assert(api.BigNumber(quantity).gt(0), 'must unstake positive quantity')) {
      if (await subStake(api.sender, token, quantity)) {
        await startUnstake(api.sender, token, quantity);

        api.emit('unstakeStart', { account: api.sender, symbol, quantity });
      }
    }
  }
};

const processCancelUnstake = async (unstake) => {
  const {
    account,
    symbol,
    quantityLeft,
  } = unstake;

  const balance = await api.db.findOne('balances', { account, symbol });
  const token = await api.db.findOne('tokens', { symbol });

  if (api.assert(balance !== null, 'balance does not exist')
    && api.assert(api.BigNumber(balance.pendingUnstake).gte(quantityLeft), 'overdrawn pendingUnstake')) {
    const originalStake = balance.stake;
    const originalPendingStake = balance.pendingUnstake;

    balance.stake = calculateBalance(
      balance.stake, quantityLeft, token.precision, true,
    );
    balance.pendingUnstake = calculateBalance(
      balance.pendingUnstake, quantityLeft, token.precision, false,
    );

    if (api.assert(api.BigNumber(balance.pendingUnstake).lt(originalPendingStake)
      && api.BigNumber(balance.stake).gt(originalStake), 'cannot subtract')) {
      await api.db.update('balances', balance);

      api.emit('unstake', { account, symbol, quantity: quantityLeft });
      return true;
    }
  }

  return false;
};

actions.cancelUnstake = async (payload) => {
  const { txID, isSignedWithActiveKey } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
      && api.assert(txID && typeof txID === 'string', 'invalid params')) {
    // get unstake
    const unstake = await api.db.findOne('pendingUnstakes', { account: api.sender, txID });

    if (api.assert(unstake, 'unstake does not exist')) {
      if (await processCancelUnstake(unstake)) {
        await api.db.remove('pendingUnstakes', unstake);
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
  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOne('balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });
  const enoughFunds = utilityTokenBalance
    && api.BigNumber(utilityTokenBalance.balance).gte(enableDelegationFee);
  const authorized = enableDelegationFee === undefined
    || api.BigNumber(enableDelegationFee).lte(0)
    || enoughFunds;

  if (api.assert(authorized, 'you must have enough tokens to cover  fees')
    && api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string', 'invalid symbol')
    && api.assert(undelegationCooldown && Number.isInteger(undelegationCooldown) && undelegationCooldown > 0 && undelegationCooldown <= 18250, 'undelegationCooldown must be an integer between 1 and 18250')) {
    const token = await api.db.findOne('tokens', { symbol });

    if (api.assert(token !== null, 'symbol does not exist')
      && api.assert(token.issuer === api.sender, 'must be the issuer')
      && api.assert(token.stakingEnabled === true, 'staking not enabled')
      && api.assert(token.delegationEnabled === undefined || token.delegationEnabled === false, 'delegation already enabled')) {
      token.delegationEnabled = true;
      token.undelegationCooldown = undelegationCooldown;
      await api.db.update('tokens', token);

      // burn the fees
      if (api.BigNumber(enableDelegationFee).gt(0)) {
        await actions.transfer({
          // eslint-disable-next-line no-template-curly-in-string
          to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: enableDelegationFee, isSignedWithActiveKey,
        });
      }
    }
  }
};

actions.delegate = async (payload) => {
  const {
    symbol,
    quantity,
    to,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
    && to && typeof to === 'string'
    && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN(), 'invalid params')) {
    const finalTo = to.trim();
    if (api.assert(api.isValidAccountName(finalTo), 'invalid to')) {
      const token = await api.db.findOne('tokens', { symbol });

      // the symbol must exist
      // then we need to check that the quantity is correct
      if (api.assert(token !== null, 'symbol does not exist')
        && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
        && api.assert(token.delegationEnabled === true, 'delegation not enabled')
        && api.assert(finalTo !== api.sender, 'cannot delegate to yourself')
        && api.assert(api.BigNumber(quantity).gt(0), 'must delegate positive quantity')) {
        const balanceFrom = await api.db.findOne('balances', { account: api.sender, symbol });

        if (api.assert(balanceFrom !== null, 'balanceFrom does not exist')
          && api.assert(api.BigNumber(balanceFrom.stake).gte(quantity), 'overdrawn stake')) {
          if (balanceFrom.stake === undefined) {
            // update old balances with new properties
            balanceFrom.stake = '0';
            balanceFrom.pendingUnstake = '0';
            balanceFrom.delegationsIn = '0';
            balanceFrom.delegationsOut = '0';
            balanceFrom.pendingUndelegations = '0';
          } else if (balanceFrom.delegationsIn === undefined) {
            // update old balances with new properties
            balanceFrom.delegationsIn = '0';
            balanceFrom.delegationsOut = '0';
            balanceFrom.pendingUndelegations = '0';
            if (balanceFrom.delegatedStake) {
              delete balanceFrom.delegatedStake;
              delete balanceFrom.receivedStake;
            }
          }

          let balanceTo = await api.db.findOne('balances', { account: finalTo, symbol });

          if (balanceTo === null) {
            balanceTo = balanceTemplate;
            balanceTo.account = finalTo;
            balanceTo.symbol = symbol;

            balanceTo = await api.db.insert('balances', balanceTo);
          } else if (balanceTo.stake === undefined) {
            // update old balances with new properties
            balanceTo.stake = '0';
            balanceTo.pendingUnstake = '0';
            balanceTo.delegationsIn = '0';
            balanceTo.delegationsOut = '0';
            balanceTo.pendingUndelegations = '0';
          } else if (balanceTo.delegationsIn === undefined) {
            // update old balances with new properties
            balanceTo.delegationsIn = '0';
            balanceTo.delegationsOut = '0';
            balanceTo.pendingUndelegations = '0';

            if (balanceTo.delegatedStake) {
              delete balanceTo.delegatedStake;
              delete balanceTo.receivedStake;
            }
          }

          // look for an existing delegation
          let delegation = await api.db.findOne('delegations', { to: finalTo, from: api.sender, symbol });
          const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);
          const timestamp = blockDate.getTime();

          if (delegation == null) {
            // update balanceFrom
            balanceFrom.stake = calculateBalance(
              balanceFrom.stake, quantity, token.precision, false,
            );
            balanceFrom.delegationsOut = calculateBalance(
              balanceFrom.delegationsOut, quantity, token.precision, true,
            );

            await api.db.update('balances', balanceFrom);

            // update balanceTo
            balanceTo.delegationsIn = calculateBalance(
              balanceTo.delegationsIn, quantity, token.precision, true,
            );

            await api.db.update('balances', balanceTo);

            delegation = {};
            delegation.from = api.sender;
            delegation.to = finalTo;
            delegation.symbol = symbol;
            delegation.quantity = quantity;
            delegation.created = timestamp;
            delegation.updated = timestamp;

            await api.db.insert('delegations', delegation);

            api.emit('delegate', { to: finalTo, symbol, quantity });

            // update witnesses rank
            // eslint-disable-next-line no-template-curly-in-string
            if (symbol === "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'") {
              await api.executeSmartContract('witnesses', 'updateWitnessesApprovals', { account: api.sender });
              await api.executeSmartContract('witnesses', 'updateWitnessesApprovals', { account: finalTo });
            }
          } else {
            // if a delegation already exists, increase it

            // update balanceFrom
            balanceFrom.stake = calculateBalance(
              balanceFrom.stake, quantity, token.precision, false,
            );
            balanceFrom.delegationsOut = calculateBalance(
              balanceFrom.delegationsOut, quantity, token.precision, true,
            );

            await api.db.update('balances', balanceFrom);

            // update balanceTo
            balanceTo.delegationsIn = calculateBalance(
              balanceTo.delegationsIn, quantity, token.precision, true,
            );

            await api.db.update('balances', balanceTo);

            // update delegation
            delegation.quantity = calculateBalance(
              delegation.quantity, quantity, token.precision, true,
            );

            // update the timestamp
            delegation.updated = timestamp;

            await api.db.update('delegations', delegation);
            api.emit('delegate', { to: finalTo, symbol, quantity });

            // update witnesses rank
            // eslint-disable-next-line no-template-curly-in-string
            if (symbol === "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'") {
              await api.executeSmartContract('witnesses', 'updateWitnessesApprovals', { account: api.sender });
              await api.executeSmartContract('witnesses', 'updateWitnessesApprovals', { account: finalTo });
            }
          }
        }
      }
    }
  }
};

actions.undelegate = async (payload) => {
  const {
    symbol,
    quantity,
    from,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
    && from && typeof from === 'string'
    && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN(), 'invalid params')) {
    const finalFrom = from.trim();
    if (api.assert(api.isValidAccountName(finalFrom), 'invalid from')) {
      const token = await api.db.findOne('tokens', { symbol });

      // the symbol must exist
      // then we need to check that the quantity is correct
      if (api.assert(token !== null, 'symbol does not exist')
        && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
        && api.assert(token.delegationEnabled === true, 'delegation not enabled')
        && api.assert(finalFrom !== api.sender, 'cannot undelegate from yourself')
        && api.assert(api.BigNumber(quantity).gt(0), 'must undelegate positive quantity')) {
        const balanceTo = await api.db.findOne('balances', { account: api.sender, symbol });

        if (api.assert(balanceTo !== null, 'balanceTo does not exist')
          && api.assert(api.BigNumber(balanceTo.delegationsOut).gte(quantity), 'overdrawn delegation')) {
          const balanceFrom = await api.db.findOne('balances', { account: finalFrom, symbol });

          if (api.assert(balanceFrom !== null, 'balanceFrom does not exist')) {
            // look for an existing delegation
            const delegation = await api.db.findOne('delegations', { to: finalFrom, from: api.sender, symbol });

            if (api.assert(delegation !== null, 'delegation does not exist')
              && api.assert(api.BigNumber(delegation.quantity).gte(quantity), 'overdrawn delegation')) {
              // update balanceTo
              balanceTo.pendingUndelegations = calculateBalance(
                balanceFrom.pendingUndelegations, quantity, token.precision, true,
              );
              balanceTo.delegationsOut = calculateBalance(
                balanceTo.delegationsOut, quantity, token.precision, false,
              );

              await api.db.update('balances', balanceTo);

              // update balanceFrom
              balanceFrom.delegationsIn = calculateBalance(
                balanceFrom.delegationsIn, quantity, token.precision, false,
              );

              await api.db.update('balances', balanceFrom);

              // update delegation
              delegation.quantity = calculateBalance(
                delegation.quantity, quantity, token.precision, false,
              );

              if (api.BigNumber(delegation.quantity).gt(0)) {
                await api.db.update('delegations', delegation);
              } else {
                await api.db.remove('delegations', delegation);
              }

              // add pending undelegation
              const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);
              const cooldownPeriodMillisec = token.undelegationCooldown * 24 * 3600 * 1000;

              const completeTimestamp = blockDate.getTime() + cooldownPeriodMillisec;

              const undelegation = {
                account: api.sender,
                symbol: token.symbol,
                quantity,
                completeTimestamp,
                txID: api.transactionId,
              };

              await api.db.insert('pendingUndelegations', undelegation);

              api.emit('undelegateStart', { from: finalFrom, symbol, quantity });

              // update witnesses rank
              // eslint-disable-next-line no-template-curly-in-string
              if (symbol === "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'") {
                await api.executeSmartContract('witnesses', 'updateWitnessesApprovals', { account: finalFrom });
              }
            }
          }
        }
      }
    }
  }
};

const processUndelegation = async (undelegation) => {
  const {
    account,
    symbol,
    quantity,
  } = undelegation;

  const balance = await api.db.findOne('balances', { account, symbol });
  const token = await api.db.findOne('tokens', { symbol });

  if (api.assert(balance !== null, 'balance does not exist')) {
    const originalStake = balance.stake;
    const originalPendingUndelegations = balance.pendingUndelegations;

    // update the balance
    balance.stake = calculateBalance(
      balance.stake, quantity, token.precision, true,
    );
    balance.pendingUndelegations = calculateBalance(
      balance.pendingUndelegations, quantity, token.precision, false,
    );

    if (api.assert(api.BigNumber(balance.pendingUndelegations).lt(originalPendingUndelegations)
        && api.BigNumber(balance.stake).gt(originalStake), 'cannot subtract')) {
      await api.db.update('balances', balance);

      // remove pendingUndelegation
      await api.db.remove('pendingUndelegations', undelegation);

      api.emit('undelegateDone', { account, symbol, quantity });

      // update witnesses rank
      // eslint-disable-next-line no-template-curly-in-string
      if (symbol === "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'") {
        await api.executeSmartContract('witnesses', 'updateWitnessesApprovals', { account });
      }
    }
  }
};

actions.checkPendingUndelegations = async () => {
  if (api.assert(api.sender === 'null', 'not authorized')) {
    const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);
    const timestamp = blockDate.getTime();

    // get all the pending unstakes that are ready to be released
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
