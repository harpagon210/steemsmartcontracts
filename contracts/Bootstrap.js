const { Base64 } = require('js-base64');
const { Transaction } = require('../libs/Transaction');
const BP_CONSTANTS = require('../libs/BlockProduction.contants').CONSTANTS;

class Bootstrap {
  static getBootstrapTransactions(genesisSteemBlock) {
    const transactions = [];

    let contractCode;
    let base64ContractCode;
    let contractPayload;

    const FORK_BLOCK_NUMBER = 30896500;
    const ACCOUNT_RECEIVING_FEES = 'steemsc';
    const STEEM_PEGGED_ACCOUNT = 'steemsc';
    const INITIAL_TOKEN_CREATION_FEE = '0';


    // tokens contract
    contractCode = `
    actions.createSSC = async (payload) => {
        await db.createTable('tokens', ['symbol']);
        await db.createTable('balances', ['account']);
        await db.createTable('contractsBalances', ['account']);
        await db.createTable('params');
    
        const params = {};
        params.tokenCreationFee = "0";
        await db.insert('params', params);
    }
    
    actions.updateParams = async (payload) => {
        if (sender !== owner) return;
    
        const { tokenCreationFee } = payload;
    
        const params = await db.findOne('params', {});
    
        params.tokenCreationFee = typeof tokenCreationFee === 'number' ? tokenCreationFee.toFixed(${BP_CONSTANTS.UTILITY_TOKEN_PRECISION}) : tokenCreationFee;
    
        await db.update('params', params);
    }
    
    actions.updateUrl = async (payload) => {
        const { url, symbol } = payload;
    
        if (assert(symbol && typeof symbol === 'string'
            && url && typeof url === 'string', 'invalid params')
            && assert(url.length <= 255, 'invalid url: max length of 255')) {
            // check if the token exists
            let token = await db.findOne('tokens', { symbol });
    
            if (token) {
                if (assert(token.issuer === sender, 'must be the issuer')) {
                  try {
                    let metadata = JSON.parse(token.metadata);

                    if(assert(metadata && metadata.url, 'an error occured when trying to update the url')) {
                      metadata.url = url;
                      token.metadata = JSON.stringify(metadata);
                      await db.update('tokens', token);
                    }
                  } catch(e) {
                    // error when parsing the metadata
                  }
                }
            }
        }
    }

    actions.updateMetadata = async (payload) => {
      const { metadata, symbol } = payload;

      if (assert(symbol && typeof symbol === 'string'
          && metadata && typeof metadata === 'object', 'invalid params')) {
          // check if the token exists
          let token = await db.findOne('tokens', { symbol });
  
          if (token) {
              if (assert(token.issuer === sender, 'must be the issuer')) {

                try {
                  const finalMetadata = JSON.stringify(metadata);

                  if (assert(finalMetadata.length <= 1000, 'invalid metadata: max length of 1000')) {
                    token.metadata = finalMetadata;
                    await db.update('tokens', token);
                  }
                } catch(e) {
                  // error when stringifying the metadata
                }
              }
          }
      }
    }
    
    const createVOne = async (payload) => {
        const { name, symbol, url, precision, maxSupply, isSignedWithActiveKey } = payload;
    
        // get contract params
        const params = await db.findOne('params', {});
        const { tokenCreationFee } = params;
    
        // get sender's UTILITY_TOKEN_SYMBOL balance
        const utilityTokenBalance = await db.findOne('balances', { account: sender, symbol: "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}" });
    
        const authorizedCreation = BigNumber(tokenCreationFee).lte("0") ? true : utilityTokenBalance && BigNumber(utilityTokenBalance.balance).gte(tokenCreationFee);
    
        if (assert(authorizedCreation, 'you must have enough tokens to cover the creation fees')
            && assert(name && typeof name === 'string'
                && symbol && typeof symbol === 'string'
                && (url === undefined || (url && typeof url === 'string'))
                && (precision && typeof precision === 'number' || precision === 0)
                && maxSupply && typeof maxSupply === 'number', 'invalid params')) {
    
            // the precision must be between 0 and 8 and must be an integer
            // the max supply must be positive
            if (assert(validator.isAlpha(symbol) && validator.isUppercase(symbol) && symbol.length > 0 && symbol.length <= 10, 'invalid symbol: uppercase letters only, max length of 10')
                && assert(validator.isAlphanumeric(validator.blacklist(name, ' ')) && name.length > 0 && name.length <= 50, 'invalid name: letters, numbers, whitespaces only, max length of 50')
                && assert(url === undefined || url.length <= 255, 'invalid url: max length of 255')
                && assert((precision >= 0 && precision <= 8) && (Number.isInteger(precision)), 'invalid precision')
                && assert(maxSupply > 0, 'maxSupply must be positive')
                && assert(maxSupply <= 1000000000000, 'maxSupply must be lower than 1000000000000')) {
    
                // check if the token already exists
                let token = await db.findOne('tokens', { symbol });
    
                if (assert(token === null, 'symbol already exists')) {
                    const finalUrl = url === undefined ? '' : url;
    
                    let metadata = {
                      url: finalUrl
                    }
    
                    metadata = JSON.stringify(metadata);
                    
                    const newToken = {
                        issuer: sender,
                        symbol,
                        name,
                        metadata,
                        precision,
                        maxSupply,
                        supply: 0,
                        circulatingSupply: 0,
                    };
    
                    await db.insert('tokens', newToken);
    
                    // burn the token creation fees
                    if (BigNumber(tokenCreationFee).gt(0)) {
                        await actions.transfer({ to: 'null', symbol: "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", quantity: BigNumber(tokenCreationFee).toNumber(), isSignedWithActiveKey });
                    }
                }
            }
        }
    }
    
    const createVTwo = async (payload) => {
        const { name, symbol, url, precision, maxSupply, isSignedWithActiveKey } = payload;
    
        // get contract params
        const params = await db.findOne('params', {});
        const { tokenCreationFee } = params;
    
        // get sender's UTILITY_TOKEN_SYMBOL balance
        const utilityTokenBalance = await db.findOne('balances', { account: sender, symbol: "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}" });
    
        const authorizedCreation = BigNumber(tokenCreationFee).lte(0) ? true : utilityTokenBalance && BigNumber(utilityTokenBalance.balance).gte(tokenCreationFee);
    
        if (assert(authorizedCreation, 'you must have enough tokens to cover the creation fees')
            && assert(name && typeof name === 'string'
                && symbol && typeof symbol === 'string'
                && (url === undefined || (url && typeof url === 'string'))
                && (precision && typeof precision === 'number' || precision === 0)
                && maxSupply && typeof maxSupply === 'string' && !BigNumber(maxSupply).isNaN(), 'invalid params')) {
    
            // the precision must be between 0 and 8 and must be an integer
            // the max supply must be positive
            if (assert(validator.isAlpha(symbol) && validator.isUppercase(symbol) && symbol.length > 0 && symbol.length <= 10, 'invalid symbol: uppercase letters only, max length of 10')
                && assert(validator.isAlphanumeric(validator.blacklist(name, ' ')) && name.length > 0 && name.length <= 50, 'invalid name: letters, numbers, whitespaces only, max length of 50')
                && assert(url === undefined || url.length <= 255, 'invalid url: max length of 255')
                && assert((precision >= 0 && precision <= 8) && (Number.isInteger(precision)), 'invalid precision')
                && assert(BigNumber(maxSupply).gt(0), 'maxSupply must be positive')
                && assert(BigNumber(maxSupply).lte(Number.MAX_SAFE_INTEGER), 'maxSupply must be lower than ' + Number.MAX_SAFE_INTEGER)) {
    
                // check if the token already exists
                let token = await db.findOne('tokens', { symbol });
    
                if (assert(token === null, 'symbol already exists')) {
                  const finalUrl = url === undefined ? '' : url;
    
                  let metadata = {
                    url: finalUrl
                  }
  
                  metadata = JSON.stringify(metadata);
                    const newToken = {
                        issuer: sender,
                        symbol,
                        name,
                        metadata,
                        precision,
                        maxSupply: BigNumber(maxSupply).toFixed(precision),
                        supply: "0",
                        circulatingSupply: "0",
                    };
    
                    await db.insert('tokens', newToken);
    
                    // burn the token creation fees
                    if (BigNumber(tokenCreationFee).gt(0)) {
                        await actions.transfer({ to: 'null', symbol: "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", quantity: tokenCreationFee, isSignedWithActiveKey });
                    }
                }
            }
        }
    }
    
    actions.create = async (payload) => {
        if (refSteemBlockNumber < ${FORK_BLOCK_NUMBER}) {
            await createVOne(payload);
        } else {
            await createVTwo(payload);
        }
    }
    
    const issueVOne = async (payload) => {
        const { to, symbol, quantity, isSignedWithActiveKey } = payload;
    
        if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
            && assert(to && typeof to === 'string'
                && symbol && typeof symbol === 'string'
                && quantity && typeof quantity === 'number', 'invalid params')) {
    
            let token = await db.findOne('tokens', { symbol });
    
            // the symbol must exist
            // the sender must be the issuer
            // then we need to check that the quantity is correct
            if (assert(token !== null, 'symbol does not exist')
                && assert(token.issuer === sender, 'not allowed to issue tokens')
                && assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
                && assert(quantity > 0, 'must issue positive quantity')
                && assert(quantity <= (BigNumber(token.maxSupply).minus(token.supply).toNumber()), 'quantity exceeds available supply')) {
    
                // a valid steem account is between 3 and 16 characters in length
                if (assert(to.length >= 3 && to.length <= 16, 'invalid to')) {
                    // we made all the required verification, let's now issue the tokens
    
                    let res = await addBalanceVOne(token.issuer, token, quantity, 'balances');
    
                    if (res === true && to !== token.issuer) {
                        if (await subBalanceVOne(token.issuer, token, quantity, 'balances')) {
                            res = await addBalanceVOne(to, token, quantity, 'balances');
    
                            if (res === false) {
                                await addBalanceVOne(token.issuer, token, quantity, 'balances');
                            }
                        }
                    }
    
                    if (res === true) {
                        token.supply = calculateBalanceVOne(token.supply, quantity, token.precision, true);
    
                        if (to !== 'null') {
                            token.circulatingSupply = calculateBalanceVOne(token.circulatingSupply, quantity, token.precision, true);
                        }
    
                        await db.update('tokens', token);
    
                        emit('transferFromContract', { from: 'tokens', to, symbol, quantity });
                    }
                }
            }
        }
    }
    
    const issueVTwo = async (payload) => {
        const { to, symbol, quantity, isSignedWithActiveKey } = payload;
    
        if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
            && assert(to && typeof to === 'string'
                && symbol && typeof symbol === 'string'
                && quantity && typeof quantity === 'string' && !BigNumber(quantity).isNaN(), 'invalid params')) {
    
            let token = await db.findOne('tokens', { symbol });
    
            // the symbol must exist
            // the sender must be the issuer
            // then we need to check that the quantity is correct
            if (assert(token !== null, 'symbol does not exist')
                && assert(token.issuer === sender, 'not allowed to issue tokens')
                && assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
                && assert(BigNumber(quantity).gt(0), 'must issue positive quantity')
                && assert(BigNumber(token.maxSupply).minus(token.supply).gte(quantity), 'quantity exceeds available supply')) {
    
                // a valid steem account is between 3 and 16 characters in length
                if (assert(to.length >= 3 && to.length <= 16, 'invalid to')) {
                    // we made all the required verification, let's now issue the tokens
    
                    let res = await addBalanceVTwo(token.issuer, token, quantity, 'balances');
    
                    if (res === true && to !== token.issuer) {
                        if (await subBalanceVTwo(token.issuer, token, quantity, 'balances')) {
                            res = await addBalanceVTwo(to, token, quantity, 'balances');
    
                            if (res === false) {
                                await addBalanceVTwo(token.issuer, token, quantity, 'balances');
                            }
                        }
                    }
    
                    if (res === true) {
                        token.supply = calculateBalanceVTwo(token.supply, quantity, token.precision, true);
    
                        if (to !== 'null') {
                            token.circulatingSupply = calculateBalanceVTwo(token.circulatingSupply, quantity, token.precision, true);
                        }
    
                        await db.update('tokens', token);
    
                        emit('transferFromContract', { from: 'tokens', to, symbol, quantity });
                    }
                }
            }
        }
    }
    
    actions.issue = async (payload) => {
        if (refSteemBlockNumber < ${FORK_BLOCK_NUMBER}) {
            await issueVOne(payload);
        } else {
            await issueVTwo(payload);
        }
    }
    
    const transferVOne = async (payload) => {
        const { to, symbol, quantity, isSignedWithActiveKey } = payload;
    
        if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
            && assert(to && typeof to === 'string'
                && symbol && typeof symbol === 'string'
                && quantity && typeof quantity === 'number', 'invalid params')) {
    
            if (assert(to !== sender, 'cannot transfer to self')) {
                // a valid steem account is between 3 and 16 characters in length
                if (assert(to.length >= 3 && to.length <= 16, 'invalid to')) {
                    let token = await db.findOne('tokens', { symbol });
    
                    // the symbol must exist
                    // then we need to check that the quantity is correct
                    if (assert(token !== null, 'symbol does not exist')
                        && assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
                        && assert(quantity > 0, 'must transfer positive quantity')) {
    
                        if (await subBalanceVOne(sender, token, quantity, 'balances')) {
                            const res = await addBalanceVOne(to, token, quantity, 'balances');
    
                            if (res === false) {
                                await addBalanceVOne(sender, token, quantity, 'balances');
    
                                return false;
                            }
    
                            if (to === 'null') {
                                token.circulatingSupply = calculateBalanceVOne(token.circulatingSupply, quantity, token.precision, false);
                                await db.update('tokens', token);
                            }
    
                            emit('transfer', { from: sender, to, symbol, quantity });
    
                            return true;
                        }
                    }
                }
            }
        }
    
        return false;
    }
    
    const transferVTwo = async (payload) => {
        const { to, symbol, quantity, isSignedWithActiveKey } = payload;
    
        if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
            && assert(to && typeof to === 'string'
                && symbol && typeof symbol === 'string'
                && quantity && typeof quantity === 'string' && !BigNumber(quantity).isNaN(), 'invalid params')) {
    
            if (assert(to !== sender, 'cannot transfer to self')) {
                // a valid steem account is between 3 and 16 characters in length
                if (assert(to.length >= 3 && to.length <= 16, 'invalid to')) {
                    let token = await db.findOne('tokens', { symbol });
    
                    // the symbol must exist
                    // then we need to check that the quantity is correct
                    if (assert(token !== null, 'symbol does not exist')
                        && assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
                        && assert(BigNumber(quantity).gt(0), 'must transfer positive quantity')) {
    
                        if (await subBalanceVTwo(sender, token, quantity, 'balances')) {
                            const res = await addBalanceVTwo(to, token, quantity, 'balances');
    
                            if (res === false) {
                                await addBalanceVTwo(sender, token, quantity, 'balances');
    
                                return false;
                            }
    
                            if (to === 'null') {
                                token.circulatingSupply = calculateBalanceVTwo(token.circulatingSupply, quantity, token.precision, false);
                                await db.update('tokens', token);
                            }
    
                            emit('transfer', { from: sender, to, symbol, quantity });
    
                            return true;
                        }
                    }
                }
            }
        }
    
        return false;
    }
    
    actions.transfer = async (payload) => {
        if (refSteemBlockNumber < ${FORK_BLOCK_NUMBER}) {
            await transferVOne(payload);
        } else {
            await transferVTwo(payload);
        }
    }
    
    actions.transferToContract = async (payload) => {
        const { to, symbol, quantity, isSignedWithActiveKey } = payload;
    
        if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
            && assert(to && typeof to === 'string'
                && symbol && typeof symbol === 'string'
                && quantity && typeof quantity === 'string' && !BigNumber(quantity).isNaN(), 'invalid params')) {
    
            if (assert(to !== sender, 'cannot transfer to self')) {
                // a valid contract account is between 3 and 50 characters in length
                if (assert(to.length >= 3 && to.length <= 50, 'invalid to')) {
                    let token = await db.findOne('tokens', { symbol });
    
                    // the symbol must exist
                    // then we need to check that the quantity is correct
                    if (assert(token !== null, 'symbol does not exist')
                        && assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
                        && assert(BigNumber(quantity).gt(0), 'must transfer positive quantity')) {
    
                        if (await subBalanceVTwo(sender, token, quantity, 'balances')) {
                            const res = await addBalanceVTwo(to, token, quantity, 'contractsBalances');
    
                            if (res === false) {
                                await addBalanceVTwo(sender, token, quantity, 'balances');
                            } else {
                                if (to === 'null') {
                                    token.circulatingSupply = calculateBalanceVTwo(token.circulatingSupply, quantity, token.precision, false);
                                    await db.update('tokens', token);
                                }
    
                                emit('transferToContract', { from: sender, to, symbol, quantity });
                            }
                        }
                    }
                }
            }
        }
    }
    
    actions.transferFromContract = async (payload) => {
        // this action can only be called by the 'null' account which only the core code can use
        if (assert(sender === 'null', 'not authorized')) {
            const { from, to, symbol, quantity, type, isSignedWithActiveKey } = payload;
            const types = ['user', 'contract'];
    
            if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
                && assert(to && typeof to === 'string'
                    && from && typeof from === 'string'
                    && symbol && typeof symbol === 'string'
                    && type && (types.includes(type))
                    && quantity && typeof quantity === 'string' && !BigNumber(quantity).isNaN(), 'invalid params')) {
    
                const table = type === 'user' ? 'balances' : 'contractsBalances';
    
                if (assert(type === 'user' || (type === 'contract' && to !== from), 'cannot transfer to self')) {
                    // validate the "to"
                    let toValid = type === 'user' ? to.length >= 3 && to.length <= 16 : to.length >= 3 && to.length <= 50;
    
                    // the account must exist
                    if (assert(toValid === true, 'invalid to')) {
                        let token = await db.findOne('tokens', { symbol });
    
                        // the symbol must exist
                        // then we need to check that the quantity is correct
                        if (assert(token !== null, 'symbol does not exist')
                            && assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
                            && assert(BigNumber(quantity).gt(0), 'must transfer positive quantity')) {
    
                            if (await subBalanceVTwo(from, token, quantity, 'contractsBalances')) {
                                const res = await addBalanceVTwo(to, token, quantity, table);
    
                                if (res === false) {
                                    await addBalanceVTwo(from, token, quantity, 'contractsBalances');
                                } else {
                                    if (to === 'null') {
                                        token.circulatingSupply = calculateBalanceVTwo(token.circulatingSupply, quantity, token.precision, false);
                                        await db.update('tokens', token);
                                    }
    
                                    emit('transferFromContract', { from, to, symbol, quantity });
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    const subBalanceVOne = async (account, token, quantity, table) => {
      let balance = await db.findOne(table, { account, 'symbol': token.symbol });
      if (assert(balance !== null, 'balance does not exist') &&
        assert(balance.balance >= quantity, 'overdrawn balance')) {
        const originalBalance = balance.balance;

        balance.balance = calculateBalanceVOne(balance.balance, quantity, token.precision, false);

        if (assert(balance.balance < originalBalance, 'cannot subtract')) {
          await db.update(table, balance);

          return true;
        }          
      }

      return false;
    }

    const subBalanceVTwo = async (account, token, quantity, table) => {
      let balance = await db.findOne(table, { account, 'symbol': token.symbol });

      if (assert(balance !== null, 'balance does not exist') &&
          assert(BigNumber(balance.balance).gte(quantity), 'overdrawn balance')) {
          const originalBalance = balance.balance;
  
          balance.balance = calculateBalanceVTwo(balance.balance, quantity, token.precision, false);

          if (assert(BigNumber(balance.balance).lt(originalBalance), 'cannot subtract')) {
              await db.update(table, balance);
  
              return true;
          }
      }
  
      return false;
  }
    
    const addBalanceVOne = async (account, token, quantity, table) => {
      let balance = await db.findOne(table, { account, 'symbol': token.symbol });
      if (balance === null) {
        balance = {
          account,
          'symbol': token.symbol,
          'balance': quantity
        }
        
        await db.insert(table, balance);

        return true;
      } else {
        const originalBalance = balance.balance;

        balance.balance = calculateBalanceVOne(balance.balance, quantity, token.precision, true);
        if (assert(balance.balance > originalBalance, 'cannot add')) {
          await db.update(table, balance);
          return true;
        }

        return false;
      }
    }

    const addBalanceVTwo = async (account, token, quantity, table) => {
      let balance = await db.findOne(table, { account, 'symbol': token.symbol });
      if (balance === null) {
          balance = {
              account,
              'symbol': token.symbol,
              'balance': quantity
          }
  
          await db.insert(table, balance);
  
          return true;
      } else {
          const originalBalance = balance.balance;
  
          balance.balance = calculateBalanceVTwo(balance.balance, quantity, token.precision, true);
          if (assert(BigNumber(balance.balance).gt(originalBalance), 'cannot add')) {
              await db.update(table, balance);
              return true;
          }
  
          return false;
      }
  }
    
  const calculateBalanceVOne = function (balance, quantity, precision, add) {
    if (precision === 0) {
      return add ? balance + quantity : balance - quantity
    }

    return add ? BigNumber(balance).plus(quantity).toNumber() : BigNumber(balance).minus(quantity).toNumber()
  }

    const calculateBalanceVTwo = function (balance, quantity, precision, add) {
      return add ? BigNumber(balance).plus(quantity).toFixed(precision) : BigNumber(balance).minus(quantity).toFixed(precision);
  }
    
    const countDecimals = function (value) {
        return BigNumber(value).dp();
    }
    `;

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: 'tokens',
      params: '',
      code: base64ContractCode,
    };

    transactions.push(new Transaction(genesisSteemBlock, 0, 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));

    // sscstore contract
    contractCode = `
    actions.createSSC = async (payload) => {
      await db.createTable('params');
      const params = {};
      
      params.priceSBD = "1000000";
      params.priceSteem = "0.001";
      params.quantity = "0.001";
      params.disabled = false;

      await db.insert('params', params);      
    }

    actions.updateParams = async (payload) => {
      if (sender !== owner) return;

      const { priceSBD, priceSteem, quantity, disabled } = payload;

      const params = await db.findOne('params', { });

      params.priceSBD = priceSBD;
      params.priceSteem = priceSteem;
      params.quantity = quantity;
      params.disabled = disabled;

      await db.update('params', params);
    }

    actions.buy = async (payload) => {
      const { recipient, amountSTEEMSBD, isSignedWithActiveKey } = payload;

      if (recipient !== owner) return;

      if (assert(recipient && amountSTEEMSBD && isSignedWithActiveKey, 'invalid params')) {
        const params = await db.findOne('params', { });

        if (params.disabled) return;

        const res = amountSTEEMSBD.split(' ');
  
        const amount = res[0];
        const unit = res[1];
  
        let quantity = 0;
        let quantityToSend = 0;
        BigNumber.set({ DECIMAL_PLACES: 3 });

        // STEEM
        if (unit === 'STEEM') {
          quantity = BigNumber(amount).dividedBy(params.priceSteem);
        } 
        // SBD (disabled)
        else {
          // quantity = BigNumber(amount).dividedBy(params.priceSBD);
        }
  
        if (refSteemBlockNumber < ${FORK_BLOCK_NUMBER}) {
          quantityToSend = Number(BigNumber(quantity).multipliedBy(params.quantity).toFixed(${BP_CONSTANTS.UTILITY_TOKEN_PRECISION}));
        } else {
          quantityToSend = BigNumber(quantity).multipliedBy(params.quantity).toFixed(${BP_CONSTANTS.UTILITY_TOKEN_PRECISION});
        }

        if (quantityToSend > 0) {
          await executeSmartContractAsOwner('tokens', 'transfer', { symbol: "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", quantity: quantityToSend, to: sender })
        }
      }
    }
    `;

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: 'sscstore',
      params: '',
      code: base64ContractCode,
    };

    transactions.push(new Transaction(genesisSteemBlock, 0, 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));

    // steem-pegged asset contract
    contractCode = `
    actions.createSSC = async (payload) => {
      await db.createTable('withdrawals'); 
    }

    actions.buy = async (payload) => {
      const { recipient, amountSTEEMSBD, isSignedWithActiveKey } = payload;

      if (recipient !== owner) return;

      if (recipient && amountSTEEMSBD && isSignedWithActiveKey) {
        const res = amountSTEEMSBD.split(' ');
  
        const unit = res[1];
  
        // STEEM
        if (assert(unit === 'STEEM', 'only STEEM can be used')) {
          let quantityToSend = res[0];

          // calculate the 1% fee (with a min of 0.001 STEEM)
          let fee = BigNumber(quantityToSend).multipliedBy(0.01).toFixed(3);

          if (BigNumber(fee).lt("0.001")) {
            fee = "0.001";
          }
  
          quantityToSend = BigNumber(quantityToSend).minus(fee).toFixed(3);

          if (BigNumber(quantityToSend).gt(0)) {
            await executeSmartContractAsOwner('tokens', 'transfer', { symbol: "STEEMP", quantity: quantityToSend, to: sender })
          }

          if (BigNumber(fee).gt(0)) {
            const memo = 'fee tx ' + transactionId;
            await initiateWithdrawal(transactionId + '-fee', '${ACCOUNT_RECEIVING_FEES}', fee, memo);
          }
        } 
        // SBD
        else {
          // not supported
        }
      }
    }

    actions.withdraw = async (payload) => {
      const { quantity, isSignedWithActiveKey } = payload;

      if (assert(
          quantity && typeof quantity === 'string' && !BigNumber(quantity).isNaN() 
          && BigNumber(quantity).gt(0)
          && isSignedWithActiveKey, 'invalid params')) {

        // calculate the 1% fee (with a min of 0.001 STEEM)
        let fee = BigNumber(quantity).multipliedBy(0.01).toFixed(3);

        if (BigNumber(fee).lt("0.001")) {
          fee = "0.001";
        }

        const quantityToSend = BigNumber(quantity).minus(fee).toFixed(3);

        if (BigNumber(quantityToSend).gt(0)) {
          const res = await executeSmartContract('tokens', 'transfer', { symbol: "STEEMP", quantity, to: owner });
 
          if (res.errors === undefined &&
              res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transfer' && el.data.from === sender && el.data.to === owner && el.data.quantity === quantity && el.data.symbol === "STEEMP") !== undefined) {
            // withdrawal
            const memo = 'withdrawal tx ' + transactionId;

            await initiateWithdrawal(transactionId, sender, quantityToSend, memo);
          }
        }

        if (BigNumber(fee).gt(0)) {
          const memo = 'fee tx ' + transactionId;
          await initiateWithdrawal(transactionId + '-fee', '${ACCOUNT_RECEIVING_FEES}', fee, memo);
        }
      }
    }

    actions.removeWithdrawal = async (payload) => {
      const { id, isSignedWithActiveKey } = payload;

      if (sender !== owner) return;

      if (id && isSignedWithActiveKey) {
        const withdrawal = await db.findOne('withdrawals', { id });

        if (withdrawal) {
          await db.remove('withdrawals', withdrawal);
        }
      }
    }

    const initiateWithdrawal = async (id, recipient, quantity, memo) => {
        const withdrawal = {};
        
        withdrawal.id = id;
        withdrawal.type = 'STEEM';
        withdrawal.recipient = recipient;
        withdrawal.memo = memo;
        withdrawal.quantity = quantity;

        await db.insert('withdrawals', withdrawal); 
    }
    `;

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: 'steempegged',
      params: '',
      code: base64ContractCode,
    };

    transactions.push(new Transaction(genesisSteemBlock, 0, STEEM_PEGGED_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));

    contractCode = `
    const STEEM_PEGGED_SYMBOL = 'STEEMP';
    const CONTRACT_NAME = 'market';

    actions.createSSC = async (payload) => {
        await db.createTable('buyBook', ['symbol', 'account', 'price', 'expiration']);
        await db.createTable('sellBook', ['symbol', 'account', 'price', 'expiration']);
        await db.createTable('tradesHistory', ['symbol']);
        await db.createTable('metrics', ['symbol']);
    };

    actions.cancel = async (payload) => {
        const { type, id, isSignedWithActiveKey } = payload;

        const types = ['buy', 'sell'];

        if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
            && assert(type && types.includes(type)
                && id && Number.isInteger(id), 'invalid params')) {
            const table = type === 'buy' ? 'buyBook' : 'sellBook';
            // get order
            const order = await db.findOne(table, { $loki: id });

            if (assert(order, 'order does not exist')
                && order.account === sender) {
                let quantity;
                let symbol;

                if (type === 'buy') {
                    symbol = STEEM_PEGGED_SYMBOL;
                    quantity = order.tokensLocked;
                } else {
                    symbol = order.symbol;
                    quantity = order.quantity;
                }

                // unlock tokens
                await transferTokens(sender, symbol, quantity, 'user');

                await db.remove(table, order);

                if (type === 'sell') {
                    await updateAskMetric(order.symbol);
                } else {
                    await updateBidMetric(order.symbol);
                }
            }
        }
    }

    actions.buy = async (payload) => {
        const { symbol, quantity, price, expiration, isSignedWithActiveKey } = payload;

        // buy (quantity) of (symbol) at (price)(STEEM_PEGGED_SYMBOL) per (symbol)
        if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
            && assert(
                price && typeof price === 'string' && !BigNumber(price).isNaN()
                && symbol && typeof symbol === 'string' && symbol !== STEEM_PEGGED_SYMBOL
                && quantity && typeof quantity === 'string' && !BigNumber(quantity).isNaN()
                && (expiration === undefined || (expiration && Number.isInteger(expiration) && expiration > 0)), 'invalid params')) {

            // get the token params
            const token = await db.findOneInTable('tokens', 'tokens', { symbol });

            // perform a few verifications
            if (assert(token
                && BigNumber(price).gt(0)
                && countDecimals(price) <= 3
                && countDecimals(quantity) <= token.precision, 'invalid params')) {
                // initiate a transfer from sender to contract balance

                const nbTokensToLock = BigNumber(price).multipliedBy(quantity).toFixed(3);

                if (assert(BigNumber(nbTokensToLock).gte('0.001'), 'order cannot be placed and it cannot be filled')) {
                // lock STEEM_PEGGED_SYMBOL tokens
                const res = await executeSmartContract('tokens', 'transferToContract', { symbol: STEEM_PEGGED_SYMBOL, quantity: nbTokensToLock, to: CONTRACT_NAME });

                if (res.errors === undefined &&
                    res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === sender && el.data.to === CONTRACT_NAME && el.data.quantity === nbTokensToLock && el.data.symbol === STEEM_PEGGED_SYMBOL) !== undefined) {
                    const timestampSec = BigNumber(new Date(steemBlockTimestamp + '.000Z').getTime())
                        .dividedBy(1000)
                        .toNumber();

                    // order
                    const order = {};

                    order.txId = transactionId;
                    order.timestamp = timestampSec;
                    order.account = sender;
                    order.symbol = symbol;
                    order.quantity = quantity;
                    order.price = price;
                    order.tokensLocked = nbTokensToLock;
                    order.expiration = expiration === undefined || expiration > 2592000 ? timestampSec + 2592000 : timestampSec + expiration;

                    const orderInDB = await db.insert('buyBook', order);

                    await findMatchingSellOrders(orderInDB, token.precision);
                }
                }
            }
        }
    };

    actions.sell = async (payload) => {
        const { symbol, quantity, price, expiration, isSignedWithActiveKey } = payload;
        // sell (quantity) of (symbol) at (price)(STEEM_PEGGED_SYMBOL) per (symbol)
        if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
            && assert(
                price && typeof price === 'string' && !BigNumber(price).isNaN()
                && symbol && typeof symbol === 'string' && symbol !== STEEM_PEGGED_SYMBOL
                && quantity && typeof quantity === 'string' && !BigNumber(quantity).isNaN()
                && (expiration === undefined || (expiration && Number.isInteger(expiration) && expiration > 0)), 'invalid params')) {

            // get the token params
            const token = await db.findOneInTable('tokens', 'tokens', { symbol });

            // perform a few verifications
            if (assert(token
                && BigNumber(price).gt(0)
                && countDecimals(price) <= 3
                && countDecimals(quantity) <= token.precision, 'invalid params')) {

                const nbTokensToFillOrder = BigNumber(price).multipliedBy(quantity).toFixed(3);

                if (assert(BigNumber(nbTokensToFillOrder).gte('0.001'), 'order cannot be placed and it cannot be filled')) {
                // initiate a transfer from sender to contract balance
                // lock symbol tokens
                const res = await executeSmartContract('tokens', 'transferToContract', { symbol, quantity, to: CONTRACT_NAME });

                if (res.errors === undefined &&
                    res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === sender && el.data.to === CONTRACT_NAME && el.data.quantity === quantity && el.data.symbol === symbol) !== undefined) {
                    const timestampSec = BigNumber(new Date(steemBlockTimestamp + '.000Z').getTime())
                        .dividedBy(1000)
                        .toNumber();

                    // order
                    const order = {};

                    order.txId = transactionId;
                    order.timestamp = timestampSec;
                    order.account = sender;
                    order.symbol = symbol;
                    order.quantity = quantity;
                    order.price = price;
                    order.expiration = expiration === undefined || expiration > 2592000 ? timestampSec + 2592000 : timestampSec + expiration;

                    const orderInDB = await db.insert('sellBook', order);

                    await findMatchingBuyOrders(orderInDB, token.precision);
                }
                }
            }
        }
    };

    const findMatchingSellOrders = async (order, tokenPrecision) => {
        const { txId, account, symbol, quantity, price } = order;

        const buyOrder = order;
        let offset = 0;

        await removeExpiredOrders('sellBook');

        // get the orders that match the symbol and the price
        let sellOrderBook = await db.find('sellBook', {
            symbol,
            price: {
                $lte: price,
            },
        }, 1000, offset,
            [
                { index: 'price', descending: false },
                { index: '$loki', descending: false },
            ]);

        do {
            const nbOrders = sellOrderBook.length;
            let inc = 0;

            while (inc < nbOrders && BigNumber(buyOrder.quantity).gt(0)) {
                const sellOrder = sellOrderBook[inc];
                if (BigNumber(buyOrder.quantity).lte(sellOrder.quantity)) {

                    let qtyTokensToSend = BigNumber(sellOrder.price)
                        .multipliedBy(buyOrder.quantity)
                        .toFixed(3);

                    if (BigNumber(qtyTokensToSend).gt(buyOrder.tokensLocked)) {
                        qtyTokensToSend = BigNumber(sellOrder.price)
                            .multipliedBy(buyOrder.quantity)
                            .toFixed(3, BigNumber.ROUND_DOWN);
                    }

                    if (assert(BigNumber(qtyTokensToSend).gt(0)
                        && BigNumber(buyOrder.quantity).gt(0), 'the order cannot be filled')) {

                        // transfer the tokens to the buyer
                        await transferTokens(account, symbol, buyOrder.quantity, 'user');

                        // transfer the tokens to the seller
                        await transferTokens(sellOrder.account, STEEM_PEGGED_SYMBOL, qtyTokensToSend, 'user');

                        // update the sell order
                        const qtyLeftSellOrder = BigNumber(sellOrder.quantity).minus(buyOrder.quantity).toFixed(tokenPrecision);
                        const nbTokensToFillOrder = BigNumber(sellOrder.price).multipliedBy(qtyLeftSellOrder).toFixed(3);

                        if (BigNumber(qtyLeftSellOrder).gt(0)
                        && BigNumber(nbTokensToFillOrder).gte('0.001')) {
                            sellOrder.quantity = qtyLeftSellOrder;

                            await db.update('sellBook', sellOrder);
                        } else {
                        if (BigNumber(qtyLeftSellOrder).gt(0)) {
                            await transferTokens(sellOrder.account, symbol, qtyLeftSellOrder, 'user');
                        }
                            await db.remove('sellBook', sellOrder);
                        }

                        // unlock remaining tokens, update the quantity to get and remove the buy order
                        const tokensToUnlock = BigNumber(buyOrder.tokensLocked).minus(qtyTokensToSend).toFixed(3);

                        if (BigNumber(tokensToUnlock).gt(0)) {
                            await transferTokens(account, STEEM_PEGGED_SYMBOL, tokensToUnlock, 'user');
                        }

                        // add the trade to the history
                        await updateTradesHistory('buy', symbol, buyOrder.quantity, sellOrder.price);
                        // update the volume
                        await updateVolumeMetric(symbol, qtyTokensToSend);

                        buyOrder.quantity = "0";
                        await db.remove('buyBook', buyOrder);
                    }
                } else {
                    let qtyTokensToSend = BigNumber(sellOrder.price)
                        .multipliedBy(sellOrder.quantity)
                        .toFixed(3);

                    if (BigNumber(qtyTokensToSend).gt(buyOrder.tokensLocked)) {
                        qtyTokensToSend = BigNumber(sellOrder.price)
                            .multipliedBy(sellOrder.quantity)
                            .toFixed(3, BigNumber.ROUND_DOWN);
                    }

                    if (assert(BigNumber(qtyTokensToSend).gt(0)
                        && BigNumber(buyOrder.quantity).gt(0), 'the order cannot be filled')) {

                        // transfer the tokens to the buyer
                        await transferTokens(account, symbol, sellOrder.quantity, 'user');

                        // transfer the tokens to the seller
                        await transferTokens(sellOrder.account, STEEM_PEGGED_SYMBOL, qtyTokensToSend, 'user');

                        // remove the sell order
                        await db.remove('sellBook', sellOrder);

                        // update tokensLocked and the quantity to get
                        buyOrder.tokensLocked = BigNumber(buyOrder.tokensLocked).minus(qtyTokensToSend).toFixed(3);
                        buyOrder.quantity = BigNumber(buyOrder.quantity).minus(sellOrder.quantity).toFixed(tokenPrecision);

                        // check if the order can still be filled
                        const nbTokensToFillOrder = BigNumber(buyOrder.price).multipliedBy(buyOrder.quantity).toFixed(3);

                        if (BigNumber(nbTokensToFillOrder).lt('0.001')) {
                        await transferTokens(account, STEEM_PEGGED_SYMBOL, buyOrder.tokensLocked, 'user');

                        buyOrder.quantity = "0";
                        await db.remove('buyBook', buyOrder);
                        }

                        // add the trade to the history
                        await updateTradesHistory('buy', symbol, sellOrder.quantity, sellOrder.price);
                        // update the volume
                        await updateVolumeMetric(symbol, qtyTokensToSend);
                    }
                }

                inc += 1;
            }

            offset += 1000;

            if (BigNumber(buyOrder.quantity).gt(0)) {
                // get the orders that match the symbol and the price
                sellOrderBook = await db.find('sellBook', {
                    symbol,
                    price: {
                        $lte: price,
                    },
                }, 1000, offset,
                    [
                        { index: 'price', descending: false },
                        { index: '$loki', descending: false },
                    ]);
            }
        } while (sellOrderBook.length > 0 && BigNumber(buyOrder.quantity).gt(0));

        // update the buy order if partially filled
        if (BigNumber(buyOrder.quantity).gt(0)) {
            await db.update('buyBook', buyOrder);
        }

        await updateAskMetric(symbol);
        await updateBidMetric(symbol);
    };

    const findMatchingBuyOrders = async (order, tokenPrecision) => {
        const { txId, account, symbol, quantity, price } = order;

        const sellOrder = order;
        let offset = 0;

        await removeExpiredOrders('buyBook');

        // get the orders that match the symbol and the price
        let buyOrderBook = await db.find('buyBook', {
            symbol,
            price: {
                $gte: price,
            },
        }, 1000, offset,
            [
                { index: 'price', descending: true },
                { index: '$loki', descending: false },
            ]);

        do {
            const nbOrders = buyOrderBook.length;
            let inc = 0;

            while (inc < nbOrders && BigNumber(sellOrder.quantity).gt(0)) {
                const buyOrder = buyOrderBook[inc];
                if (BigNumber(sellOrder.quantity).lte(buyOrder.quantity)) {

                    let qtyTokensToSend = BigNumber(buyOrder.price)
                        .multipliedBy(sellOrder.quantity)
                        .toFixed(3);

                    if (BigNumber(qtyTokensToSend).gt(buyOrder.tokensLocked)) {
                        qtyTokensToSend = BigNumber(buyOrder.price)
                            .multipliedBy(sellOrder.quantity)
                            .toFixed(3, BigNumber.ROUND_DOWN);
                    }

                    if (assert(BigNumber(qtyTokensToSend).gt(0)
                        && BigNumber(sellOrder.quantity).gt(0), 'the order cannot be filled')) {
                        // transfer the tokens to the buyer
                        await transferTokens(buyOrder.account, symbol, sellOrder.quantity, 'user');

                        // transfer the tokens to the seller
                        await transferTokens(account, STEEM_PEGGED_SYMBOL, qtyTokensToSend, 'user');

                        // update the buy order
                        const qtyLeftBuyOrder = BigNumber(buyOrder.quantity).minus(sellOrder.quantity).toFixed(tokenPrecision);

                        const buyOrdertokensLocked = BigNumber(buyOrder.tokensLocked).minus(qtyTokensToSend).toFixed(3);
                        const nbTokensToFillOrder = BigNumber(buyOrder.price).multipliedBy(qtyLeftBuyOrder).toFixed(3);

                        if (BigNumber(qtyLeftBuyOrder).gt(0)
                            && BigNumber(nbTokensToFillOrder).gte('0.001')) {
                            buyOrder.quantity = qtyLeftBuyOrder;
                            buyOrder.tokensLocked = buyOrdertokensLocked;

                            await db.update('buyBook', buyOrder);
                        } else {
                            if (BigNumber(buyOrdertokensLocked).gt(0)) {
                                await transferTokens(buyOrder.account, STEEM_PEGGED_SYMBOL, buyOrdertokensLocked, 'user');
                            }
                            await db.remove('buyBook', buyOrder);
                        }

                        // add the trade to the history
                        await updateTradesHistory('sell', symbol, sellOrder.quantity, buyOrder.price);
                        // update the volume
                        await updateVolumeMetric(symbol, qtyTokensToSend);

                        sellOrder.quantity = 0;
                        await db.remove('sellBook', sellOrder);
                    }
                } else {

                    let qtyTokensToSend = BigNumber(buyOrder.price)
                        .multipliedBy(buyOrder.quantity)
                        .toFixed(3);

                    if (qtyTokensToSend > buyOrder.tokensLocked) {
                        qtyTokensToSend = BigNumber(buyOrder.price)
                            .multipliedBy(buyOrder.quantity)
                            .toFixed(3, BigNumber.ROUND_DOWN);
                    }

                    if (assert(BigNumber(qtyTokensToSend).gt(0)
                        && BigNumber(sellOrder.quantity).gt(0), 'the order cannot be filled')) {
                        // transfer the tokens to the buyer
                        await transferTokens(buyOrder.account, symbol, buyOrder.quantity, 'user');

                        // transfer the tokens to the seller
                        await transferTokens(account, STEEM_PEGGED_SYMBOL, qtyTokensToSend, 'user');

                        // remove the buy order
                        await db.remove('buyBook', buyOrder);

                        // update the quantity to get
                        sellOrder.quantity = BigNumber(sellOrder.quantity).minus(buyOrder.quantity).toFixed(tokenPrecision);

                        // check if the order can still be filled
                        const nbTokensToFillOrder = BigNumber(sellOrder.price).multipliedBy(sellOrder.quantity).toFixed(3);
                        
                        if (BigNumber(nbTokensToFillOrder).lt('0.001')) {
                        await transferTokens(account, symbol, sellOrder.quantity, 'user');

                        sellOrder.quantity = "0";
                        await db.remove('sellBook', sellOrder);
                        }

                        // add the trade to the history
                        await updateTradesHistory('sell', symbol, buyOrder.quantity, buyOrder.price);
                        // update the volume
                        await updateVolumeMetric(symbol, qtyTokensToSend);
                    }
                }

                inc += 1;
            }

            offset += 1000;

            if (BigNumber(sellOrder.quantity).gt(0)) {
                // get the orders that match the symbol and the price
                buyOrderBook = await db.find('buyBook', {
                    symbol,
                    price: {
                        $gte: price,
                    },
                }, 1000, offset,
                    [
                        { index: 'price', descending: true },
                        { index: '$loki', descending: false },
                    ]);
            }
        } while (buyOrderBook.length > 0 && BigNumber(sellOrder.quantity).gt(0));

        // update the sell order if partially filled
        if (BigNumber(sellOrder.quantity).gt(0)) {
            await db.update('sellBook', sellOrder);
        }

        await updateAskMetric(symbol);
        await updateBidMetric(symbol);
    };

    const removeExpiredOrders = async (table) => {
        const timestampSec = BigNumber(new Date(steemBlockTimestamp + '.000Z').getTime())
            .dividedBy(1000)
            .toNumber();

        // clean orders
        let ordersToDelete = await db.find(
            table,
            {
                expiration: {
                    $lte: timestampSec,
                },
            });

        while (ordersToDelete.length > 0) {
            ordersToDelete.forEach(async (order) => {
                await db.remove(table, order);
            });

            ordersToDelete = await db.find(
                table,
                {
                    expiration: {
                        $lte: timestampSec,
                    },
                });
        }
    }

    const getMetric = async (symbol) => {
        let metric = await db.findOne('metrics', { symbol });

        if (metric === null) {
            metric = {};
            metric.symbol = symbol;
            metric.volume = "0";
            metric.volumeExpiration = 0;
            metric.lastPrice = "0";
            metric.lowestAsk = "0";
            metric.highestBid = "0";
            metric.lastDayPrice = "0";
            metric.lastDayPriceExpiration = 0;
            metric.priceChangeSteem = "0";
            metric.priceChangePercent = "0";

            return await db.insert('metrics', metric);
        }

        return metric;
    }

    const updateVolumeMetric = async (symbol, quantity) => {
        const timestampSec = BigNumber(new Date(steemBlockTimestamp + '.000Z').getTime())
            .dividedBy(1000)
            .toNumber();

        let metric = await getMetric(symbol);

        if (metric.volumeExpiration < timestampSec) {
            metric.volume = quantity;
            metric.volumeExpiration = BigNumber(timestampSec).plus(86400).toNumber();
        } else {
            metric.volume = BigNumber(metric.volume).plus(quantity).toNumber();
        }

        await db.update('metrics', metric);
    }

    const updateBidMetric = async (symbol) => {
        let metric = await getMetric(symbol);

        const buyOrderBook = await db.find('buyBook',
            {
                symbol,
            }, 1, 0,
            [
                { index: 'price', descending: true },
            ]
        );


        if (buyOrderBook.length > 0) {
            metric.highestBid = buyOrderBook[0].price;
        } else {
            metric.highestBid = "0";
        }

        await db.update('metrics', metric);
    }

    const updateAskMetric = async (symbol) => {
        let metric = await getMetric(symbol);

        const sellOrderBook = await db.find('sellBook',
            {
                symbol,
            }, 1, 0,
            [
                { index: 'price', descending: false },
            ]
        );

        if (sellOrderBook.length > 0) {
            metric.lowestAsk = sellOrderBook[0].price;
        } else {
            metric.lowestAsk = "0";
        }

        await db.update('metrics', metric);
    }

    const updatePriceMetrics = async (symbol, price, timestamp) => {
        let metric = await getMetric(symbol);

        metric.lastPrice = price;

        if (metric.lastDayPriceExpiration < timestamp) {
            metric.lastDayPrice = price;
            metric.lastDayPriceExpiration = BigNumber(timestamp).plus(86400).toNumber();
            metric.priceChangeSteem = "0";
            metric.priceChangePercent = "0%";
        } else {
            metric.priceChangeSteem = BigNumber(price).minus(metric.lastDayPrice).toFixed(3);
            metric.priceChangePercent = BigNumber(metric.priceChangeSteem).dividedBy(metric.lastDayPrice).multipliedBy(100).toFixed(2) + '%';
        }

        await db.update('metrics', metric);
    }

    const updateTradesHistory = async (type, symbol, quantity, price) => {
        const timestampSec = BigNumber(new Date(steemBlockTimestamp + '.000Z').getTime())
            .dividedBy(1000)
            .toNumber();

        const timestampMinus24hrs = BigNumber(timestampSec).minus(86400).toNumber();

        // clean history
        let tradesToDelete = await db.find(
            'tradesHistory',
            {
                symbol,
                timestamp: {
                    $lt: timestampMinus24hrs,
                },
            });

        while (tradesToDelete.length > 0) {
            tradesToDelete.forEach(async (trade) => {
                await db.remove('tradesHistory', trade);
            });

            tradesToDelete = await db.find(
                'tradesHistory',
                {
                    symbol,
                    timestamp: {
                        $lt: timestampMinus24hrs,
                    },
                });
        }

        // add order to the history
        const newTrade = {};
        newTrade.type = type;
        newTrade.symbol = symbol;
        newTrade.quantity = quantity;
        newTrade.price = price;
        newTrade.timestamp = timestampSec;

        await db.insert('tradesHistory', newTrade);

        await updatePriceMetrics(symbol, price, timestampSec);
    }

    const countDecimals = function (value) {
        return BigNumber(value).dp();
    };
    `;

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: 'market',
      params: '',
      code: base64ContractCode,
    };

    transactions.push(new Transaction(genesisSteemBlock, 0, 'null', 'contract', 'deploy', JSON.stringify(contractPayload)));


    // bootstrap transactions
    transactions.push(new Transaction(genesisSteemBlock, 0, STEEM_PEGGED_ACCOUNT, 'tokens', 'create', '{ "name": "STEEM Pegged", "symbol": "STEEMP", "precision": 3, "maxSupply": 1000000000000 }'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'steemsc', 'tokens', 'updateParams', `{ "tokenCreationFee": "${INITIAL_TOKEN_CREATION_FEE}" }`));
    transactions.push(new Transaction(genesisSteemBlock, 0, STEEM_PEGGED_ACCOUNT, 'tokens', 'issue', `{ "symbol": "STEEMP", "to": "${STEEM_PEGGED_ACCOUNT}", "quantity": 1000000000000, "isSignedWithActiveKey": true }`));

    return transactions;
  }
}

module.exports.Bootstrap = Bootstrap;
