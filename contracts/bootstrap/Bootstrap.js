const { Base64 } = require('js-base64');
const fs = require('fs-extra');
const { Transaction } = require('../../libs/Transaction');
const BP_CONSTANTS = require('../../libs/BlockProduction.contants').CONSTANTS;

class Bootstrap {
  static async getBootstrapTransactions(genesisSteemBlock) {
    const transactions = [];

    let contractCode;
    let base64ContractCode;
    let contractPayload;

    const FORK_BLOCK_NUMBER = 33255083;
    const SSC_STORE_PRICE = '0.001';
    const SSC_STORE_QTY = '0.001';

    // tokens contract
    contractCode = await fs.readFileSync('./contracts/bootstrap/tokens.js');
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

    transactions.push(new Transaction(genesisSteemBlock, 0, 'rocketx', 'contract', 'deploy', JSON.stringify(contractPayload)));

    // sscstore contract
    contractCode = await fs.readFileSync('./contracts/bootstrap/sscstore.js');
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

    transactions.push(new Transaction(genesisSteemBlock, 0, 'rocketx', 'contract', 'deploy', JSON.stringify(contractPayload)));


    // bootstrap transactions
    transactions.push(new Transaction(genesisSteemBlock, 0, 'null', 'tokens', 'create', `{ "name": "RocketX", "symbol": "ROX", "precision": 8, "maxSupply": ${Number.MAX_SAFE_INTEGER} }`));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'null', 'tokens', 'updateMetadata', '{"symbol":"ROX", "metadata": { "url":"https://freedomex.io", "icon": "https://steemitimages.com/p/2r8F9rTBenJQfQgENfxADE6EVYabczqmSF5KeWefV5WL9WEVrMmPXB4iSZohFEWpEyn59TtaBZ7DfzERwCqS77VC4s38kVvb2PsBg57eAb7PriX4wMGh6KFVw1c9rvVV8", "desc": "ROX is the native token for the RocketX platform" }}'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'null', 'tokens', 'issue', '{ "symbol": "ROX", "to": "rocketx", "quantity": 1000000000, "isSignedWithActiveKey": true }'));

    return transactions;
  }
}

module.exports.Bootstrap = Bootstrap;
