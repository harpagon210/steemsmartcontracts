// test contract to demonstrate Splinterlands style
// pack issuance of collectable critters
const CONTRACT_NAME = 'crittermanager';

// normally we would use api.owner to refer to the contract
// owner (the account that deployed the contract), but for now
// contract deployment is restricted, so we need another way
// to recognize the Critter app owner
const CRITTER_CREATOR = 'cryptomancer';

// this placeholder represents ENG tokens on the mainnet and SSC on the testnet
// eslint-disable-next-line no-template-curly-in-string
const UTILITY_TOKEN_SYMBOL = "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'";

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
      BETA: 3
    };
    await api.db.insert('params', params);
  }
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
// must have enough ENG/SSC to pay the creation fees. For simplicity
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
      authorizedIssuingContracts: [ CONTRACT_NAME ],
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
      authorizedEditingContracts: [ CONTRACT_NAME ],
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
      authorizedEditingContracts: [ CONTRACT_NAME ],
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
      authorizedEditingContracts: [ CONTRACT_NAME ],
      isSignedWithActiveKey,
    });

    // Do we have a super rare gold foil?
    await api.executeSmartContract('nft', 'addProperty', {
      symbol: 'CRITTER',
      name: 'isGoldFoil',
      type: 'boolean',
      isReadOnly: true,
      authorizedEditingAccounts: [],
      authorizedEditingContracts: [ CONTRACT_NAME ],
      isSignedWithActiveKey,
    });

    // We will allow people to customize their critters
    // by naming them (note this is NOT read only!)
    await api.executeSmartContract('nft', 'addProperty', {
      symbol: 'CRITTER',
      name: 'name',
      type: 'string',
      authorizedEditingAccounts: [],
      authorizedEditingContracts: [ CONTRACT_NAME ],
      isSignedWithActiveKey,
    });

    // add some other miscellaneous properties for the sake of
    // completeness
    await api.executeSmartContract('nft', 'addProperty', {
      symbol: 'CRITTER',
      name: 'xp', // experience points
      type: 'number',
      authorizedEditingAccounts: [],
      authorizedEditingContracts: [ CONTRACT_NAME ],
      isSignedWithActiveKey,
    });
    await api.executeSmartContract('nft', 'addProperty', {
      symbol: 'CRITTER',
      name: 'hp', // health points
      type: 'number',
      authorizedEditingAccounts: [],
      authorizedEditingContracts: [ CONTRACT_NAME ],
      isSignedWithActiveKey,
    });
  }
};

actions.updateName = async (payload) => {
  const { name, symbol } = payload;

  if (api.assert(symbol && typeof symbol === 'string'
    && name && typeof name === 'string', 'invalid params')
    && api.assert(api.validator.isAlphanumeric(api.validator.blacklist(name, ' ')) && name.length > 0 && name.length <= 50, 'invalid name: letters, numbers, whitespaces only, max length of 50')) {
    // check if the NFT exists
    const nft = await api.db.findOne('nfts', { symbol });

    if (nft) {
      if (api.assert(nft.issuer === api.sender, 'must be the issuer')) {
        nft.name = name;
        await api.db.update('nfts', nft);
      }
    }
  }
};

actions.hatch = async (payload) => {

};
