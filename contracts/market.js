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
    const order = await api.db.findOne(table, { _id: id });

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
};

actions.buy = async (payload) => {
  const {
    symbol, quantity, price, expiration, isSignedWithActiveKey,
  } = payload;

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

      if (api.assert(api.refSteemBlockNumber < '${FORK_BLOCK_NUMBER_TWO}$' || api.BigNumber(nbTokensToLock).gte('0.001'), 'order cannot be placed as it cannot be filled')) {
        // lock STEEM_PEGGED_SYMBOL tokens
        const res = await api.executeSmartContract('tokens', 'transferToContract', { symbol: STEEM_PEGGED_SYMBOL, quantity: nbTokensToLock, to: CONTRACT_NAME });

        if (res.errors === undefined
          && res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === api.sender && el.data.to === CONTRACT_NAME && el.data.quantity === nbTokensToLock && el.data.symbol === STEEM_PEGGED_SYMBOL) !== undefined) {
          const timestampSec = api.BigNumber(new Date(`${api.steemBlockTimestamp}.000Z`).getTime())
            .dividedBy(1000)
            .toNumber();

          // order
          const order = {};

          order.txId = api.transactionId;
          order.timestamp = timestampSec;
          order.account = api.sender;
          order.symbol = symbol;
          order.quantity = api.BigNumber(quantity).toFixed(token.precision);
          order.price = api.BigNumber(price).toFixed(3);
          order.tokensLocked = nbTokensToLock;
          order.expiration = expiration === undefined || expiration > 2592000
            ? timestampSec + 2592000
            : timestampSec + expiration;

          const orderInDb = await api.db.insert('buyBook', order);

          await findMatchingSellOrders(orderInDb, token.precision);
        }
      }
    }
  }
};

actions.sell = async (payload) => {
  const {
    symbol, quantity, price, expiration, isSignedWithActiveKey,
  } = payload;
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

      if (api.assert(api.refSteemBlockNumber < '${FORK_BLOCK_NUMBER_TWO}$' || api.BigNumber(nbTokensToFillOrder).gte('0.001'), 'order cannot be placed as it cannot be filled')) {
        // initiate a transfer from api.sender to contract balance
        // lock symbol tokens
        const res = await api.executeSmartContract('tokens', 'transferToContract', { symbol, quantity, to: CONTRACT_NAME });

        if (res.errors === undefined
          && res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === api.sender && el.data.to === CONTRACT_NAME && el.data.quantity === quantity && el.data.symbol === symbol) !== undefined) {
          const timestampSec = api.BigNumber(new Date(`${api.steemBlockTimestamp}.000Z`).getTime())
            .dividedBy(1000)
            .toNumber();

          // order
          const order = {};

          order.txId = api.transactionId;
          order.timestamp = timestampSec;
          order.account = api.sender;
          order.symbol = symbol;
          order.quantity = api.BigNumber(quantity).toFixed(token.precision);
          order.price = api.BigNumber(price).toFixed(3);
          order.expiration = expiration === undefined || expiration > 2592000
            ? timestampSec + 2592000
            : timestampSec + expiration;

          const orderInDb = await api.db.insert('sellBook', order);

          await findMatchingBuyOrders(orderInDb, token.precision);
        }
      }
    }
  }
};

const findMatchingSellOrders = async (order, tokenPrecision) => {
  const {
    account, symbol, price,
  } = order;

  const buyOrder = order;
  let offset = 0;
  let volumeTraded = 0;

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
      { index: '_id', descending: false },
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
          const qtyLeftSellOrder = api.BigNumber(sellOrder.quantity)
            .minus(buyOrder.quantity)
            .toFixed(tokenPrecision);
          const nbTokensToFillOrder = api.BigNumber(sellOrder.price)
            .multipliedBy(qtyLeftSellOrder)
            .toFixed(3);

          if (api.BigNumber(qtyLeftSellOrder).gt(0)
            && (api.refSteemBlockNumber < '${FORK_BLOCK_NUMBER_TWO}$' || api.BigNumber(nbTokensToFillOrder).gte('0.001'))) {
            sellOrder.quantity = qtyLeftSellOrder;

            await api.db.update('sellBook', sellOrder);
          } else {
            if (api.BigNumber(qtyLeftSellOrder).gt(0)) {
              await api.transferTokens(sellOrder.account, symbol, qtyLeftSellOrder, 'user');
            }
            await api.db.remove('sellBook', sellOrder);
          }

          // unlock remaining tokens, update the quantity to get and remove the buy order
          const tokensToUnlock = api.BigNumber(buyOrder.tokensLocked)
            .minus(qtyTokensToSend)
            .toFixed(3);

          if (api.BigNumber(tokensToUnlock).gt(0)) {
            await api.transferTokens(account, STEEM_PEGGED_SYMBOL, tokensToUnlock, 'user');
          }

          // add the trade to the history
          await updateTradesHistory('buy', symbol, buyOrder.quantity, sellOrder.price);

          // update the volume
          volumeTraded = api.BigNumber(volumeTraded).plus(qtyTokensToSend);

          buyOrder.quantity = '0';
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
          buyOrder.tokensLocked = api.BigNumber(buyOrder.tokensLocked)
            .minus(qtyTokensToSend)
            .toFixed(3);
          buyOrder.quantity = api.BigNumber(buyOrder.quantity)
            .minus(sellOrder.quantity)
            .toFixed(tokenPrecision);

          // check if the order can still be filled
          const nbTokensToFillOrder = api.BigNumber(buyOrder.price)
            .multipliedBy(buyOrder.quantity)
            .toFixed(3);

          if (api.refSteemBlockNumber >= '${FORK_BLOCK_NUMBER_TWO}$' && api.BigNumber(nbTokensToFillOrder).lt('0.001')) {
            await api.transferTokens(account, STEEM_PEGGED_SYMBOL, buyOrder.tokensLocked, 'user');

            buyOrder.quantity = '0';
            await api.db.remove('buyBook', buyOrder);
          }

          // add the trade to the history
          await updateTradesHistory('buy', symbol, sellOrder.quantity, sellOrder.price);

          // update the volume
          volumeTraded = api.BigNumber(volumeTraded).plus(qtyTokensToSend);
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
          { index: '_id', descending: false },
        ]);
    }
  } while (sellOrderBook.length > 0 && api.BigNumber(buyOrder.quantity).gt(0));

  // update the buy order if partially filled
  if (api.BigNumber(buyOrder.quantity).gt(0)) {
    await api.db.update('buyBook', buyOrder);
  }

  await updateVolumeMetric(symbol, volumeTraded);
  await updateAskMetric(symbol);
  await updateBidMetric(symbol);
};

const findMatchingBuyOrders = async (order, tokenPrecision) => {
  const {
    account, symbol, price,
  } = order;

  const sellOrder = order;
  let offset = 0;
  let volumeTraded = 0;

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
      { index: '_id', descending: false },
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
          const qtyLeftBuyOrder = api.BigNumber(buyOrder.quantity)
            .minus(sellOrder.quantity)
            .toFixed(tokenPrecision);

          const buyOrdertokensLocked = api.BigNumber(buyOrder.tokensLocked)
            .minus(qtyTokensToSend)
            .toFixed(3);
          const nbTokensToFillOrder = api.BigNumber(buyOrder.price)
            .multipliedBy(qtyLeftBuyOrder)
            .toFixed(3);

          if (api.BigNumber(qtyLeftBuyOrder).gt(0)
            && (api.refSteemBlockNumber < '${FORK_BLOCK_NUMBER_TWO}$' || api.BigNumber(nbTokensToFillOrder).gte('0.001'))) {
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
          volumeTraded = api.BigNumber(volumeTraded).plus(qtyTokensToSend);

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
          sellOrder.quantity = api.BigNumber(sellOrder.quantity)
            .minus(buyOrder.quantity)
            .toFixed(tokenPrecision);

          // check if the order can still be filled
          const nbTokensToFillOrder = api.BigNumber(sellOrder.price)
            .multipliedBy(sellOrder.quantity)
            .toFixed(3);

          if (api.refSteemBlockNumber >= '${FORK_BLOCK_NUMBER_TWO}$' && api.BigNumber(nbTokensToFillOrder).lt('0.001')) {
            await api.transferTokens(account, symbol, sellOrder.quantity, 'user');

            sellOrder.quantity = '0';
            await api.db.remove('sellBook', sellOrder);
          }

          // add the trade to the history
          await updateTradesHistory('sell', symbol, buyOrder.quantity, buyOrder.price);

          // update the volume
          volumeTraded = api.BigNumber(volumeTraded).plus(qtyTokensToSend);
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
          { index: '_id', descending: false },
        ]);
    }
  } while (buyOrderBook.length > 0 && api.BigNumber(sellOrder.quantity).gt(0));

  // update the sell order if partially filled
  if (api.BigNumber(sellOrder.quantity).gt(0)) {
    await api.db.update('sellBook', sellOrder);
  }

  await updateVolumeMetric(symbol, volumeTraded);
  await updateAskMetric(symbol);
  await updateBidMetric(symbol);
};

const removeExpiredOrders = async (table) => {
  const timestampSec = api.BigNumber(new Date(`${api.steemBlockTimestamp}.000Z`).getTime())
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
      let quantity;
      let symbol;

      if (table === 'buyBook') {
        symbol = STEEM_PEGGED_SYMBOL;
        quantity = order.tokensLocked;
      } else {
        symbol = order.symbol;
        quantity = order.quantity;
      }

      // unlock tokens
      await api.transferTokens(order.account, symbol, quantity, 'user');

      await api.db.remove(table, order);

      if (table === 'buyBook') {
        await updateAskMetric(order.symbol);
      } else {
        await updateBidMetric(order.symbol);
      }
    });

    ordersToDelete = await api.db.find(
      table,
      {
        expiration: {
          $lte: timestampSec,
        },
      });
  }
};

const getMetric = async (symbol) => {
  let metric = await api.db.findOne('metrics', { symbol });

  if (metric === null) {
    metric = {};
    metric.symbol = symbol;
    metric.volume = '0';
    metric.volumeExpiration = 0;
    metric.lastPrice = '0';
    metric.lowestAsk = '0';
    metric.highestBid = '0';
    metric.lastDayPrice = '0';
    metric.lastDayPriceExpiration = 0;
    metric.priceChangeSteem = '0';
    metric.priceChangePercent = '0';

    return await api.db.insert('metrics', metric);
  }

  return metric;
};

const updateVolumeMetric = async (symbol, quantity) => {
  const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);
  const timestampSec = blockDate.getTime() / 1000;

  const metric = await getMetric(symbol);

  if (metric.volumeExpiration < timestampSec) {
    metric.volume = api.BigNumber(quantity).toFixed(3);
    metric.volumeExpiration = blockDate.setDate(blockDate.getDate() + 1) / 1000;
  } else {
    metric.volume = api.BigNumber(metric.volume).plus(quantity).toFixed(3);
  }

  await api.db.update('metrics', metric);
};

const updateBidMetric = async (symbol) => {
  const metric = await getMetric(symbol);

  const buyOrderBook = await api.db.find('buyBook',
    {
      symbol,
    }, 1, 0,
    [
      { index: 'price', descending: true },
    ]);


  if (buyOrderBook.length > 0) {
    metric.highestBid = buyOrderBook[0].price;
  } else {
    metric.highestBid = '0';
  }

  await api.db.update('metrics', metric);
};

const updateAskMetric = async (symbol) => {
  const metric = await getMetric(symbol);

  const sellOrderBook = await api.db.find('sellBook',
    {
      symbol,
    }, 1, 0,
    [
      { index: 'price', descending: false },
    ]);

  if (sellOrderBook.length > 0) {
    metric.lowestAsk = sellOrderBook[0].price;
  } else {
    metric.lowestAsk = '0';
  }

  await api.db.update('metrics', metric);
};

const updatePriceMetrics = async (symbol, price) => {
  const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`)
  const timestampSec = blockDate.getTime() / 1000;

  const metric = await getMetric(symbol);

  metric.lastPrice = price;

  if (metric.lastDayPriceExpiration < timestampSec) {
    metric.lastDayPrice = price;
    metric.lastDayPriceExpiration = blockDate.setDate(blockDate.getDate() + 1) / 1000;
    metric.priceChangeSteem = '0';
    metric.priceChangePercent = '0%';
  } else {
    metric.priceChangeSteem = api.BigNumber(price).minus(metric.lastDayPrice).toFixed(3);
    metric.priceChangePercent = `${api.BigNumber(metric.priceChangeSteem).dividedBy(metric.lastDayPrice).multipliedBy(100).toFixed(2)}%`;
  }

  await api.db.update('metrics', metric);
};

const updateTradesHistory = async (type, symbol, quantity, price) => {
  const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);
  const timestampSec = blockDate.getTime() / 1000;

  const timestampMinus24hrs = blockDate.setDate(blockDate.getDate() - 1) / 1000;

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

  await updatePriceMetrics(symbol, price);
};

const countDecimals = (value) => api.BigNumber(value).dp();
