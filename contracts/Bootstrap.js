const { Base64 } = require('js-base64');
const { Transaction } = require('../libs/Transaction');

class Bootstrap {
  static getBootstrapTransactions(genesisSteemBlock) {
    const transactions = [];

    // accounts contract
    let contractCode = `
    actions.createSSC = async (payload) => {
      await db.createTable('accounts', ['id']);
    }

    // register an account helps other contracts to know 
    // if an account exists on the Steem blockchain
    actions.register = async (payload) => {
      const account = await db.findOne('accounts', { 'id': sender });

      if (account === null) {
        const newAccount = {
          'id': sender
        };

        await db.insert('accounts', newAccount);
      } 
    }
    `;

    let base64ContractCode = Base64.encode(contractCode);

    let contractPayload = {
      name: 'accounts',
      params: '',
      code: base64ContractCode,
    };

    transactions.push(new Transaction(genesisSteemBlock, 0, 'null', 'contract', 'deploy', JSON.stringify(contractPayload)));

    // tokens contract
    contractCode = `
      actions.createSSC = async (payload) => {
        await db.createTable('tokens', ['symbol']);
        await db.createTable('balances', ['account']);
        await db.createTable('contractsBalances', ['account']);
        await db.createTable('params');

        const params = {};
        params.tokenCreationFee = 0;
        await db.insert('params', params);  
      }

      actions.updateParams = async (payload) => {
        if (sender !== owner) return;

        const { tokenCreationFee } = payload;

        const params = await db.findOne('params', { });

        params.tokenCreationFee = tokenCreationFee;

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
            if(assert(token.issuer === sender, 'must be the issuer')) {
              token.url = url;
              await db.update('tokens', token);
            }
          }
        }
      }

      actions.create = async (payload) => {
        const { name, symbol, url, precision, maxSupply } = payload;

        // get contract params
        const params = await db.findOne('params', { });
        const { tokenCreationFee } = params;

        const authorizedCreation = tokenCreationFee <= 0 ? true : await subBalance(sender, 'SSC', tokenCreationFee, 'balances');

        if (assert(authorizedCreation, 'you must have enough SSC tokens to cover the creation fees')
          && assert(name && typeof name === 'string'
          && symbol && typeof symbol === 'string'
          && (url === undefined || (url && typeof url === 'string'))
          && (precision && typeof precision === 'number' || precision === 0)
          && maxSupply && typeof maxSupply === 'number', 'invalid params')) {

          // the precision must be between 0 and 8 and must be an integer
          // the max supply must be positive
          if (assert(validator.isAlpha(symbol) && validator.isUppercase(symbol) && symbol.length > 0 && symbol.length <= 7, 'invalid symbol: uppercase letters only, max length of 7')
            && assert(validator.isAlphanumeric(validator.blacklist(name, ' ')) && name.length > 0 && name.length <= 50, 'invalid name: letters, numbers, whitespaces only, max length of 50')
            && assert(url === undefined || url.length <= 255, 'invalid url: max length of 255')
            && assert((precision >= 0 && precision <= 8) && (Number.isInteger(precision)), 'invalid precision')
            && assert(maxSupply > 0, 'maxSupply must be positive')
            && assert(maxSupply <= 1000000000000, 'maxSupply must be lower than 1000000000000')) {

            // check if the token already exists
            let token = await db.findOne('tokens', { symbol });

            if (assert(token === null, 'symbol already exists')) {
              const newToken = {
                issuer: sender,
                symbol,
                name,
                url,
                precision,
                maxSupply,
                supply: 0
              };
              
              await db.insert('tokens', newToken);
            }
          }
        }
      }

      actions.issue = async (payload) => {
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
            && assert(quantity <= (token.maxSupply - token.supply), 'quantity exceeds available supply')) {

            let account = await db.findOneInTable('accounts', 'accounts', { 'id': to });

            // the account must have been registered before
            if (assert(account !== null, 'to account does not exist')) {
              // we made all the required verification, let's now issue the tokens

              token.supply = calculateBalance(token.supply, quantity, token.precision, true);
              
              await db.update('tokens', token);

              await addBalance(token.issuer, token, quantity, 'balances');

              if (to !== token.issuer) {
                await actions.transfer(payload);
              }
            }
          }
        }
      }

      actions.transfer = async (payload) => {
        const { to, symbol, quantity, isSignedWithActiveKey } = payload;

        if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
          && assert(to && typeof to === 'string'
          && symbol && typeof symbol === 'string'
          && quantity && typeof quantity === 'number', 'invalid params')) {

          if (assert(to !== sender, 'cannot transfer to self')) {
            let account = await db.findOneInTable('accounts', 'accounts', { 'id': to });
      
            // the account must have been registered before
            if (assert(account !== null, 'to account does not exist')) {
              let token = await db.findOne('tokens', { symbol });

              // the symbol must exist
              // then we need to check that the quantity is correct
              if (assert(token !== null, 'symbol does not exist')
                && assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
                && assert(quantity > 0, 'must transfer positive quantity')) {

                if (await subBalance(sender, token, quantity, 'balances')) {
                  await addBalance(to, token, quantity, 'balances');
                }
              }
            }
          }
        }
      }

      actions.transferToContract = async (payload) => {
        const { to, symbol, quantity, isSignedWithActiveKey } = payload;

        if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
          && assert(to && typeof to === 'string'
          && symbol && typeof symbol === 'string'
          && quantity && typeof quantity === 'number', 'invalid params')) {

          if (assert(to !== sender, 'cannot transfer to self')) {
            let contract = await db.findContract(to);
      
            // the contract must exist
            if (assert(contract !== null, 'to contract does not exist')) {
              let token = await db.findOne('tokens', { symbol });

              // the symbol must exist
              // then we need to check that the quantity is correct
              if (assert(token !== null, 'symbol does not exist')
                && assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
                && assert(quantity > 0, 'must transfer positive quantity')) {

                if (await subBalance(sender, token, quantity, 'balances')) {
                  await addBalance(to, token, quantity, 'contractsBalances');
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
            && quantity && typeof quantity === 'number', 'invalid params')) {

            const table = type === 'user' ? 'balances' : 'contractsBalances';

            if (assert(type === 'user' || ( type === 'contract' && to !== from), 'cannot transfer to self')) {
              let acct = type === 'user' ? await db.findOneInTable('accounts', 'accounts', { 'id': to }) : await db.findContract(to);
        
              // the account must exist
              if (assert(acct !== null, 'to does not exist')) {
                let token = await db.findOne('tokens', { symbol });

                // the symbol must exist
                // then we need to check that the quantity is correct
                if (assert(token !== null, 'symbol does not exist')
                  && assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
                  && assert(quantity > 0, 'must transfer positive quantity')) {

                  if (await subBalance(from, token, quantity, 'contractsBalances')) {
                    await addBalance(to, token, quantity, table);
                  }
                }
              }
            }
          }
        }
      }

      const subBalance = async (account, token, quantity, table) => {
        let balance = await db.findOne(table, { account, 'symbol': token.symbol });
        if (assert(balance !== null, 'balance does not exist') &&
          assert(balance.balance >= quantity, 'overdrawn balance')) {

          balance.balance = calculateBalance(balance.balance, quantity, token.precision, false);
          if (balance.balance <= 0) {
            await db.remove(table, balance);
          } else {
            await db.update(table, balance);
          }

          return true;
        }

        return false;
      }

      const addBalance = async (account, token, quantity, table) => {
        let balance = await db.findOne(table, { account, 'symbol': token.symbol });
        if (balance === null) {
          balance = {
            account,
            'symbol': token.symbol,
            'balance': quantity
          }
          
          await db.insert(table, balance);
        } else {
          balance.balance = calculateBalance(balance.balance, quantity, token.precision, true);

          await db.update(table, balance);
        }
      }

      const calculateBalance = function (balance, quantity, precision, add) {
        if (precision === 0) {
          return add ? balance + quantity : balance - quantity
        }

        return add ? currency(balance, { precision }).add(quantity) : currency(balance, { precision }).subtract(quantity);
      }

      const countDecimals = function (value) {
        if (Math.floor(value) === value) return 0;
        return value.toString().split('.')[1].length || 0;
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
      
      params.priceSBD = 0.001;
      params.priceSteem = 0.001;
      params.quantity = 1;
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
        // STEEM
        if (unit === 'STEEM') {
          quantity = currency(Number(amount), { precision: 3 }).divide(params.priceSteem);
        } 
        // SBD
        else {
          quantity = currency(Number(amount), { precision: 3 }).divide(params.priceSBD);
        }
  
        quantityToSend = currency(quantity, { precision: 8 }).multiply(params.quantity);
  
        if (quantityToSend.value > 0) {
          await executeSmartContractAsOwner('tokens', 'transfer', { symbol: "SSC", quantity: quantityToSend.value, to: sender })
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
  
        const quantity = Number(res[0]);
        const unit = res[1];
  
        // STEEM
        if (assert(unit === 'STEEM', 'only STEEM can be used')) {
          if (quantity > 0) {
            await executeSmartContractAsOwner('tokens', 'transfer', { symbol: "STEEMP", quantity, to: sender })
          }
        } 
        // SBD
        else {
          // refund
          const withdrawal = {};
      
          withdrawal.id = transactionId;
          withdrawal.type = 'SBD';
          withdrawal.recipient = sender;
          withdrawal.memo = 'refund tx ' + transactionId + ': only STEEM can be used to purchase STEEMP';
          withdrawal.quantity = quantity;

          await db.insert('withdrawals', withdrawal); 
        }
      }
    }

    actions.withdraw = async (payload) => {
      const { quantity, isSignedWithActiveKey } = payload;

      if (assert(quantity && isSignedWithActiveKey, 'invalid params')) {

        const res = await executeSmartContract('tokens', 'transfer', { symbol: "STEEMP", quantity: quantity, to: owner });

        if (res.errors === undefined) {
          // withdrawal
          const withdrawal = {};
      
          withdrawal.id = transactionId;
          withdrawal.type = 'STEEM';
          withdrawal.recipient = sender;
          withdrawal.memo = 'withdrawal tx ' + transactionId;
          withdrawal.quantity = quantity;

          await db.insert('withdrawals', withdrawal); 
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
    `;

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: 'steempegged',
      params: '',
      code: base64ContractCode,
    };

    transactions.push(new Transaction(genesisSteemBlock, 0, 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));

    contractCode = `
    const STEEM_PEGGED_SYMBOL = 'STEEMP';
    const CONTRACT_NAME = 'market';

    actions.createSSC = async (payload) => {
      await db.createTable('buyBook', ['symbol', 'account', 'price']);
      await db.createTable('sellBook', ['symbol', 'account', 'price']);
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
              symbol = order.symbol;
              quantity = order.tokensLocked;
            } else {
              symbol = STEEM_PEGGED_SYMBOL;
              quantity = order.quantity;
            }

            await transferTokens(sender, symbol, quantity, 'user');

            await db.remove(table, order);
          }
      }
    }

    actions.buy = async (payload) => {
      const { symbol, quantity, price, isSignedWithActiveKey } = payload;
      // buy (quantity) STEEM_PEGGED_SYMBOL at (price)(symbol) per STEEM_PEGGED_SYMBOL
      if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
        && assert(price && typeof price === 'number'
        && symbol && typeof symbol === 'string'
        && quantity && typeof quantity === 'number', 'invalid params')) {

        // get the token params
        const token = await db.findOneInTable('tokens', 'tokens', { symbol });

        // perform a few verifications
        if (token
          && price > 0
          && countDecimals(price) <= token.precision
          && countDecimals(quantity) <= 3) {
          // initiate a transfer from sender to null account
          const nbTokensToLock = currency(price, { precision: token.precision }).multiply(quantity).value;

          const res = await executeSmartContract('tokens', 'transferToContract', { symbol, quantity: nbTokensToLock, to: CONTRACT_NAME });

          if (res.errors === undefined) {
            // order
            const order = {};
            
            order.txId = transactionId;
            order.account = sender;
            order.symbol = symbol;
            order.quantity = quantity;
            order.price = price;
            order.tokensLocked = nbTokensToLock;

            const orderInDB = await db.insert('buyBook', order);

            await findMatchingSellOrders(orderInDB, token.precision);
          }
        }
      }
    };

    actions.sell = async (payload) => {
      const { symbol, quantity, price, isSignedWithActiveKey } = payload;
      // sell (quantity) at (price)(symbol) per STEEM_PEGGED_SYMBOL
      if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
        && price && typeof price === 'number'
        && symbol && typeof symbol === 'string'
        && quantity && typeof quantity === 'number') {

        // get the token params
        const token = await db.findOneInTable('tokens', 'tokens', { symbol });

        // perform a few verifications
        if (token
          && price > 0
          && countDecimals(price) <= token.precision
          && countDecimals(quantity) <= 3) {
          // initiate a transfer from sender to null account
          const res = await executeSmartContract('tokens', 'transferToContract', { symbol: STEEM_PEGGED_SYMBOL, quantity, to: CONTRACT_NAME });

          if (res.errors === undefined) {
            // order
            const order = {};

            order.txId = transactionId;
            order.account = sender;
            order.symbol = symbol;
            order.quantity = quantity;
            order.price = price;

            const orderInDB = await db.insert('sellBook', order);

            await findMatchingBuyOrders(orderInDB, token.precision);
          }
        }
      }
    };

    const findMatchingSellOrders = async (order, tokenPrecision) => {
      const { txId, account, symbol, quantity, price } = order;
      const buyOrder = order;
      let offset = 0;
      
      // get the orders that match the symbol and the price
      let sellOrderBook = await db.find('sellBook', {
        symbol,
        price: {
          $lte: price,
        },
      }, 1000, offset,
      [
        { index: 'price', descending: false },
        { index: 'id', descending: false },
      ]);

      do {
        const nbOrders = sellOrderBook.length;
        let inc = 0;
        // debug(sellOrderBook)
        while (inc < nbOrders && buyOrder.quantity > 0) {
          const sellOrder = sellOrderBook[inc];
          if (buyOrder.quantity <= sellOrder.quantity) {

            // transfer the tokens to the accounts
            await transferTokens(account, STEEM_PEGGED_SYMBOL, buyOrder.quantity, 'user');

            const qtyTokensToSend = currency(sellOrder.price, { precision: tokenPrecision }).multiply(buyOrder.quantity).value;            
            await transferTokens(sellOrder.account, symbol, qtyTokensToSend, 'user');

            emit('filled', { to: sellOrder.account, qty: sellOrder.quantity, cost: qtyTokensToSend, symbol });

            // update the sell order
            const qtyLeftSellOrder = currency(sellOrder.quantity, { precision: tokenPrecision }).subtract(buyOrder.quantity).value;
            
            if (qtyLeftSellOrder > 0) {
              sellOrder.quantity = qtyLeftSellOrder;

              await db.update('sellBook', sellOrder);
            } else {
              await db.remove('sellBook', sellOrder);
            }

            // unlock remaining tokens, update the quantity to get and remove the buy order
            const tokensToUnlock = currency(buyOrder.tokensLocked, { precision: tokenPrecision }).subtract(qtyTokensToSend).value;

            if (tokensToUnlock > 0) {
              await transferTokens(account, symbol, tokensToUnlock, 'user');
            }
            
            buyOrder.quantity = 0;
            await db.remove('buyBook', buyOrder);
          } else {
            // transfer the tokens to the account
            await transferTokens(account, STEEM_PEGGED_SYMBOL, sellOrder.quantity, 'user');
            
            const qtyTokensToSend = currency(sellOrder.price, { precision: tokenPrecision }).multiply(sellOrder.quantity).value;
            await transferTokens(sellOrder.account, symbol, qtyTokensToSend, 'user');

            emit('filled', { to: sellOrder.account, qty: sellOrder.quantity, cost: qtyTokensToSend, symbol });

            // remove the sell order
            await db.remove('sellBook', sellOrder);

            // update tokensLocked and the quantity to get
            buyOrder.tokensLocked = currency(buyOrder.tokensLocked, { precision: tokenPrecision }).subtract(qtyTokensToSend).value;
            buyOrder.quantity = currency(buyOrder.quantity, { precision: tokenPrecision }).subtract(sellOrder.quantity).value;
          }

          inc += 1;
        }

        offset += 1000;

        if (buyOrder.quantity > 0) {
          // get the orders that match the symbol and the price
          sellOrderBook = await db.find('sellBook', {
            symbol,
            price: {
              $lte: price,
            },
          }, 1000, offset,
          [
            { index: 'price', descending: false },
            { index: 'id', descending: false },
          ]);
        }
      } while (sellOrderBook.length > 0 && buyOrder.quantity > 0);

      // update the buy order if partially filled
      if (buyOrder.quantity > 0) {
        await db.update('buyBook', buyOrder);
      }
    };

    const findMatchingBuyOrders = async (order, tokenPrecision) => {
      const { txId, account, symbol, quantity, price } = order;
      const sellOrder = order;
      let offset = 0;

      // get the orders that match the symbol and the price
      let buyOrderBook = await db.find('buyBook', {
        symbol,
        price: {
          $gte: price,
        },
      }, 1000, offset,
      [
        { index: 'price', descending: true },
        { index: 'id', descending: false },
      ]);

      do {
        const nbOrders = buyOrderBook.length;
        let inc = 0;
        //debug(buyOrderBook)
        while (inc < nbOrders && sellOrder.quantity > 0) {
          const buyOrder = buyOrderBook[inc];
          if (sellOrder.quantity <= buyOrder.quantity) {

            // transfer the tokens to the accounts
            await transferTokens(buyOrder.account, STEEM_PEGGED_SYMBOL, sellOrder.quantity, 'user');

            const qtyTokensToSend = currency(buyOrder.price, { precision: tokenPrecision }).multiply(sellOrder.quantity).value;
            
            await transferTokens(account, symbol, qtyTokensToSend, 'user');

            emit('filled', { to: buyOrder.account, qty: sellOrder.quantity, cost: qtyTokensToSend, symbol});

            // update the buy order
            const qtyLeftBuyOrder = currency(buyOrder.quantity, { precision: tokenPrecision }).subtract(sellOrder.quantity).value;

            const buyOrdertokensLocked = currency(buyOrder.tokensLocked, { precision: tokenPrecision }).subtract(qtyTokensToSend).value;
            
            if (qtyLeftBuyOrder > 0) {
              buyOrder.quantity = qtyLeftBuyOrder;
              buyOrder.tokensLocked = buyOrdertokensLocked;

              await db.update('buyBook', buyOrder);
            } else {
              if (buyOrdertokensLocked > 0) {
                await transferTokens(buyOrder.account, symbol, buyOrdertokensLocked, 'user');
              }
              await db.remove('buyBook', buyOrder);
            }
            
            sellOrder.quantity = 0;
            await db.remove('sellBook', sellOrder);
          } else {
            // transfer the tokens to the account
            await transferTokens(buyOrder.account, STEEM_PEGGED_SYMBOL, buyOrder.quantity, 'user');
            
            const qtyTokensToSend = currency(buyOrder.price, { precision: tokenPrecision }).multiply(buyOrder.quantity).value;
            await transferTokens(account, symbol, qtyTokensToSend, 'user');

            emit('filled', { to: buyOrder.account, qty: sellOrder.quantity, cost: qtyTokensToSend, symbol});

            // remove the buy order
            await db.remove('buyBook', buyOrder);

            // update the quantity to get
            sellOrder.quantity = currency(sellOrder.quantity, { precision: tokenPrecision }).subtract(buyOrder.quantity).value;
          }

          inc += 1;
        }

        offset += 1000;

        if (sellOrder.quantity > 0) {
          // get the orders that match the symbol and the price
          buyOrderBook = await db.find('buyBook', {
            symbol,
            price: {
              $gte: price,
            },
          }, 1000, offset,
          [
            { index: 'price', descending: true },
            { index: 'id', descending: false },
          ]);
        }
      } while (buyOrderBook.length > 0 && sellOrder.quantity > 0);

      // update the sell order if partially filled
      if (sellOrder.quantity > 0) {
        await db.update('sellBook', sellOrder);
      }
    };

    const countDecimals = (value) => {
      if (Math.floor(value) === value) return 0;
      return value.toString().split('.')[1].length || 0;
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
    transactions.push(new Transaction(genesisSteemBlock, 0, 'null', 'accounts', 'register'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'steemsc', 'accounts', 'register'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'steemsc', 'tokens', 'create', '{ "name": "STEEM Pegged", "symbol": "STEEMP", "precision": 3, "maxSupply": 1000000000000 }'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'steemsc', 'tokens', 'issue', '{ "symbol": "STEEMP", "to": "steemsc", "quantity": 1000000000000, "isSignedWithActiveKey": true }'));

    return transactions;
  }
}

module.exports.Bootstrap = Bootstrap;
