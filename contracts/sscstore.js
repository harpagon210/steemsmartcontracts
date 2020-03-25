/* eslint-disable no-await-in-loop */
/* global actions, api */

actions.createSSC = async () => {
  await api.db.createTable('params');
  const params = {};

  params.priceHBD = '1000000';
  // eslint-disable-next-line no-template-curly-in-string
  params.priceHive = "'${CONSTANTS.SSC_STORE_PRICE}$'";
  // eslint-disable-next-line no-template-curly-in-string
  params.quantity = "'${CONSTANTS.SSC_STORE_QTY}$'";
  params.disabled = false;

  await api.db.insert('params', params);
};

actions.updateParams = async (payload) => {
  if (api.sender !== api.owner) return;

  const {
    priceHBD, priceHive, quantity, disabled,
  } = payload;

  const params = await api.db.findOne('params', {});

  params.priceHBD = priceHBD;
  params.priceHive = priceHive;
  params.quantity = quantity;
  params.disabled = disabled;

  await api.db.update('params', params);
};

actions.buy = async (payload) => {
  const { recipient, amountHIVEHBD, isSignedWithActiveKey } = payload;

  if (recipient !== api.owner) return;

  if (api.assert(recipient && amountHIVEHBD && isSignedWithActiveKey, 'invalid params')) {
    const params = await api.db.findOne('params', {});

    if (params.disabled) return;

    const res = amountHIVEHBD.split(' ');

    const amount = res[0];
    const unit = res[1];

    let quantity = 0;
    let quantityToSend = 0;
    api.BigNumber.set({ DECIMAL_PLACES: 3 });

    // HIVE
    if (unit === 'HIVE') {
      quantity = api.BigNumber(amount).dividedBy(params.priceHive);
    } else { // HBD (disabled)
      // quantity = api.BigNumber(amount).dividedBy(params.priceHBD);
    }

    // eslint-disable-next-line no-template-curly-in-string
    quantityToSend = api.BigNumber(quantity).multipliedBy(params.quantity).toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');

    if (quantityToSend > 0) {
      // eslint-disable-next-line no-template-curly-in-string
      await api.executeSmartContractAsOwner('tokens', 'transfer', { symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: quantityToSend, to: api.sender });
    }
  }
};
