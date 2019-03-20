actions.createSSC = async (payload) => {
  await api.db.createTable('params');
  const params = {};

  params.priceSBD = '1000000';
  params.priceSteem = "'${SSC_STORE_PRICE}$'";
  params.quantity = "'${SSC_STORE_QTY}$'";
  params.disabled = false;

  await api.db.insert('params', params);
};

actions.updateParams = async (payload) => {
  if (api.sender !== api.owner) return;

  const {
    priceSBD, priceSteem, quantity, disabled,
  } = payload;

  const params = await api.db.findOne('params', {});

  params.priceSBD = priceSBD;
  params.priceSteem = priceSteem;
  params.quantity = quantity;
  params.disabled = disabled;

  await api.db.update('params', params);
};

actions.buy = async (payload) => {
  const { recipient, amountSTEEMSBD, isSignedWithActiveKey } = payload;

  if (recipient !== api.owner) return;

  if (api.assert(recipient && amountSTEEMSBD && isSignedWithActiveKey, 'invalid params')) {
    const params = await api.db.findOne('params', {});

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
    } else { // SBD (disabled)
      // quantity = api.BigNumber(amount).dividedBy(params.priceSBD);
    }

    if (api.refSteemBlockNumber < '${FORK_BLOCK_NUMBER}$') {
      quantityToSend = Number(api.BigNumber(quantity).multipliedBy(params.quantity).toFixed('${BP_CONSTANTS.UTILITY_TOKEN_PRECISION}$'));
    } else {
      quantityToSend = api.BigNumber(quantity).multipliedBy(params.quantity).toFixed('${BP_CONSTANTS.UTILITY_TOKEN_PRECISION}$');
    }

    if (quantityToSend > 0) {
      await api.executeSmartContractAsOwner('tokens', 'transfer', { symbol: "'${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: quantityToSend, to: api.sender });
    }
  }
};
