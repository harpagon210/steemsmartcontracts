/* eslint-disable no-await-in-loop */
/* eslint-disable max-len */
/* global actions, api */

const CONTRACT_NAME = 'nftmarket';

// eslint-disable-next-line no-template-curly-in-string
const UTILITY_TOKEN_SYMBOL = "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'";

// cannot buy or sell more than this number of NFT instances in one action
const MAX_NUM_UNITS_OPERABLE = 50;

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('sellBook');

  if (tableExists === false) {
    await api.db.createTable('tradesHistory', ['symbol']);
    await api.db.createTable('metrics', ['symbol']);
  }
};

const countDecimals = value => api.BigNumber(value).dp();

const isValidIdArray = (arr) => {
  try {
    if (!api.assert(arr && typeof arr === 'object' && Array.isArray(arr), 'invalid id list')) {
      return false;
    }

    if (!api.assert(arr.length <= MAX_NUM_UNITS_OPERABLE, `cannot act on more than ${MAX_NUM_UNITS_OPERABLE} IDs at once`)) {
      return false;
    }

    for (let i = 0; i < arr.length; i += 1) {
      const id = arr[i];
      if (!api.assert(id && typeof id === 'string' && !api.BigNumber(id).isNaN() && api.BigNumber(id).gt(0), 'invalid id list')) {
        return false;
      }
    }
  } catch (e) {
    return false;
  }
  return true;
};

actions.enableMarket = async (payload) => {
  const {
    symbol,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string', 'invalid params')) {
    // make sure NFT exists and verify ownership
    const nft = await api.db.findOneInTable('nft', 'nfts', { symbol });
    if (api.assert(nft !== null, 'symbol does not exist')
      && api.assert(nft.issuer === api.sender, 'must be the issuer')) {
      // create a new table to hold market orders for this NFT
      // eslint-disable-next-line prefer-template
      const marketTableName = symbol + 'sellBook';
      const tableExists = await api.db.tableExists(marketTableName);
      if (api.assert(tableExists === false, 'market already enabled')) {
        await api.db.createTable(marketTableName, ['account', 'ownedBy', 'nftId', 'priceSymbol', 'priceDec']);

        api.emit('enableMarket', { symbol });
      }
    }
  }
};

actions.cancel = async (payload) => {
  const {
    symbol,
    nfts,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(symbol && typeof symbol === 'string', 'invalid params')) {
    return;
  }

  const marketTableName = symbol + 'sellBook';
  const tableExists = await api.db.tableExists(marketTableName);

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && isValidIdArray(nfts)
    && api.assert(tableExists, 'market not enabled for symbol')) {
    // look up order info
    const orders = await api.db.find(
      marketTableName,
      {
        nftId: {
          $in: nfts,
        },
      },
      MAX_NUM_UNITS_OPERABLE,
      0,
      [{ index: 'nftId', descending: false }],
    );

    if (orders.length > 0) {
      // need to make sure that caller is actually the owner of each order
      const ids = [];
      const idMap = {};
      for (let i = 0; i < orders.length; i += 1) {
        const order = orders[i];
        if (!api.assert(order.account === api.sender
          && order.ownedBy === 'u', 'all orders must be your own')) {
          return;
        }
        ids.push(order.nftId);
        idMap[order.nftId] = order;
      }

      // move the locked NFTs back to their owner
      const nftArray = [];
      const wrappedNfts = {
        symbol,
        ids,
      };
      nftArray.push(wrappedNfts);
      const res = await api.executeSmartContract('nft', 'transfer', {
        fromType: 'contract',
        to: api.sender,
        toType: 'user',
        nfts: nftArray,
        isSignedWithActiveKey,
      });

      // it's possible (but unlikely) that some transfers could have failed
      // due to validation errors & whatnot, so we need to loop over the
      // transfer results and only cancel orders for the transfers that succeeded
      if (res.events) {
        for (let j = 0; j < res.events.length; j += 1) {
          const ev = res.events[j];
          if (ev.contract && ev.event && ev.data
            && ev.contract === 'nft'
            && ev.event === 'transfer'
            && ev.data.from === CONTRACT_NAME
            && ev.data.fromType === 'c'
            && ev.data.to === api.sender
            && ev.data.toType === 'u'
            && ev.data.symbol === symbol) {
            // transfer is verified, now we can cancel the order
            const instanceId = ev.data.id;
            if (instanceId in idMap) {
              const order = idMap[instanceId];

              await api.db.remove(marketTableName, order);

              api.emit('cancelOrder', {
                account: order.account,
                ownedBy: order.ownedBy,
                symbol,
                nftId: order.nftId,
                timestamp: order.timestamp,
                price: order.price,
                priceSymbol: order.priceSymbol,
                fee: order.fee,
                orderId: order._id,
              });
            }
          }
        }
      }
    }
  }
};

actions.sell = async (payload) => {
  const {
    symbol,
    nfts,
    price,
    priceSymbol,
    fee,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(symbol && typeof symbol === 'string', 'invalid params')) {
    return;
  }

  const marketTableName = symbol + 'sellBook';
  const tableExists = await api.db.tableExists(marketTableName);

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(nfts && typeof nfts === 'object' && Array.isArray(nfts)
    && priceSymbol && typeof priceSymbol === 'string'
    && price && typeof price === 'string' && !api.BigNumber(price).isNaN()
    && fee && typeof fee === 'number' && fee >= 0 && fee <= 10000 && Number.isInteger(fee), 'invalid params')
    && api.assert(nfts.length <= MAX_NUM_UNITS_OPERABLE, `cannot sell more than ${MAX_NUM_UNITS_OPERABLE} NFT instances at once`)
    && api.assert(tableExists, 'market not enabled for symbol')) {
    // get the price token params
    const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: priceSymbol });
    if (api.assert(token
      && api.BigNumber(price).gt(0)
      && countDecimals(price) <= token.precision, 'invalid price')) {
      // lock the NFTs to sell by moving them to this contract for safekeeping
      const nftArray = [];
      const wrappedNfts = {
        symbol,
        ids: nfts,
      };
      nftArray.push(wrappedNfts);
      const res = await api.executeSmartContract('nft', 'transfer', {
        fromType: 'user',
        to: CONTRACT_NAME,
        toType: 'contract',
        nfts: nftArray,
        isSignedWithActiveKey,
      });

      // it's possible that some transfers could have failed due to validation
      // errors & whatnot, so we need to loop over the transfer results and
      // only create market orders for the transfers that succeeded
      if (res.events) {
        const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);
        const timestamp = blockDate.getTime();
        const finalPrice = api.BigNumber(price).toFixed(token.precision);

        for (let i = 0; i < res.events.length; i += 1) {
          const ev = res.events[i];
          if (ev.contract && ev.event && ev.data
            && ev.contract === 'nft'
            && ev.event === 'transfer'
            && ev.data.from === api.sender
            && ev.data.fromType === 'u'
            && ev.data.to === CONTRACT_NAME
            && ev.data.toType === 'c'
            && ev.data.symbol === symbol) {
            // transfer is verified, now we can add a market order
            let instanceId = ev.data.id;

            const order = {
              account: api.sender,
              ownedBy: ev.data.fromType,
              nftId: instanceId,
              timestamp,
              price: finalPrice,
              priceDec: { $numberDecimal: finalPrice },
              priceSymbol,
              fee,
            };

            const result = await api.db.insert(marketTableName, order);

            api.emit('sellOrder', {
              account: order.account,
              ownedBy: order.ownedBy,
              symbol,
              nftId: order.nftId,
              timestamp,
              price: order.price,
              priceSymbol: order.priceSymbol,
              fee,
              orderId: result._id,
            });
          }
        }
      }
    }
  }
};
