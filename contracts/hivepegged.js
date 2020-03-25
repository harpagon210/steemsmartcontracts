/* eslint-disable no-await-in-loop */
/* global actions, api */

const initiateWithdrawal = async (id, recipient, quantity, memo) => {
  const withdrawal = {};

  withdrawal.id = id;
  withdrawal.type = 'HIVE';
  withdrawal.recipient = recipient;
  withdrawal.memo = memo;
  withdrawal.quantity = quantity;

  await api.db.insert('withdrawals', withdrawal);
};

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('withdrawals');

  if (tableExists === false) {
    await api.db.createTable('withdrawals');
  }
};

actions.buy = async (payload) => {
  const { recipient, amountHIVEHBD, isSignedWithActiveKey } = payload;

  if (recipient !== api.owner) return;

  if (recipient && amountHIVEHBD && isSignedWithActiveKey) {
    const res = amountHIVEHBD.split(' ');

    const unit = res[1];

    // HIVE
    if (api.assert(unit === 'HIVE', 'only HIVE can be used')) {
      let quantityToSend = res[0];

      // calculate the 1% fee (with a min of 0.001 HIVE)
      let fee = api.BigNumber(quantityToSend).multipliedBy(0.01).toFixed(3);

      if (api.BigNumber(fee).lt('0.001')) {
        fee = '0.001';
      }

      quantityToSend = api.BigNumber(quantityToSend).minus(fee).toFixed(3);

      if (api.BigNumber(quantityToSend).gt(0)) {
        await api.executeSmartContractAsOwner('tokens', 'transfer', { symbol: 'SWAP.HIVE', quantity: quantityToSend, to: api.sender });
      }

      if (api.BigNumber(fee).gt(0)) {
        const memo = `fee tx ${api.transactionId}`;
        // eslint-disable-next-line no-template-curly-in-string
        await initiateWithdrawal(`${api.transactionId}-fee`, "'${CONSTANTS.ACCOUNT_RECEIVING_FEES}$'", fee, memo);
      }
    } else {
      // SBD not supported
    }
  }
};

actions.withdraw = async (payload) => {
  const { quantity, isSignedWithActiveKey } = payload;

  if (api.assert(quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN()
    && isSignedWithActiveKey
    && api.BigNumber(quantity).dp() <= 3, 'invalid params')
    && api.assert(api.BigNumber(quantity).gte(0.002), 'minimum withdrawal is 0.002')
  ) {
    // calculate the 1% fee (with a min of 0.001 HIVE)
    let fee = api.BigNumber(quantity).multipliedBy(0.01).toFixed(3);

    if (api.BigNumber(fee).lt('0.001')) {
      fee = '0.001';
    }

    const quantityToSend = api.BigNumber(quantity).minus(fee).toFixed(3);

    if (api.BigNumber(quantityToSend).gt(0)) {
      const res = await api.executeSmartContract('tokens', 'transfer', { symbol: 'SWAP.HIVE', quantity, to: api.owner });

      if (res.errors === undefined
        && res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transfer' && el.data.from === api.sender && el.data.to === api.owner && el.data.quantity === quantity && el.data.symbol === 'SWAP.HIVE') !== undefined) {
        // withdrawal
        let memo = `withdrawal tx ${api.transactionId}`;

        await initiateWithdrawal(api.transactionId, api.sender, quantityToSend, memo);

        if (api.BigNumber(fee).gt(0)) {
          memo = `fee tx ${api.transactionId}`;
          // eslint-disable-next-line no-template-curly-in-string
          await initiateWithdrawal(`${api.transactionId}-fee`, "'${CONSTANTS.ACCOUNT_RECEIVING_FEES}$'", fee, memo);
        }
      }
    }
  }
};

actions.removeWithdrawal = async (payload) => {
  const { id, isSignedWithActiveKey } = payload;

  if (api.sender !== api.owner) return;

  if (id && isSignedWithActiveKey) {
    const withdrawal = await api.db.findOne('withdrawals', { id });

    if (withdrawal) {
      await api.db.remove('withdrawals', withdrawal);
    }
  }
};
