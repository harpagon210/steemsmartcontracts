const { Base64 } = require('js-base64');
const fs = require('fs-extra');
const { Transaction } = require('../libs/Transaction');
const BP_CONSTANTS = require('../libs/BlockProduction.contants').CONSTANTS;

class Bootstrap {
  static async getBootstrapTransactions(genesisSteemBlock) {
    const transactions = [];

    let contractCode;
    let base64ContractCode;
    let contractPayload;

    const FORK_BLOCK_NUMBER = 30896500;
    const FORK_BLOCK_NUMBER_TWO = 30983000;
    const FORK_BLOCK_NUMBER_THREE = 31992326;
    const ACCOUNT_RECEIVING_FEES = 'steemsc';
    const STEEM_PEGGED_ACCOUNT = 'steem-peg';
    const INITIAL_TOKEN_CREATION_FEE = '100';
    const SSC_STORE_PRICE = '0.001';
    const SSC_STORE_QTY = '0.001';

    // tokens contract
    contractCode = await fs.readFileSync('./contracts/tokens.js');
    contractCode = contractCode.toString();

    contractCode = contractCode.replace(/'\$\{BP_CONSTANTS.UTILITY_TOKEN_PRECISION\}\$'/g, BP_CONSTANTS.UTILITY_TOKEN_PRECISION);
    contractCode = contractCode.replace(/'\$\{BP_CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, BP_CONSTANTS.UTILITY_TOKEN_SYMBOL);
    contractCode = contractCode.replace(/'\$\{FORK_BLOCK_NUMBER\}\$'/g, FORK_BLOCK_NUMBER);

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: 'tokens',
      params: '',
      code: base64ContractCode,
    };

    transactions.push(new Transaction(genesisSteemBlock, 0, 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));

    // sscstore contract
    contractCode = await fs.readFileSync('./contracts/sscstore.js');
    contractCode = contractCode.toString();

    contractCode = contractCode.replace(/'\$\{BP_CONSTANTS.UTILITY_TOKEN_PRECISION\}\$'/g, BP_CONSTANTS.UTILITY_TOKEN_PRECISION);
    contractCode = contractCode.replace(/'\$\{BP_CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, BP_CONSTANTS.UTILITY_TOKEN_SYMBOL);
    contractCode = contractCode.replace(/'\$\{FORK_BLOCK_NUMBER\}\$'/g, FORK_BLOCK_NUMBER);
    contractCode = contractCode.replace(/'\$\{SSC_STORE_PRICE\}\$'/g, SSC_STORE_PRICE);
    contractCode = contractCode.replace(/'\$\{SSC_STORE_QTY\}\$'/g, SSC_STORE_QTY);

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: 'sscstore',
      params: '',
      code: base64ContractCode,
    };

    transactions.push(new Transaction(genesisSteemBlock, 0, 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));

    // steem-pegged asset contract
    contractCode = await fs.readFileSync('./contracts/steempegged.js');
    contractCode = contractCode.toString();

    contractCode = contractCode.replace(/'\$\{ACCOUNT_RECEIVING_FEES\}\$'/g, ACCOUNT_RECEIVING_FEES);

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: 'steempegged',
      params: '',
      code: base64ContractCode,
    };

    transactions.push(new Transaction(genesisSteemBlock, 0, STEEM_PEGGED_ACCOUNT, 'contract', 'deploy', JSON.stringify(contractPayload)));

    contractCode = await fs.readFileSync('./contracts/market.js');
    contractCode = contractCode.toString();

    contractCode = contractCode.replace(/'\$\{FORK_BLOCK_NUMBER_TWO\}\$'/g, FORK_BLOCK_NUMBER_TWO);
    contractCode = contractCode.replace(/'\$\{FORK_BLOCK_NUMBER_THREE\}\$'/g, FORK_BLOCK_NUMBER_THREE);

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: 'market',
      params: '',
      code: base64ContractCode,
    };

    transactions.push(new Transaction(genesisSteemBlock, 0, 'null', 'contract', 'deploy', JSON.stringify(contractPayload)));

    // dice contract
    /* contractCode = await fs.readFileSync('./contracts/dice.js');
    contractCode = contractCode.toString();

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: 'dice',
      params: '',
      code: base64ContractCode,
    };

    transactions.push(new Transaction(
      genesisSteemBlock, 0, 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));
    */


    // bootstrap transactions
    transactions.push(new Transaction(genesisSteemBlock, 0, 'null', 'tokens', 'create', `{ "name": "Steem Engine Token", "symbol": "ENG", "precision": 8, "maxSupply": ${Number.MAX_SAFE_INTEGER} }`));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'null', 'tokens', 'updateMetadata', '{"symbol":"ENG", "metadata": { "url":"https://steem-engine.com", "icon": "https://s3.amazonaws.com/steem-engine/images/icon_steem-engine_gradient.svg", "desc": "ENG is the native token for the Steem Engine platform" }}'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'null', 'tokens', 'issue', '{ "symbol": "ENG", "to": "steemsc", "quantity": 2000000, "isSignedWithActiveKey": true }'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'null', 'tokens', 'issue', '{ "symbol": "ENG", "to": "harpagon", "quantity": 1000000, "isSignedWithActiveKey": true }'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'null', 'tokens', 'issue', '{ "symbol": "ENG", "to": "steemmonsters", "quantity": 1000000, "isSignedWithActiveKey": true }'));
    transactions.push(new Transaction(genesisSteemBlock, 0, STEEM_PEGGED_ACCOUNT, 'tokens', 'create', '{ "name": "STEEM Pegged", "symbol": "STEEMP", "precision": 3, "maxSupply": 1000000000000 }'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'btcpeg', 'tokens', 'create', '{ "name": "BITCOIN Pegged", "symbol": "BTCP", "precision": 8, "maxSupply": 1000000000000 }'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'btcpeg', 'tokens', 'updateMetadata', '{"symbol":"BTCP", "metadata": { "desc": "BITCOIN backed by the steem-engine team" }}'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'ltcp', 'tokens', 'create', '{ "name": "LITECOIN Pegged", "symbol": "LTCP", "precision": 8, "maxSupply": 1000000000000 }'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'ltcp', 'tokens', 'updateMetadata', '{"symbol":"LTCP", "metadata": { "desc": "LITECOIN backed by the steem-engine team" }}'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'dogep', 'tokens', 'create', '{ "name": "DOGECOIN Pegged", "symbol": "DOGEP", "precision": 8, "maxSupply": 1000000000000 }'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'dogep', 'tokens', 'updateMetadata', '{"symbol":"DOGEP", "metadata": { "desc": "DOGECOIN backed by the steem-engine team" }}'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'bchp', 'tokens', 'create', '{ "name": "BITCOIN CASH Pegged", "symbol": "BCHP", "precision": 8, "maxSupply": 1000000000000 }'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'bchp', 'tokens', 'updateMetadata', '{"symbol":"BCHP", "metadata": { "desc": "BITCOIN CASH backed by the steem-engine team" }}'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'steemsc', 'tokens', 'updateParams', `{ "tokenCreationFee": "${INITIAL_TOKEN_CREATION_FEE}" }`));
    transactions.push(new Transaction(genesisSteemBlock, 0, STEEM_PEGGED_ACCOUNT, 'tokens', 'issue', `{ "symbol": "STEEMP", "to": "${STEEM_PEGGED_ACCOUNT}", "quantity": 1000000000000, "isSignedWithActiveKey": true }`));

    return transactions;
  }
}

module.exports.Bootstrap = Bootstrap;
