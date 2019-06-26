/* eslint-disable no-await-in-loop */
/* global actions, api */

/**
 * A contract to enable payment subscriptions
 * @author https://github.com/eleardev
 */

const CONTRACT_NAME = 'subscriptions';
const PERIODS = ['min', 'hour', 'day', 'week', 'month'];
const countDecimals = value => api.BigNumber(value).dp();

actions.createSSC = async () => {
  let tableExists = await api.db.tableExists('subscriptions');
  if (tableExists === false) {
    /**
     * Stores the subscriptions initiated by the subscriber
     *
     * id {String} A unique identifier for this subscription, which is the transaction ID
     * active {Boolean} whether this subscription is still active
     * provider {String} the account/platform authorized to request installments
     * subscriber {String} the user who has initiated the subscription and pays the installments
     * beneficiaries {Array<Object>} Beneficiaries and the percent each one receives
     * quantity {Number} how much should be sent for each subscription installment
     * symbol {String} the token
     * period {Enum} min/hour/day/week/month
     * recur {Number} how often the payment should be sent per period (i.e. every 1 month)
     * max {Number} the number of max installments this subscription should ever pay
     */
    await api.db.createTable('subscriptions', ['id', 'active', 'provider', 'subscriber', 'beneficiaries', 'quantity', 'symbol', 'period', 'recur', 'max']);
    /**
     * Stores the installments paid by the subscriber
     *
     * subscriptionId {String} The unique id for the subscription being paid
     * timestamp {Date} full date when this installment was paid
     */
    await api.db.createTable('installments', ['subscriptionId', 'timestamp']);
  }
};

/**
 * Adds a subscription. Can only be initiated by the subscriber.
 * Adding a subscription only stores the consent of the subscriber but
 * does not move any token, to allow the receiver to delay the first
 * installment (for example a platform offering a trial period before charging)
 */
actions.subscribe = async (payload) => {
  const {
    provider,
    beneficiaries,
    quantity,
    symbol,
    period,
    recur,
    max,
    isSignedWithActiveKey,
  } = payload;

  const { sender, BigNumber, transactionId } = api;
  const finalProvider = provider ? provider.trim() : null;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(finalProvider
      && typeof finalProvider === 'string'
      && finalProvider.length >= 3
      && finalProvider.length <= 16
      && quantity
      && !BigNumber(quantity).isNaN()
      && BigNumber(quantity).gt(0)
      && period
      && typeof period === 'string'
      && PERIODS.includes(period)
      && max
      && !BigNumber(max).isNaN()
      && BigNumber(max).gte(1)
      && recur
      && !BigNumber(recur).isNaN()
      && BigNumber(recur).gt(1)
      && symbol
      && typeof symbol === 'string'
      && typeof recur === 'string', 'invalid params')
    && api.assert(beneficiaries
      && Array.isArray(beneficiaries)
      && beneficiaries.length, 'invalid beneficiaries')
  ) {
    const finalBeneficiaries = [];
    let totalPercent = 0; // check that totalPercent is not greater than 10000

    for (let i = 0; i < beneficiaries.length; i += 1) {
      const account = beneficiaries[i].account ? beneficiaries[i].account.trim() : null;
      const { percent } = beneficiaries[i];
      if (api.assert(account
        && percent
        && BigNumber(percent).gt(0)
        && BigNumber(percent).lte(10000)
        && account.length >= 3
        && account.length <= 16
        && account !== sender, 'invalid beneficiary found')
      ) {
        totalPercent += BigNumber(percent).toNumber();
        finalBeneficiaries.push({
          account,
          percent,
        });
      } else {
        break;
      }
    }

    if (api.assert(totalPercent === 10000, 'invalid beneficiaries percentage')) {
      if (api.assert(finalBeneficiaries.length && finalBeneficiaries.length === beneficiaries.length, 'beneficiaries are empty or invalid')
        && api.assert(finalProvider !== sender, 'subscriber cannot be the provider')
      ) {
        const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });

        if (api.assert(token !== null, 'symbol does not exist')
          && api.assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')) {
          const subscription = await api.db.findOne('subscriptions', {
            id: transactionId,
            subscriber: sender,
            provider,
          });
          if (api.assert(subscription === null, 'a subscription with this identifier already exists')) {
            /**
             * Checks if the provider is already authorized by this contract to
             * transfer (symbol) funds on behalf of the user
             */
            const isAuthorized = await api.db.findOneInTable('tokens', 'authorizations', {
              contract: CONTRACT_NAME,
              delegator: sender,
              delegatee: finalProvider,
              symbol,
              type: 'transfer',
            });

            if (isAuthorized === null) {
              // if not authorized, authorize it now
              const addAuth = await api.addAuthorization(CONTRACT_NAME, sender, finalProvider, symbol, 'transfer');
              if (!addAuth) return false;
            }

            /**
             * Saving the subscription
             */
            await api.db.insert('subscriptions', {
              id: transactionId,
              active: true,
              provider: finalProvider,
              subscriber: sender,
              beneficiaries: finalBeneficiaries,
              quantity,
              symbol,
              period,
              recur,
              max,
            });

            api.emit('subscribe', {
              subscriber: sender,
              id: transactionId,
              provider: finalProvider,
              beneficiaries: finalBeneficiaries,
              quantity,
              symbol,
              period,
              recur,
              max,
            });

            return true;
          }
        }
      }
    }
  }
  return false;
};

/**
 * Removes a subscription.
 */
actions.unsubscribe = async (payload) => {
  const {
    id, isSignedWithActiveKey,
  } = payload;
  const { sender } = api;
  const finalIdentifier = id ? id.trim() : null;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(
      finalIdentifier
      && typeof finalIdentifier === 'string'
      && finalIdentifier.length >= 40
      && api.validator.isAlphanumeric(finalIdentifier), 'invalid params')
  ) {
    const subscription = await api.db.findOne('subscriptions', {
      id: finalIdentifier,
      subscriber: sender,
      active: true,
    });

    if (api.assert(subscription !== null, 'subscription does not exist or was already removed')) {
      subscription.active = false;
      // deactivate this subscription
      await api.db.update('subscriptions', subscription);

      /**
       * Checks if there are other subscriptions active from this provider on the same symbol,
       * if not remove the authorization to transfer symbol
       */
      const hasSubscription = await api.db.findOne('subscriptions', {
        provider: subscription.provider,
        subscriber: sender,
        symbol: subscription.symbol,
        active: true,
      });

      if (hasSubscription === null) {
        // remove authorization to transfer (symbol) funds
        await api.removeAuthorization(CONTRACT_NAME, sender, subscription.provider, subscription.symbol, 'transfer');
      }

      api.emit('unsubscribe', {
        subscriber: sender,
        id: finalIdentifier,
        provider: subscription.provider,
      });
      return true;
    }
  }

  return false;
};

const processInstallment = async (subscription, first) => {
  const {
    beneficiaries,
    symbol,
    quantity,
    subscriber,
    id,
  } = subscription;

  /**
   * Before attempting the payments,
   * check if there are enough funds
   */
  const hasFunds = await api.db.findOneInTable('tokens', 'balances', { account: subscriber, symbol });

  if (api.assert(api.BigNumber(hasFunds.balance).gte(quantity), 'does not have enough funds')) {
    for (let i = 0; i < beneficiaries.length; i += 1) {
      const { account, percent } = beneficiaries[i];
      const finalQuantity = ((percent / 100) / 100) * quantity;
      await api.authorizeTransfer(CONTRACT_NAME, api.sender, subscriber, account, symbol, finalQuantity);
    }
    await api.db.insert('installments', {
      subscriptionId: subscription.id,
      timestamp: api.steemBlockTimestamp,
    });
    api.emit('installment', {
      id,
      provider: api.sender,
      subscriber: subscriber,
      first,
    });
    return true;
  }
  return false;
};

/**
 * The provider must request an installment to be paid using this action.
 * The contract will make sure the installment is authorized based on the agreed
 * params in the subscription (see actions.subscribe)
 */
actions.installment = async (payload) => {
  const {
    id, isSignedWithActiveKey,
  } = payload;
  const { sender, steemBlockTimestamp, BigNumber } = api;
  const finalIdentifier = id ? id.trim() : null;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(finalIdentifier
      && typeof finalIdentifier === 'string'
      && finalIdentifier.length >= 40
      && api.validator.isAlphanumeric(finalIdentifier), 'invalid params')
  ) {
    const subscription = await api.db.findOne('subscriptions', {
      id: finalIdentifier,
      provider: sender,
      active: true,
    });
    if (api.assert(subscription !== null, 'subscription does not exist or is inactive')) {
      const installments = await api.db.find('installments', {
          subscriptionId: finalIdentifier,
        }, BigNumber(subscription.max).toNumber(), 0,
        [
          { index: 'timestamp', descending: true },
          { index: '$loki', descending: false },
        ]);
      /**
       * This is the first payment, process it
       */
      if (!installments.length) {
        await processInstallment(subscription, true);
        return true;
      }
      if (api.assert(installments.length < subscription.max, 'subscription reached max payable installments')) {
        const trxTimestamp = new Date(steemBlockTimestamp).getTime();
        const lastInstallment = installments[0];
        const lastInstallmentTime = new Date(lastInstallment.timestamp).getTime();
        const { recur } = subscription;
        let isPayable = false;
        switch (subscription.period) {
          case 'min': {
            const min = 1000 * 60;
            const recurTime = trxTimestamp > lastInstallmentTime && (trxTimestamp - lastInstallmentTime) >= min * recur;
            if (recurTime === true) {
              isPayable = true;
              await processInstallment(subscription, false);
            }
            break;
          }
          case 'hour': {
            const hour = 1000 * 60 * 60;
            const recurTime = trxTimestamp > lastInstallmentTime && (trxTimestamp - lastInstallmentTime) >= hour * recur;
            if (recurTime) {
              isPayable = true;
              await processInstallment(subscription, false);
            }
            break;
          }
          case 'day': {
            const day = 1000 * 60 * 60 * 24;
            const recurTime = trxTimestamp > lastInstallmentTime && (trxTimestamp - lastInstallmentTime) >= day * recur;
            if (recurTime) {
              isPayable = true;
              await processInstallment(subscription, false);
            }
            break;
          }
          case 'week': {
            const week = 1000 * 60 * 60 * 24 * 7;
            const recurTime = trxTimestamp > lastInstallmentTime && (trxTimestamp - lastInstallmentTime) >= week * recur;
            if (recurTime) {
              isPayable = true;
              await processInstallment(subscription, false);
            }
            break;
          }
          case 'month': {
            const month = 1000 * 60 * 60 * 24 * 30;
            const recurTime = trxTimestamp > lastInstallmentTime && (trxTimestamp - lastInstallmentTime) >= month * recur;
            if (recurTime) {
              isPayable = true;
              await processInstallment(subscription, false);
            }
            break;
          }
          default: {
            return false;
          }
        }
        if (api.assert(isPayable === true, 'this installment is not payable')) {
          /**
           * Check whether this is the last installment to pay,
           * if so, make the subscribtion inactive
           */

          if (installments.length + 1 === BigNumber(subscription.max).toNumber()) {
            subscription.active = false;
            await api.db.update('subscriptions', subscription);
          }

          return true;
        }
        return false;
      }
    }
  }
  return false;
};
