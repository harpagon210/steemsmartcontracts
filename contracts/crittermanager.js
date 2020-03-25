/* eslint-disable no-await-in-loop */
/* eslint-disable max-len */
/* global actions, api */

// test contract to demonstrate Splinterlands style
// pack issuance of collectable critters
const CONTRACT_NAME = 'crittermanager';

// normally we would use api.owner to refer to the contract
// owner (the account that deployed the contract), but for now
// contract deployment is restricted, so we need another way
// to recognize the Critter app owner
const CRITTER_CREATOR = 'cryptomancer';

// this placeholder represents BEE tokens on the mainnet and SSC on the testnet
// eslint-disable-next-line no-template-curly-in-string
const UTILITY_TOKEN_SYMBOL = "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'";

// we will issue critters in "packs" of 5 at a time
const CRITTERS_PER_PACK = 5;

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('params');
  if (tableExists === false) {
    await api.db.createTable('params');

    // This table will store contract configuration settings.
    // For this test, we have 3 CRITTER editions that you can buy
    // with different tokens. The contract owner can add more
    // editions via the updateParams action.
    const params = {};
    params.editionMapping = {
      // eslint-disable-next-line no-template-curly-in-string
      "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'": 1,
      ALPHA: 2,
      BETA: 3,
    };
    await api.db.insert('params', params);
  }
};

// helper function to check that token transfers succeeded
const isTokenTransferVerified = (result, from, to, symbol, quantity, eventStr) => {
  if (result.errors === undefined
    && result.events && result.events.find(el => el.contract === 'tokens' && el.event === eventStr
    && el.data.from === from && el.data.to === to && el.data.quantity === quantity && el.data.symbol === symbol) !== undefined) {
    return true;
  }
  return false;
};

// The contract owner can use this action to update settings
// without having to change & redeploy the contract source code.
actions.updateParams = async (payload) => {
  if (api.sender !== CRITTER_CREATOR) return;

  const {
    editionMapping,
  } = payload;

  const params = await api.db.findOne('params', {});

  if (editionMapping && typeof editionMapping === 'object') {
    params.editionMapping = editionMapping;
  }

  await api.db.update('params', params);
};

// The contract owner can call this action one time only, to
// create the CRITTER NFT definition. Normally you would probably
// do this through the Steem Engine web site, but we include it
// here to illustrate programmatic NFT creation, and to make it
// clear what data properties we need. Note: the contract owner
// must have enough BEE/SSC to pay the creation fees. For simplicity
// we don't do checks on the owner's balance here, but in a
// production ready smart contract we definitely should do so
// before taking any action that spends tokens as a side effect.
actions.createNft = async (payload) => {
  if (api.sender !== CRITTER_CREATOR) return;

  // this action requires active key authorization
  const {
    isSignedWithActiveKey,
  } = payload;

  // verify CRITTER does not exist yet
  const nft = await api.db.findOneInTable('nft', 'nfts', { symbol: 'CRITTER' });
  if (api.assert(nft === null, 'CRITTER already exists')
    && api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) {
    // create CRITTER
    // Note 1: we don't specify maxSupply, which means the supply of CRITTER
    // will be unlimited. But indirectly the supply is limited by the
    // supply of the tokens you can use to buy CRITTERS.
    // Note 2: we want this contract to be the only authorized token issuer
    await api.executeSmartContract('nft', 'create', {
      name: 'Mischievous Crypto Critters',
      symbol: 'CRITTER',
      authorizedIssuingAccounts: [],
      authorizedIssuingContracts: [CONTRACT_NAME],
      isSignedWithActiveKey,
    });

    // Now add some data properties (note that only this contract is
    // authorized to edit data properties). We could have chosen a more
    // economical design by formatting these in some custom way to fit
    // within a single string data property, which would cut down on
    // token issuance fees. The drawback is then we lose the ability to
    // easily query tokens by properties (for example, get a list of all
    // rare critters or all critters belonging to a certain edition, etc).

    // Edition only gets set once at issuance and never changes, so we
    // can make it read only.
    await api.executeSmartContract('nft', 'addProperty', {
      symbol: 'CRITTER',
      name: 'edition',
      type: 'number',
      isReadOnly: true,
      authorizedEditingAccounts: [],
      authorizedEditingContracts: [CONTRACT_NAME],
      isSignedWithActiveKey,
    });

    // Type (which also never changes once set) represents the kind of
    // critter within an edition. The interpretation of this value is
    // handled by whatever app uses these tokens; for example maybe
    // 0 = dragon, 1 = troll, 2 = goblin, etc
    await api.executeSmartContract('nft', 'addProperty', {
      symbol: 'CRITTER',
      name: 'type',
      type: 'number',
      isReadOnly: true,
      authorizedEditingAccounts: [],
      authorizedEditingContracts: [CONTRACT_NAME],
      isSignedWithActiveKey,
    });

    // How rare is this critter? 0 = common, 1 = uncommon,
    // 2 = rare, 3 = legendary
    await api.executeSmartContract('nft', 'addProperty', {
      symbol: 'CRITTER',
      name: 'rarity',
      type: 'number',
      isReadOnly: true,
      authorizedEditingAccounts: [],
      authorizedEditingContracts: [CONTRACT_NAME],
      isSignedWithActiveKey,
    });

    // Do we have a super rare gold foil?
    await api.executeSmartContract('nft', 'addProperty', {
      symbol: 'CRITTER',
      name: 'isGoldFoil',
      type: 'boolean',
      isReadOnly: true,
      authorizedEditingAccounts: [],
      authorizedEditingContracts: [CONTRACT_NAME],
      isSignedWithActiveKey,
    });

    // We will allow people to customize their critters
    // by naming them (note this is NOT read only!)
    await api.executeSmartContract('nft', 'addProperty', {
      symbol: 'CRITTER',
      name: 'name',
      type: 'string',
      authorizedEditingAccounts: [],
      authorizedEditingContracts: [CONTRACT_NAME],
      isSignedWithActiveKey,
    });

    // add some other miscellaneous properties for the sake of
    // completeness
    await api.executeSmartContract('nft', 'addProperty', {
      symbol: 'CRITTER',
      name: 'xp', // experience points
      type: 'number',
      authorizedEditingAccounts: [],
      authorizedEditingContracts: [CONTRACT_NAME],
      isSignedWithActiveKey,
    });
    await api.executeSmartContract('nft', 'addProperty', {
      symbol: 'CRITTER',
      name: 'hp', // health points
      type: 'number',
      authorizedEditingAccounts: [],
      authorizedEditingContracts: [CONTRACT_NAME],
      isSignedWithActiveKey,
    });
  }
};

// This action can be called by a token holder to change
// their critter's name.
actions.updateName = async (payload) => {
  const { id, name } = payload;

  if (api.assert(id && typeof id === 'string'
    && !api.BigNumber(id).isNaN() && api.BigNumber(id).gt(0)
    && name && typeof name === 'string', 'invalid params')
    && api.assert(api.validator.isAlphanumeric(api.validator.blacklist(name, ' ')) && name.length > 0 && name.length <= 25, 'invalid name: letters, numbers, whitespaces only, max length of 25')) {
    // fetch the token we want to edit
    const instance = await api.db.findOneInTable('nft', 'CRITTERinstances', { _id: api.BigNumber(id).toNumber() });

    if (instance) {
      // make sure this token is owned by the caller
      if (api.assert(instance.account === api.sender && instance.ownedBy === 'u', 'must be the token holder')) {
        await api.executeSmartContract('nft', 'setProperties', {
          symbol: 'CRITTER',
          fromType: 'contract',
          nfts: [{
            id, properties: { name },
          }],
        });
      }
    }
  }
};

// generate issuance data for a random critter of the given edition
const generateRandomCritter = (edition, to) => {
  // each rarity has 10 types of critters
  const type = Math.floor(api.random() * 10) + 1;

  // determine rarity
  let rarity = 0;
  let rarityRoll = Math.floor(api.random() * 1000) + 1;
  if (rarityRoll > 995) { // 0.5% chance of legendary
    rarity = 3;
  } else if (rarityRoll > 900) { // 10% chance of rare or higher
    rarity = 2;
  } else if (rarityRoll > 700) { // 30% of uncommon or higher
    rarity = 1;
  }

  // determine gold foil
  let isGoldFoil = false;
  rarityRoll = Math.floor(api.random() * 100) + 1;
  if (rarityRoll > 95) { // 5% chance of being gold
    isGoldFoil = true;
  }

  const properties = {
    edition,
    type,
    rarity,
    isGoldFoil,
    name: '',
    xp: 0,
    hp: 100,
  };

  const instance = {
    symbol: 'CRITTER',
    fromType: 'contract',
    to,
    feeSymbol: UTILITY_TOKEN_SYMBOL,
    properties,
  };

  return instance;
};

// issue some random critters!
actions.hatch = async (payload) => {
  // this action requires active key authorization
  const {
    packSymbol, // the token we want to buy with determines which edition to issue
    packs, // how many critters to hatch (1 pack = 5 critters)
    isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { editionMapping } = params;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(packSymbol && typeof packSymbol === 'string' && packSymbol in editionMapping, 'invalid pack symbol')
    && api.assert(packs && typeof packs === 'number' && packs >= 1 && packs <= 10 && Number.isInteger(packs), 'packs must be an integer between 1 and 10')) {
    // verify user has enough balance to pay for all the packs
    const paymentTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: packSymbol });
    const authorized = paymentTokenBalance && api.BigNumber(paymentTokenBalance.balance).gte(packs);
    if (api.assert(authorized, 'you must have enough pack tokens')) {
      // verify this contract has enough balance to pay the NFT issuance fees
      const crittersToHatch = packs * CRITTERS_PER_PACK;
      const nftParams = await api.db.findOneInTable('nft', 'params', {});
      const { nftIssuanceFee } = nftParams;
      const oneTokenIssuanceFee = api.BigNumber(nftIssuanceFee[UTILITY_TOKEN_SYMBOL]).multipliedBy(8); // base fee + 7 data properties
      const totalIssuanceFee = oneTokenIssuanceFee.multipliedBy(crittersToHatch);
      const utilityTokenBalance = await api.db.findOneInTable('tokens', 'contractsBalances', { account: CONTRACT_NAME, symbol: UTILITY_TOKEN_SYMBOL });
      const canAffordIssuance = utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(totalIssuanceFee);
      if (api.assert(canAffordIssuance, 'contract cannot afford issuance')) {
        // burn the pack tokens
        const res = await api.executeSmartContract('tokens', 'transfer', {
          to: 'null', symbol: packSymbol, quantity: packs.toString(), isSignedWithActiveKey,
        });
        if (!api.assert(isTokenTransferVerified(res, api.sender, 'null', packSymbol, packs.toString(), 'transfer'), 'unable to transfer pack tokens')) {
          return false;
        }

        // we will issue critters in packs of 5 at once
        for (let i = 0; i < packs; i += 1) {
          const instances = [];
          for (let j = 0; j < CRITTERS_PER_PACK; j += 1) {
            instances.push(generateRandomCritter(editionMapping[packSymbol], api.sender));
          }

          await api.executeSmartContract('nft', 'issueMultiple', {
            instances,
            isSignedWithActiveKey,
          });
        }
        return true;
      }
    }
  }
  return false;
};
