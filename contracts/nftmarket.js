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

/*const isValidIdArray = (arr) => {
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
};*/

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
        await api.db.createTable(marketTableName, ['account', 'priceSymbol', 'priceDec']);

        api.emit('enableMarket', { symbol });
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

  const marketTableName = symbol + 'sellBook';
  const tableExists = await api.db.tableExists(marketTableName);

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(nfts && typeof nfts === 'object' && Array.isArray(nfts)
    && symbol && typeof symbol === 'string'
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
