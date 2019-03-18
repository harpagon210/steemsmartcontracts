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
    const FORK_BLOCK_NUMBER_TWO = 30983000;
    const ACCOUNT_RECEIVING_FEES = 'steemsc';
    const STEEM_PEGGED_ACCOUNT = 'steemsc';
    const INITIAL_TOKEN_CREATION_FEE = '0';
    const SSC_STORE_PRICE = '0.001';
    const SSC_STORE_QTY = '1';


    // tokens contract
    contractCode = `
    actions.createSSC = async (payload) => {
        await api.db.createTable('tokens', ['symbol']);
        await api.db.createTable('balances', ['account']);
        await api.db.createTable('contractsBalances', ['account']);
        await api.db.createTable('params');
    
        const params = {};
        params.tokenCreationFee = "0";
        await api.db.insert('params', params);
    }
    
    actions.updateParams = async (payload) => {
        if (api.sender !== api.owner) return;
    
        const { tokenCreationFee } = payload;
    
        const params = await api.db.findOne('params', {});
    
        params.tokenCreationFee = typeof tokenCreationFee === 'number' ? tokenCreationFee.toFixed(${BP_CONSTANTS.UTILITY_TOKEN_PRECISION}) : tokenCreationFee;
    
        await api.db.update('params', params);
    }
    
    actions.updateUrl = async (payload) => {
        const { url, symbol } = payload;
    
        if (api.assert(symbol && typeof symbol === 'string'
            && url && typeof url === 'string', 'invalid params')
            && api.assert(url.length <= 255, 'invalid url: max length of 255')) {
            // check if the token exists
            let token = await api.db.findOne('tokens', { symbol });
    
            if (token) {
                if (api.assert(token.issuer === api.sender, 'must be the issuer')) {
                  try {
                    let metadata = JSON.parse(token.metadata);

                    if(api.assert(metadata && metadata.url, 'an error occured when trying to update the url')) {
                      metadata.url = url;
                      token.metadata = JSON.stringify(metadata);
                      await api.db.update('tokens', token);
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

      if (api.assert(symbol && typeof symbol === 'string'
          && metadata && typeof metadata === 'object', 'invalid params')) {
          // check if the token exists
          let token = await api.db.findOne('tokens', { symbol });
  
          if (token) {
              if (api.assert(token.issuer === api.sender, 'must be the issuer')) {

                try {
                  const finalMetadata = JSON.stringify(metadata);

                  if (api.assert(finalMetadata.length <= 1000, 'invalid metadata: max length of 1000')) {
                    token.metadata = finalMetadata;
                    await api.db.update('tokens', token);
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
        const params = await api.db.findOne('params', {});
        const { tokenCreationFee } = params;
    
        // get api.sender's UTILITY_TOKEN_SYMBOL balance
        const utilityTokenBalance = await api.db.findOne('balances', { account: api.sender, symbol: "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}" });
    
        const authorizedCreation = api.BigNumber(tokenCreationFee).lte("0") ? true : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(tokenCreationFee);
    
        if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fees')
            && api.assert(name && typeof name === 'string'
                && symbol && typeof symbol === 'string'
                && (url === undefined || (url && typeof url === 'string'))
                && (precision && typeof precision === 'number' || precision === 0)
                && maxSupply && typeof maxSupply === 'number', 'invalid params')) {
    
            // the precision must be between 0 and 8 and must be an integer
            // the max supply must be positive
            if (api.assert(api.validator.isAlpha(symbol) && api.validator.isUppercase(symbol) && symbol.length > 0 && symbol.length <= 10, 'invalid symbol: uppercase letters only, max length of 10')
                && api.assert(api.validator.isAlphanumeric(api.validator.blacklist(name, ' ')) && name.length > 0 && name.length <= 50, 'invalid name: letters, numbers, whitespaces only, max length of 50')
                && api.assert(url === undefined || url.length <= 255, 'invalid url: max length of 255')
                && api.assert((precision >= 0 && precision <= 8) && (Number.isInteger(precision)), 'invalid precision')
                && api.assert(maxSupply > 0, 'maxSupply must be positive')
                && api.assert(maxSupply <= 1000000000000, 'maxSupply must be lower than 1000000000000')) {
    
                // check if the token already exists
                let token = await api.db.findOne('tokens', { symbol });
    
                if (api.assert(token === null, 'symbol already exists')) {
                    const finalUrl = url === undefined ? '' : url;
    
                    let metadata = {
                      url: finalUrl
                    }
    
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
                        await actions.transfer({ to: 'null', symbol: "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", quantity: api.BigNumber(tokenCreationFee).toNumber(), isSignedWithActiveKey });
                    }
                }
            }
        }
    }
    
    const createVTwo = async (payload) => {
        const { name, symbol, url, precision, maxSupply, isSignedWithActiveKey } = payload;
    
        // get contract params
        const params = await api.db.findOne('params', {});
        const { tokenCreationFee } = params;
    
        // get api.sender's UTILITY_TOKEN_SYMBOL balance
        const utilityTokenBalance = await api.db.findOne('balances', { account: api.sender, symbol: "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}" });
    
        const authorizedCreation = api.BigNumber(tokenCreationFee).lte(0) ? true : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(tokenCreationFee);
    
        if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fees')
            && api.assert(name && typeof name === 'string'
                && symbol && typeof symbol === 'string'
                && (url === undefined || (url && typeof url === 'string'))
                && (precision && typeof precision === 'number' || precision === 0)
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
                let token = await api.db.findOne('tokens', { symbol });
    
                if (api.assert(token === null, 'symbol already exists')) {
                  const finalUrl = url === undefined ? '' : url;
    
                  let metadata = {
                    url: finalUrl
                  }
  
                  metadata = JSON.stringify(metadata);
                    const newToken = {
                        issuer: api.sender,
                        symbol,
                        name,
                        metadata,
                        precision,
                        maxSupply: api.BigNumber(maxSupply).toFixed(precision),
                        supply: "0",
                        circulatingSupply: "0",
                    };
    
                    await api.db.insert('tokens', newToken);
    
                    // burn the token creation fees
                    if (api.BigNumber(tokenCreationFee).gt(0)) {
                        await actions.transfer({ to: 'null', symbol: "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", quantity: tokenCreationFee, isSignedWithActiveKey });
                    }
                }
            }
        }
    }
    
    actions.create = async (payload) => {
        if (api.refSteemBlockNumber < ${FORK_BLOCK_NUMBER}) {
            await createVOne(payload);
        } else {
            await createVTwo(payload);
        }
    }
    
    const issueVOne = async (payload) => {
        const { to, symbol, quantity, isSignedWithActiveKey } = payload;
    
        if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
            && api.assert(to && typeof to === 'string'
                && symbol && typeof symbol === 'string'
                && quantity && typeof quantity === 'number', 'invalid params')) {
    
            let token = await api.db.findOne('tokens', { symbol });
    
            // the symbol must exist
            // the api.sender must be the issuer
            // then we need to check that the quantity is correct
            if (api.assert(token !== null, 'symbol does not exist')
                && api.assert(token.issuer === api.sender, 'not allowed to issue tokens')
                && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
                && api.assert(quantity > 0, 'must issue positive quantity')
                && api.assert(quantity <= (api.BigNumber(token.maxSupply).minus(token.supply).toNumber()), 'quantity exceeds available supply')) {
    
                // a valid steem account is between 3 and 16 characters in length
                if (api.assert(to.length >= 3 && to.length <= 16, 'invalid to')) {
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
    
                        await api.db.update('tokens', token);
    
                        api.emit('transferFromContract', { from: 'tokens', to, symbol, quantity });
                    }
                }
            }
        }
    }
    
    const issueVTwo = async (payload) => {
        const { to, symbol, quantity, isSignedWithActiveKey } = payload;
    
        if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
            && api.assert(to && typeof to === 'string'
                && symbol && typeof symbol === 'string'
                && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN(), 'invalid params')) {
    
            let token = await api.db.findOne('tokens', { symbol });
    
            // the symbol must exist
            // the api.sender must be the issuer
            // then we need to check that the quantity is correct
            if (api.assert(token !== null, 'symbol does not exist')
                && api.assert(token.issuer === api.sender, 'not allowed to issue tokens')
                && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
                && api.assert(api.BigNumber(quantity).gt(0), 'must issue positive quantity')
                && api.assert(api.BigNumber(token.maxSupply).minus(token.supply).gte(quantity), 'quantity exceeds available supply')) {
    
                // a valid steem account is between 3 and 16 characters in length
                if (api.assert(to.length >= 3 && to.length <= 16, 'invalid to')) {
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
    
                        await api.db.update('tokens', token);
    
                        api.emit('transferFromContract', { from: 'tokens', to, symbol, quantity });
                    }
                }
            }
        }
    }
    
    actions.issue = async (payload) => {
        if (api.refSteemBlockNumber < ${FORK_BLOCK_NUMBER}) {
            await issueVOne(payload);
        } else {
            await issueVTwo(payload);
        }
    }
    
    const transferVOne = async (payload) => {
        const { to, symbol, quantity, isSignedWithActiveKey } = payload;
    
        if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
            && api.assert(to && typeof to === 'string'
                && symbol && typeof symbol === 'string'
                && quantity && typeof quantity === 'number', 'invalid params')) {
    
            if (api.assert(to !== api.sender, 'cannot transfer to self')) {
                // a valid steem account is between 3 and 16 characters in length
                if (api.assert(to.length >= 3 && to.length <= 16, 'invalid to')) {
                    let token = await api.db.findOne('tokens', { symbol });
    
                    // the symbol must exist
                    // then we need to check that the quantity is correct
                    if (api.assert(token !== null, 'symbol does not exist')
                        && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
                        && api.assert(quantity > 0, 'must transfer positive quantity')) {
    
                        if (await subBalanceVOne(api.sender, token, quantity, 'balances')) {
                            const res = await addBalanceVOne(to, token, quantity, 'balances');
    
                            if (res === false) {
                                await addBalanceVOne(api.sender, token, quantity, 'balances');
    
                                return false;
                            }
    
                            if (to === 'null') {
                                token.circulatingSupply = calculateBalanceVOne(token.circulatingSupply, quantity, token.precision, false);
                                await api.db.update('tokens', token);
                            }
    
                            api.emit('transfer', { from: api.sender, to, symbol, quantity });
    
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
    
        if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
            && api.assert(to && typeof to === 'string'
                && symbol && typeof symbol === 'string'
                && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN(), 'invalid params')) {
    
            if (api.assert(to !== api.sender, 'cannot transfer to self')) {
                // a valid steem account is between 3 and 16 characters in length
                if (api.assert(to.length >= 3 && to.length <= 16, 'invalid to')) {
                    let token = await api.db.findOne('tokens', { symbol });
    
                    // the symbol must exist
                    // then we need to check that the quantity is correct
                    if (api.assert(token !== null, 'symbol does not exist')
                        && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
                        && api.assert(api.BigNumber(quantity).gt(0), 'must transfer positive quantity')) {
    
                        if (await subBalanceVTwo(api.sender, token, quantity, 'balances')) {
                            const res = await addBalanceVTwo(to, token, quantity, 'balances');
    
                            if (res === false) {
                                await addBalanceVTwo(api.sender, token, quantity, 'balances');
    
                                return false;
                            }
    
                            if (to === 'null') {
                                token.circulatingSupply = calculateBalanceVTwo(token.circulatingSupply, quantity, token.precision, false);
                                await api.db.update('tokens', token);
                            }
    
                            api.emit('transfer', { from: api.sender, to, symbol, quantity });
    
                            return true;
                        }
                    }
                }
            }
        }
    
        return false;
    }
    
    actions.transfer = async (payload) => {
        if (api.refSteemBlockNumber < ${FORK_BLOCK_NUMBER}) {
            await transferVOne(payload);
        } else {
            await transferVTwo(payload);
        }
    }
    
    actions.transferToContract = async (payload) => {
        const { to, symbol, quantity, isSignedWithActiveKey } = payload;
    
        if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
            && api.assert(to && typeof to === 'string'
                && symbol && typeof symbol === 'string'
                && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN(), 'invalid params')) {
    
            if (api.assert(to !== api.sender, 'cannot transfer to self')) {
                // a valid contract account is between 3 and 50 characters in length
                if (api.assert(to.length >= 3 && to.length <= 50, 'invalid to')) {
                    let token = await api.db.findOne('tokens', { symbol });
    
                    // the symbol must exist
                    // then we need to check that the quantity is correct
                    if (api.assert(token !== null, 'symbol does not exist')
                        && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
                        && api.assert(api.BigNumber(quantity).gt(0), 'must transfer positive quantity')) {
    
                        if (await subBalanceVTwo(api.sender, token, quantity, 'balances')) {
                            const res = await addBalanceVTwo(to, token, quantity, 'contractsBalances');
    
                            if (res === false) {
                                await addBalanceVTwo(api.sender, token, quantity, 'balances');
                            } else {
                                if (to === 'null') {
                                    token.circulatingSupply = calculateBalanceVTwo(token.circulatingSupply, quantity, token.precision, false);
                                    await api.db.update('tokens', token);
                                }
    
                                api.emit('transferToContract', { from: api.sender, to, symbol, quantity });
                            }
                        }
                    }
                }
            }
        }
    }
    
    actions.transferFromContract = async (payload) => {
        // this action can only be called by the 'null' account which only the core code can use
        if (api.assert(api.sender === 'null', 'not authorized')) {
            const { from, to, symbol, quantity, type, isSignedWithActiveKey } = payload;
            const types = ['user', 'contract'];
    
            if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
                && api.assert(to && typeof to === 'string'
                    && from && typeof from === 'string'
                    && symbol && typeof symbol === 'string'
                    && type && (types.includes(type))
                    && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN(), 'invalid params')) {
    
                const table = type === 'user' ? 'balances' : 'contractsBalances';
    
                if (api.assert(type === 'user' || (type === 'contract' && to !== from), 'cannot transfer to self')) {
                    // validate the "to"
                    let toValid = type === 'user' ? to.length >= 3 && to.length <= 16 : to.length >= 3 && to.length <= 50;
    
                    // the account must exist
                    if (api.assert(toValid === true, 'invalid to')) {
                        let token = await api.db.findOne('tokens', { symbol });
    
                        // the symbol must exist
                        // then we need to check that the quantity is correct
                        if (api.assert(token !== null, 'symbol does not exist')
                            && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
                            && api.assert(api.BigNumber(quantity).gt(0), 'must transfer positive quantity')) {
    
                            if (await subBalanceVTwo(from, token, quantity, 'contractsBalances')) {
                                const res = await addBalanceVTwo(to, token, quantity, table);
    
                                if (res === false) {
                                    await addBalanceVTwo(from, token, quantity, 'contractsBalances');
                                } else {
                                    if (to === 'null') {
                                        token.circulatingSupply = calculateBalanceVTwo(token.circulatingSupply, quantity, token.precision, false);
                                        await api.db.update('tokens', token);
                                    }
    
                                    api.emit('transferFromContract', { from, to, symbol, quantity });
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    const subBalanceVOne = async (account, token, quantity, table) => {
      let balance = await api.db.findOne(table, { account, 'symbol': token.symbol });
      if (api.assert(balance !== null, 'balance does not exist') &&
        api.assert(balance.balance >= quantity, 'overdrawn balance')) {
        const originalBalance = balance.balance;

        balance.balance = calculateBalanceVOne(balance.balance, quantity, token.precision, false);

        if (api.assert(balance.balance < originalBalance, 'cannot subtract')) {
          await api.db.update(table, balance);

          return true;
        }          
      }

      return false;
    }

    const subBalanceVTwo = async (account, token, quantity, table) => {
      let balance = await api.db.findOne(table, { account, 'symbol': token.symbol });

      if (api.assert(balance !== null, 'balance does not exist') &&
          api.assert(api.BigNumber(balance.balance).gte(quantity), 'overdrawn balance')) {
          const originalBalance = balance.balance;
  
          balance.balance = calculateBalanceVTwo(balance.balance, quantity, token.precision, false);

          if (api.assert(api.BigNumber(balance.balance).lt(originalBalance), 'cannot subtract')) {
              await api.db.update(table, balance);
  
              return true;
          }
      }
  
      return false;
  }
    
    const addBalanceVOne = async (account, token, quantity, table) => {
      let balance = await api.db.findOne(table, { account, 'symbol': token.symbol });
      if (balance === null) {
        balance = {
          account,
          'symbol': token.symbol,
          'balance': quantity
        }
        
        await api.db.insert(table, balance);

        return true;
      } else {
        const originalBalance = balance.balance;

        balance.balance = calculateBalanceVOne(balance.balance, quantity, token.precision, true);
        if (api.assert(balance.balance > originalBalance, 'cannot add')) {
          await api.db.update(table, balance);
          return true;
        }

        return false;
      }
    }

    const addBalanceVTwo = async (account, token, quantity, table) => {
      let balance = await api.db.findOne(table, { account, 'symbol': token.symbol });
      if (balance === null) {
          balance = {
              account,
              'symbol': token.symbol,
              'balance': quantity
          }
  
          await api.db.insert(table, balance);
  
          return true;
      } else {
          const originalBalance = balance.balance;
  
          balance.balance = calculateBalanceVTwo(balance.balance, quantity, token.precision, true);
          if (api.assert(api.BigNumber(balance.balance).gt(originalBalance), 'cannot add')) {
              await api.db.update(table, balance);
              return true;
          }
  
          return false;
      }
  }
    
  const calculateBalanceVOne = function (balance, quantity, precision, add) {
    if (precision === 0) {
      return add ? balance + quantity : balance - quantity
    }

    return add ? api.BigNumber(balance).plus(quantity).toNumber() : api.BigNumber(balance).minus(quantity).toNumber()
  }

    const calculateBalanceVTwo = function (balance, quantity, precision, add) {
      return add ? api.BigNumber(balance).plus(quantity).toFixed(precision) : api.BigNumber(balance).minus(quantity).toFixed(precision);
  }
    
    const countDecimals = function (value) {
        return api.BigNumber(value).dp();
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
      await api.db.createTable('params');
      const params = {};
      
      params.priceSBD = "1000000";
      params.priceSteem = "${SSC_STORE_PRICE}";
      params.quantity = "${SSC_STORE_QTY}";
      params.disabled = false;

      await api.db.insert('params', params);      
    }

    actions.updateParams = async (payload) => {
      if (api.sender !== api.owner) return;

      const { priceSBD, priceSteem, quantity, disabled } = payload;

      const params = await api.db.findOne('params', { });

      params.priceSBD = priceSBD;
      params.priceSteem = priceSteem;
      params.quantity = quantity;
      params.disabled = disabled;

      await api.db.update('params', params);
    }

    actions.buy = async (payload) => {
      const { recipient, amountSTEEMSBD, isSignedWithActiveKey } = payload;

      if (recipient !== api.owner) return;

      if (api.assert(recipient && amountSTEEMSBD && isSignedWithActiveKey, 'invalid params')) {
        const params = await api.db.findOne('params', { });

        if (params.disabled) return;

        const res = amountSTEEMSBD.split(' ');
  
        const amount = res[0];
        const unit = res[1];
  
        let quantity = 0;
        let quantityToSend = 0;
        api.BigNumber.set({ DECIMAL_PLACES: 3 });

        // STEEM
        if (unit === 'STEEM') {
          quantity = api.BigNumber(amount).dividedBy(params.priceSteem);
        } 
        // SBD (disabled)
        else {
          // quantity = api.BigNumber(amount).dividedBy(params.priceSBD);
        }
  
        if (api.refSteemBlockNumber < ${FORK_BLOCK_NUMBER}) {
          quantityToSend = Number(api.BigNumber(quantity).multipliedBy(params.quantity).toFixed(${BP_CONSTANTS.UTILITY_TOKEN_PRECISION}));
        } else {
          quantityToSend = api.BigNumber(quantity).multipliedBy(params.quantity).toFixed(${BP_CONSTANTS.UTILITY_TOKEN_PRECISION});
        }

        if (quantityToSend > 0) {
          await api.executeSmartContractAsOwner('tokens', 'transfer', { symbol: "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", quantity: quantityToSend, to: api.sender })
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
      await api.db.createTable('withdrawals'); 
    }

    actions.buy = async (payload) => {
      const { recipient, amountSTEEMSBD, isSignedWithActiveKey } = payload;

      if (recipient !== api.owner) return;

      if (recipient && amountSTEEMSBD && isSignedWithActiveKey) {
        const res = amountSTEEMSBD.split(' ');
  
        const unit = res[1];
  
        // STEEM
        if (api.assert(unit === 'STEEM', 'only STEEM can be used')) {
          let quantityToSend = res[0];

          // calculate the 1% fee (with a min of 0.001 STEEM)
          let fee = api.BigNumber(quantityToSend).multipliedBy(0.01).toFixed(3);

          if (api.BigNumber(fee).lt("0.001")) {
            fee = "0.001";
          }
  
          quantityToSend = api.BigNumber(quantityToSend).minus(fee).toFixed(3);

          if (api.BigNumber(quantityToSend).gt(0)) {
            await api.executeSmartContractAsOwner('tokens', 'transfer', { symbol: "STEEMP", quantity: quantityToSend, to: api.sender })
          }

          if (api.BigNumber(fee).gt(0)) {
            const memo = 'fee tx ' + api.transactionId;
            await initiateWithdrawal(api.transactionId + '-fee', '${ACCOUNT_RECEIVING_FEES}', fee, memo);
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

      if (api.assert(
          quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN() 
          && api.BigNumber(quantity).gt(0)
          && isSignedWithActiveKey, 'invalid params')) {

        // calculate the 1% fee (with a min of 0.001 STEEM)
        let fee = api.BigNumber(quantity).multipliedBy(0.01).toFixed(3);

        if (api.BigNumber(fee).lt("0.001")) {
          fee = "0.001";
        }

        const quantityToSend = api.BigNumber(quantity).minus(fee).toFixed(3);

        if (api.BigNumber(quantityToSend).gt(0)) {
          const res = await api.executeSmartContract('tokens', 'transfer', { symbol: "STEEMP", quantity, to: api.owner });
 
          if (res.errors === undefined &&
              res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transfer' && el.data.from === api.sender && el.data.to === api.owner && el.data.quantity === quantity && el.data.symbol === "STEEMP") !== undefined) {
            // withdrawal
            const memo = 'withdrawal tx ' + api.transactionId;

            await initiateWithdrawal(api.transactionId, api.sender, quantityToSend, memo);

            if (api.BigNumber(fee).gt(0)) {
              const memo = 'fee tx ' + api.transactionId;
              await initiateWithdrawal(api.transactionId + '-fee', '${ACCOUNT_RECEIVING_FEES}', fee, memo);
            }
          }
        }
      }
    }

    actions.removeWithdrawal = async (payload) => {
      const { id, isSignedWithActiveKey } = payload;

      if (api.sender !== api.owner) return;

      if (id && isSignedWithActiveKey) {
        const withdrawal = await api.db.findOne('withdrawals', { id });

        if (withdrawal) {
          await api.db.remove('withdrawals', withdrawal);
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

        await api.db.insert('withdrawals', withdrawal); 
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
        await api.db.createTable('buyBook', ['symbol', 'account', 'price', 'expiration']);
        await api.db.createTable('sellBook', ['symbol', 'account', 'price', 'expiration']);
        await api.db.createTable('tradesHistory', ['symbol']);
        await api.db.createTable('metrics', ['symbol']);
    };

    actions.cancel = async (payload) => {
        const { type, id, isSignedWithActiveKey } = payload;

        const types = ['buy', 'sell'];

        if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
            && api.assert(type && types.includes(type)
                && id && Number.isInteger(id), 'invalid params')) {
            const table = type === 'buy' ? 'buyBook' : 'sellBook';
            // get order
            const order = await api.db.findOne(table, { $loki: id });

            if (api.assert(order, 'order does not exist')
                && order.account === api.sender) {
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
                await api.transferTokens(api.sender, symbol, quantity, 'user');

                await api.db.remove(table, order);

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
        if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
            && api.assert(
                price && typeof price === 'string' && !api.BigNumber(price).isNaN()
                && symbol && typeof symbol === 'string' && symbol !== STEEM_PEGGED_SYMBOL
                && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN()
                && (expiration === undefined || (expiration && Number.isInteger(expiration) && expiration > 0)), 'invalid params')) {

            // get the token params
            const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });

            // perform a few verifications
            if (api.assert(token
                && api.BigNumber(price).gt(0)
                && countDecimals(price) <= 3
                && countDecimals(quantity) <= token.precision, 'invalid params')) {
                // initiate a transfer from api.sender to contract balance

                const nbTokensToLock = api.BigNumber(price).multipliedBy(quantity).toFixed(3);

                if (api.assert(api.refSteemBlockNumber < ${FORK_BLOCK_NUMBER_TWO} || api.BigNumber(nbTokensToLock).gte('0.001'), 'order cannot be placed as it cannot be filled')) {
                  // lock STEEM_PEGGED_SYMBOL tokens
                  const res = await api.executeSmartContract('tokens', 'transferToContract', { symbol: STEEM_PEGGED_SYMBOL, quantity: nbTokensToLock, to: CONTRACT_NAME });

                  if (res.errors === undefined &&
                      res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === api.sender && el.data.to === CONTRACT_NAME && el.data.quantity === nbTokensToLock && el.data.symbol === STEEM_PEGGED_SYMBOL) !== undefined) {
                      const timestampSec = api.BigNumber(new Date(api.steemBlockTimestamp + '.000Z').getTime())
                          .dividedBy(1000)
                          .toNumber();

                      // order
                      const order = {};

                      order.txId = api.transactionId;
                      order.timestamp = timestampSec;
                      order.account = api.sender;
                      order.symbol = symbol;
                      order.quantity = quantity;
                      order.price = price;
                      order.tokensLocked = nbTokensToLock;
                      order.expiration = expiration === undefined || expiration > 2592000 ? timestampSec + 2592000 : timestampSec + expiration;

                      const orderInDb = await api.db.insert('buyBook', order);

                      await findMatchingSellOrders(orderInDb, token.precision);
                  }
                }
            }
        }
    };

    actions.sell = async (payload) => {
        const { symbol, quantity, price, expiration, isSignedWithActiveKey } = payload;
        // sell (quantity) of (symbol) at (price)(STEEM_PEGGED_SYMBOL) per (symbol)
        if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
            && api.assert(
                price && typeof price === 'string' && !api.BigNumber(price).isNaN()
                && symbol && typeof symbol === 'string' && symbol !== STEEM_PEGGED_SYMBOL
                && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN()
                && (expiration === undefined || (expiration && Number.isInteger(expiration) && expiration > 0)), 'invalid params')) {

            // get the token params
            const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });

            // perform a few verifications
            if (api.assert(token
                && api.BigNumber(price).gt(0)
                && countDecimals(price) <= 3
                && countDecimals(quantity) <= token.precision, 'invalid params')) {

                const nbTokensToFillOrder = api.BigNumber(price).multipliedBy(quantity).toFixed(3);

                if (api.assert(api.refSteemBlockNumber < ${FORK_BLOCK_NUMBER_TWO} || api.BigNumber(nbTokensToFillOrder).gte('0.001'), 'order cannot be placed as it cannot be filled')) {
                  // initiate a transfer from api.sender to contract balance
                  // lock symbol tokens
                  const res = await api.executeSmartContract('tokens', 'transferToContract', { symbol, quantity, to: CONTRACT_NAME });

                  if (res.errors === undefined &&
                      res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === api.sender && el.data.to === CONTRACT_NAME && el.data.quantity === quantity && el.data.symbol === symbol) !== undefined) {
                      const timestampSec = api.BigNumber(new Date(api.steemBlockTimestamp + '.000Z').getTime())
                          .dividedBy(1000)
                          .toNumber();

                      // order
                      const order = {};

                      order.txId = api.transactionId;
                      order.timestamp = timestampSec;
                      order.account = api.sender;
                      order.symbol = symbol;
                      order.quantity = quantity;
                      order.price = price;
                      order.expiration = expiration === undefined || expiration > 2592000 ? timestampSec + 2592000 : timestampSec + expiration;

                      const orderInDb = await api.db.insert('sellBook', order);

                      await findMatchingBuyOrders(orderInDb, token.precision);
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
        let sellOrderBook = await api.db.find('sellBook', {
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

            while (inc < nbOrders && api.BigNumber(buyOrder.quantity).gt(0)) {
                const sellOrder = sellOrderBook[inc];
                if (api.BigNumber(buyOrder.quantity).lte(sellOrder.quantity)) {

                    let qtyTokensToSend = api.BigNumber(sellOrder.price)
                        .multipliedBy(buyOrder.quantity)
                        .toFixed(3);

                    if (api.BigNumber(qtyTokensToSend).gt(buyOrder.tokensLocked)) {
                        qtyTokensToSend = api.BigNumber(sellOrder.price)
                            .multipliedBy(buyOrder.quantity)
                            .toFixed(3, api.BigNumber.ROUND_DOWN);
                    }

                    if (api.assert(api.BigNumber(qtyTokensToSend).gt(0)
                        && api.BigNumber(buyOrder.quantity).gt(0), 'the order cannot be filled')) {

                        // transfer the tokens to the buyer
                        await api.transferTokens(account, symbol, buyOrder.quantity, 'user');

                        // transfer the tokens to the seller
                        await api.transferTokens(sellOrder.account, STEEM_PEGGED_SYMBOL, qtyTokensToSend, 'user');

                        // update the sell order
                        const qtyLeftSellOrder = api.BigNumber(sellOrder.quantity).minus(buyOrder.quantity).toFixed(tokenPrecision);
                        const nbTokensToFillOrder = api.BigNumber(sellOrder.price).multipliedBy(qtyLeftSellOrder).toFixed(3);

                        

                        if (api.BigNumber(qtyLeftSellOrder).gt(0)
                        && (api.refSteemBlockNumber < ${FORK_BLOCK_NUMBER_TWO} || api.BigNumber(nbTokensToFillOrder).gte('0.001'))) {
                            sellOrder.quantity = qtyLeftSellOrder;

                            await api.db.update('sellBook', sellOrder);
                        } else {
                          if (api.BigNumber(qtyLeftSellOrder).gt(0)) {
                            await api.transferTokens(sellOrder.account, symbol, qtyLeftSellOrder, 'user');
                          }
                            await api.db.remove('sellBook', sellOrder);
                        }

                        // unlock remaining tokens, update the quantity to get and remove the buy order
                        const tokensToUnlock = api.BigNumber(buyOrder.tokensLocked).minus(qtyTokensToSend).toFixed(3);

                        if (api.BigNumber(tokensToUnlock).gt(0)) {
                            await api.transferTokens(account, STEEM_PEGGED_SYMBOL, tokensToUnlock, 'user');
                        }

                        // add the trade to the history
                        await updateTradesHistory('buy', symbol, buyOrder.quantity, sellOrder.price);
                        // update the volume
                        await updateVolumeMetric(symbol, qtyTokensToSend);

                        buyOrder.quantity = "0";
                        await api.db.remove('buyBook', buyOrder);
                    }
                } else {
                    let qtyTokensToSend = api.BigNumber(sellOrder.price)
                        .multipliedBy(sellOrder.quantity)
                        .toFixed(3);

                    if (api.BigNumber(qtyTokensToSend).gt(buyOrder.tokensLocked)) {
                        qtyTokensToSend = api.BigNumber(sellOrder.price)
                            .multipliedBy(sellOrder.quantity)
                            .toFixed(3, api.BigNumber.ROUND_DOWN);
                    }

                    if (api.assert(api.BigNumber(qtyTokensToSend).gt(0)
                        && api.BigNumber(buyOrder.quantity).gt(0), 'the order cannot be filled')) {

                        // transfer the tokens to the buyer
                        await api.transferTokens(account, symbol, sellOrder.quantity, 'user');

                        // transfer the tokens to the seller
                        await api.transferTokens(sellOrder.account, STEEM_PEGGED_SYMBOL, qtyTokensToSend, 'user');

                        // remove the sell order
                        await api.db.remove('sellBook', sellOrder);

                        // update tokensLocked and the quantity to get
                        buyOrder.tokensLocked = api.BigNumber(buyOrder.tokensLocked).minus(qtyTokensToSend).toFixed(3);
                        buyOrder.quantity = api.BigNumber(buyOrder.quantity).minus(sellOrder.quantity).toFixed(tokenPrecision);

                        // check if the order can still be filled
                        const nbTokensToFillOrder = api.BigNumber(buyOrder.price).multipliedBy(buyOrder.quantity).toFixed(3);

                        if (api.refSteemBlockNumber >= ${FORK_BLOCK_NUMBER_TWO} && api.BigNumber(nbTokensToFillOrder).lt('0.001')) {
                          await api.transferTokens(account, STEEM_PEGGED_SYMBOL, buyOrder.tokensLocked, 'user');

                          buyOrder.quantity = "0";
                          await api.db.remove('buyBook', buyOrder);
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

            if (api.BigNumber(buyOrder.quantity).gt(0)) {
                // get the orders that match the symbol and the price
                sellOrderBook = await api.db.find('sellBook', {
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
        } while (sellOrderBook.length > 0 && api.BigNumber(buyOrder.quantity).gt(0));

        // update the buy order if partially filled
        if (api.BigNumber(buyOrder.quantity).gt(0)) {
            await api.db.update('buyBook', buyOrder);
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
        let buyOrderBook = await api.db.find('buyBook', {
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

            while (inc < nbOrders && api.BigNumber(sellOrder.quantity).gt(0)) {
                const buyOrder = buyOrderBook[inc];
                if (api.BigNumber(sellOrder.quantity).lte(buyOrder.quantity)) {

                    let qtyTokensToSend = api.BigNumber(buyOrder.price)
                        .multipliedBy(sellOrder.quantity)
                        .toFixed(3);

                    if (api.BigNumber(qtyTokensToSend).gt(buyOrder.tokensLocked)) {
                        qtyTokensToSend = api.BigNumber(buyOrder.price)
                            .multipliedBy(sellOrder.quantity)
                            .toFixed(3, api.BigNumber.ROUND_DOWN);
                    }

                    if (api.assert(api.BigNumber(qtyTokensToSend).gt(0)
                        && api.BigNumber(sellOrder.quantity).gt(0), 'the order cannot be filled')) {
                        // transfer the tokens to the buyer
                        await api.transferTokens(buyOrder.account, symbol, sellOrder.quantity, 'user');

                        // transfer the tokens to the seller
                        await api.transferTokens(account, STEEM_PEGGED_SYMBOL, qtyTokensToSend, 'user');

                        // update the buy order
                        const qtyLeftBuyOrder = api.BigNumber(buyOrder.quantity).minus(sellOrder.quantity).toFixed(tokenPrecision);

                        const buyOrdertokensLocked = api.BigNumber(buyOrder.tokensLocked).minus(qtyTokensToSend).toFixed(3);
                        const nbTokensToFillOrder = api.BigNumber(buyOrder.price).multipliedBy(qtyLeftBuyOrder).toFixed(3);

                        if (api.BigNumber(qtyLeftBuyOrder).gt(0)
                            && (api.refSteemBlockNumber < ${FORK_BLOCK_NUMBER_TWO} || api.BigNumber(nbTokensToFillOrder).gte('0.001'))) {
                            buyOrder.quantity = qtyLeftBuyOrder;
                            buyOrder.tokensLocked = buyOrdertokensLocked;

                            await api.db.update('buyBook', buyOrder);
                        } else {
                            if (api.BigNumber(buyOrdertokensLocked).gt(0)) {
                                await api.transferTokens(buyOrder.account, STEEM_PEGGED_SYMBOL, buyOrdertokensLocked, 'user');
                            }
                            await api.db.remove('buyBook', buyOrder);
                        }

                        // add the trade to the history
                        await updateTradesHistory('sell', symbol, sellOrder.quantity, buyOrder.price);
                        // update the volume
                        await updateVolumeMetric(symbol, qtyTokensToSend);

                        sellOrder.quantity = 0;
                        await api.db.remove('sellBook', sellOrder);
                    }
                } else {

                    let qtyTokensToSend = api.BigNumber(buyOrder.price)
                        .multipliedBy(buyOrder.quantity)
                        .toFixed(3);

                    if (qtyTokensToSend > buyOrder.tokensLocked) {
                        qtyTokensToSend = api.BigNumber(buyOrder.price)
                            .multipliedBy(buyOrder.quantity)
                            .toFixed(3, api.BigNumber.ROUND_DOWN);
                    }

                    if (api.assert(api.BigNumber(qtyTokensToSend).gt(0)
                        && api.BigNumber(sellOrder.quantity).gt(0), 'the order cannot be filled')) {
                        // transfer the tokens to the buyer
                        await api.transferTokens(buyOrder.account, symbol, buyOrder.quantity, 'user');

                        // transfer the tokens to the seller
                        await api.transferTokens(account, STEEM_PEGGED_SYMBOL, qtyTokensToSend, 'user');

                        // remove the buy order
                        await api.db.remove('buyBook', buyOrder);

                        // update the quantity to get
                        sellOrder.quantity = api.BigNumber(sellOrder.quantity).minus(buyOrder.quantity).toFixed(tokenPrecision);

                        // check if the order can still be filled
                        const nbTokensToFillOrder = api.BigNumber(sellOrder.price).multipliedBy(sellOrder.quantity).toFixed(3);
                          
                        if (api.refSteemBlockNumber >= ${FORK_BLOCK_NUMBER_TWO} && api.BigNumber(nbTokensToFillOrder).lt('0.001')) {
                          await api.transferTokens(account, symbol, sellOrder.quantity, 'user');

                          sellOrder.quantity = "0";
                          await api.db.remove('sellBook', sellOrder);
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

            if (api.BigNumber(sellOrder.quantity).gt(0)) {
                // get the orders that match the symbol and the price
                buyOrderBook = await api.db.find('buyBook', {
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
        } while (buyOrderBook.length > 0 && api.BigNumber(sellOrder.quantity).gt(0));

        // update the sell order if partially filled
        if (api.BigNumber(sellOrder.quantity).gt(0)) {
            await api.db.update('sellBook', sellOrder);
        }

        await updateAskMetric(symbol);
        await updateBidMetric(symbol);
    };

    const removeExpiredOrders = async (table) => {
        const timestampSec = api.BigNumber(new Date(api.steemBlockTimestamp + '.000Z').getTime())
            .dividedBy(1000)
            .toNumber();

        // clean orders
        let ordersToDelete = await api.db.find(
            table,
            {
                expiration: {
                    $lte: timestampSec,
                },
            });

        while (ordersToDelete.length > 0) {
            ordersToDelete.forEach(async (order) => {
                await api.db.remove(table, order);
            });

            ordersToDelete = await api.db.find(
                table,
                {
                    expiration: {
                        $lte: timestampSec,
                    },
                });
        }
    }

    const getMetric = async (symbol) => {
        let metric = await api.db.findOne('metrics', { symbol });

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

            return await api.db.insert('metrics', metric);
        }

        return metric;
    }

    const updateVolumeMetric = async (symbol, quantity) => {
        const timestampSec = api.BigNumber(new Date(api.steemBlockTimestamp + '.000Z').getTime())
            .dividedBy(1000)
            .toNumber();

        let metric = await getMetric(symbol);

        if (metric.volumeExpiration < timestampSec) {
            metric.volume = quantity;
            metric.volumeExpiration = api.BigNumber(timestampSec).plus(86400).toNumber();
        } else {
            metric.volume = api.BigNumber(metric.volume).plus(quantity).toNumber();
        }

        await api.db.update('metrics', metric);
    }

    const updateBidMetric = async (symbol) => {
        let metric = await getMetric(symbol);

        const buyOrderBook = await api.db.find('buyBook',
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

        await api.db.update('metrics', metric);
    }

    const updateAskMetric = async (symbol) => {
        let metric = await getMetric(symbol);

        const sellOrderBook = await api.db.find('sellBook',
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

        await api.db.update('metrics', metric);
    }

    const updatePriceMetrics = async (symbol, price, timestamp) => {
        let metric = await getMetric(symbol);

        metric.lastPrice = price;

        if (metric.lastDayPriceExpiration < timestamp) {
            metric.lastDayPrice = price;
            metric.lastDayPriceExpiration = api.BigNumber(timestamp).plus(86400).toNumber();
            metric.priceChangeSteem = "0";
            metric.priceChangePercent = "0%";
        } else {
            metric.priceChangeSteem = api.BigNumber(price).minus(metric.lastDayPrice).toFixed(3);
            metric.priceChangePercent = api.BigNumber(metric.priceChangeSteem).dividedBy(metric.lastDayPrice).multipliedBy(100).toFixed(2) + '%';
        }

        await api.db.update('metrics', metric);
    }

    const updateTradesHistory = async (type, symbol, quantity, price) => {
        const timestampSec = api.BigNumber(new Date(api.steemBlockTimestamp + '.000Z').getTime())
            .dividedBy(1000)
            .toNumber();

        const timestampMinus24hrs = api.BigNumber(timestampSec).minus(86400).toNumber();

        // clean history
        let tradesToDelete = await api.db.find(
            'tradesHistory',
            {
                symbol,
                timestamp: {
                    $lt: timestampMinus24hrs,
                },
            });

        while (tradesToDelete.length > 0) {
            tradesToDelete.forEach(async (trade) => {
                await api.db.remove('tradesHistory', trade);
            });

            tradesToDelete = await api.db.find(
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

        await api.db.insert('tradesHistory', newTrade);

        await updatePriceMetrics(symbol, price, timestampSec);
    }

    const countDecimals = function (value) {
        return api.BigNumber(value).dp();
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
