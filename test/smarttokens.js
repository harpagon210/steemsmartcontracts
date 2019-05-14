/* eslint-disable */
const { fork } = require('child_process');
const assert = require('assert');
const fs = require('fs-extra');
const BigNumber = require('bignumber.js');
const { Base64 } = require('js-base64');

const database = require('../plugins/Database');
const blockchain = require('../plugins/Blockchain');
const { Block } = require('../libs/Block');
const { Transaction } = require('../libs/Transaction');

require('dotenv').config();

const BP_CONSTANTS = require('../libs/BlockProduction.contants').CONSTANTS;

//process.env.NODE_ENV = 'test';

const conf = {
  chainId: "test-chain-id",
  genesisSteemBlock: 2000000,
  dataDirectory: "./test/data/",
  databaseFileName: "database.db",
  autosaveInterval: 0,
  javascriptVMTimeout: 10000,
};

let plugins = {};
let jobs = new Map();
let currentJobId = 0;

function cleanDataFolder() {
  fs.emptyDirSync(conf.dataDirectory);
}

function send(pluginName, from, message) {
  const plugin = plugins[pluginName];
  const newMessage = {
    ...message,
    to: plugin.name,
    from,
    type: 'request',
  };
  currentJobId += 1;
  newMessage.jobId = currentJobId;
  plugin.cp.send(newMessage);
  return new Promise((resolve) => {
    jobs.set(currentJobId, {
      message: newMessage,
      resolve,
    });
  });
}


// function to route the IPC requests
const route = (message) => {
  const { to, type, jobId } = message;
  if (to) {
    if (to === 'MASTER') {
      if (type && type === 'request') {
        // do something
      } else if (type && type === 'response' && jobId) {
        const job = jobs.get(jobId);
        if (job && job.resolve) {
          const { resolve } = job;
          jobs.delete(jobId);
          resolve(message);
        }
      }
    } else if (type && type === 'broadcast') {
      plugins.forEach((plugin) => {
        plugin.cp.send(message);
      });
    } else if (plugins[to]) {
      plugins[to].cp.send(message);
    } else {
      console.error('ROUTING ERROR: ', message);
    }
  }
};

const loadPlugin = (newPlugin) => {
  const plugin = {};
  plugin.name = newPlugin.PLUGIN_NAME;
  plugin.cp = fork(newPlugin.PLUGIN_PATH, [], { silent: true });
  plugin.cp.on('message', msg => route(msg));
  plugin.cp.stdout.on('data', data => console.log(`[${newPlugin.PLUGIN_NAME}]`, data.toString()));
  plugin.cp.stderr.on('data', data => console.error(`[${newPlugin.PLUGIN_NAME}]`, data.toString()));

  plugins[newPlugin.PLUGIN_NAME] = plugin;

  return send(newPlugin.PLUGIN_NAME, 'MASTER', { action: 'init', payload: conf });
};

const unloadPlugin = (plugin) => {
  plugins[plugin.PLUGIN_NAME].cp.kill('SIGINT');
  plugins[plugin.PLUGIN_NAME] = null;
  jobs = new Map();
  currentJobId = 0;
}


let contractCode = fs.readFileSync('./contracts/tokens.js');
contractCode = contractCode.toString();

contractCode = contractCode.replace(/'\$\{BP_CONSTANTS.UTILITY_TOKEN_PRECISION\}\$'/g, BP_CONSTANTS.UTILITY_TOKEN_PRECISION);
contractCode = contractCode.replace(/'\$\{BP_CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, BP_CONSTANTS.UTILITY_TOKEN_SYMBOL);

let base64ContractCode = Base64.encode(contractCode);

let contractPayload = {
  name: 'tokens',
  params: '',
  code: base64ContractCode,
};

contractCode = fs.readFileSync('./contracts/comments.js');
contractCode = contractCode.toString();
base64ContractCode = Base64.encode(contractCode);

let commentsContractPayload = {
  name: 'comments',
  params: '',
  code: base64ContractCode,
};

// smart tokens
describe('smart tokens', function () {
  this.timeout(30000);

  it('should enable voting', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const votingParams = {
        symbol: 'TKN',
        voteRegenerationPeriodSeconds: 60 * 60 * 24 * 5, // 5 days
        votesPerRegenerationPeriod: 50,
        cashoutWindowSeconds: 60 * 60 * 24 * 7, // 7 days
        reverseAuctionWindowSeconds: 60 * 60 * 12, // 12 hours
        voteDustThreshold: '0',
        contentConstant: '2000000000000',
        allowCurationRewards: true,
        percentCurationRewards: 25,
        percentContentRewards: '0',
        authorRewardCurve: 'linear',
        curationRewardCurve: 'squareRoot',
        isSignedWithActiveKey: true,
      };

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'deploy', JSON.stringify(commentsContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'harpagon', 'tokens', 'enableVoting', JSON.stringify(votingParams)));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      let token = res.payload;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'null');
      assert.equal(token.creator, 'harpagon');
      assert.equal(token.stakingEnabled, true);
      assert.equal(token.unstakingCooldown, 7);
      assert.equal(token.votingEnabled, true);
      assert.equal(token.voteRegenerationPeriodSeconds, votingParams.voteRegenerationPeriodSeconds);
      assert.equal(token.votesPerRegenerationPeriod, votingParams.votesPerRegenerationPeriod);
      assert.equal(token.cashoutWindowSeconds, votingParams.cashoutWindowSeconds);
      assert.equal(token.reverseAuctionWindowSeconds, votingParams.reverseAuctionWindowSeconds);
      assert.equal(token.voteDustThreshold, votingParams.voteDustThreshold);
      assert.equal(token.contentConstant, votingParams.contentConstant);
      assert.equal(token.allowCurationRewards, votingParams.allowCurationRewards);
      assert.equal(token.percentCurationRewards, votingParams.percentCurationRewards);
      assert.equal(token.percentContentRewards, votingParams.percentContentRewards);
      assert.equal(token.authorRewardCurve, votingParams.authorRewardCurve);
      assert.equal(token.curationRewardCurve, votingParams.curationRewardCurve);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should add a comment', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const votingParams = {
        symbol: 'TKN',
        voteRegenerationPeriodSeconds: 60 * 60 * 24 * 5, // 5 days
        votesPerRegenerationPeriod: 50,
        cashoutWindowSeconds: 60 * 60 * 24 * 7, // 7 days
        reverseAuctionWindowSeconds: 60 * 60 * 12, // 12 hours
        voteDustThreshold: '0',
        contentConstant: '2000000000000',
        allowCurationRewards: true,
        percentCurationRewards: 25,
        percentContentRewards: '0',
        authorRewardCurve: 'linear',
        curationRewardCurve: 'squareRoot',
        isSignedWithActiveKey: true,
      };

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'deploy', JSON.stringify(commentsContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'harpagon', 'tokens', 'enableVoting', JSON.stringify(votingParams)));

      transactions.push(new Transaction(12345678901, 'TXID1239', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "NKT", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID12310', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "NKT", "unstakingCooldown": 30, "numberTransactions": 4, "isSignedWithActiveKey": true }'));
      votingParams.symbol = 'NKT'
      votingParams.cashoutWindowSeconds = 60 * 60 * 24 * 3; // 3 days
      transactions.push(new Transaction(12345678901, 'TXID12311', 'harpagon', 'tokens', 'enableVoting', JSON.stringify(votingParams)));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1339', 'null', 'comments', 'comment', '{ "author": "satoshi", "permlink": "what-is-bitcoin", "votableAssets": ["TKN", "NKT"] }'));

      block = {
        refSteemBlockNumber: 12345678902,
        refSteemBlockId: 'ABCD2',
        prevRefSteemBlockId: 'ABCD3',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'comments',
          table: 'comments',
          query: {
            commentID: 'satoshi/what-is-bitcoin'
          }
        }
      });

      let comment = res.payload;

      assert.equal(comment.commentID, 'satoshi/what-is-bitcoin');
      assert.equal(comment.created, 1527811200);
      assert.equal(comment.votableAssets[0].symbol, 'TKN');
      assert.equal(comment.votableAssets[0].cashoutTime, 1528416000);
      assert.equal(comment.votableAssets[0].netRshares, '0');
      assert.equal(comment.votableAssets[0].absRshares, '0');
      assert.equal(comment.votableAssets[0].totalVoteWeight, '0');
      assert.equal(comment.votableAssets[0].rewardWeight, '0');
      assert.equal(comment.votableAssets[1].symbol, 'NKT');
      assert.equal(comment.votableAssets[1].cashoutTime, 1528070400);
      assert.equal(comment.votableAssets[1].netRshares, '0');
      assert.equal(comment.votableAssets[1].absRshares, '0');
      assert.equal(comment.votableAssets[1].totalVoteWeight, '0');
      assert.equal(comment.votableAssets[1].rewardWeight, '0');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not add a comment', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const votingParams = {
        symbol: 'TKN',
        voteRegenerationPeriodSeconds: 60 * 60 * 24 * 5, // 5 days
        votesPerRegenerationPeriod: 50,
        cashoutWindowSeconds: 60 * 60 * 24 * 7, // 7 days
        reverseAuctionWindowSeconds: 60 * 60 * 12, // 12 hours
        voteDustThreshold: '0',
        contentConstant: '2000000000000',
        allowCurationRewards: true,
        percentCurationRewards: 25,
        percentContentRewards: '0',
        authorRewardCurve: 'linear',
        curationRewardCurve: 'squareRoot',
        isSignedWithActiveKey: true,
      };

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'deploy', JSON.stringify(commentsContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "BTC", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "ETH", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'harpagon', 'tokens', 'enableVoting', JSON.stringify(votingParams)));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(12345678902, 'TXID1339', 'null', 'comments', 'comment', '{ "author": "satoshi", "permlink": "what-is-bitcoin" }'));
      transactions.push(new Transaction(12345678902, 'TXID1340', 'null', 'comments', 'comment', '{ "author": "satoshi", "permlink": "what-is-bitcoin", "votableAssets": ["TKN", "NKT", "NKT", "NKT", "NKT", "NKT"] }'));
      transactions.push(new Transaction(12345678902, 'TXID1341', 'null', 'comments', 'comment', '{ "author": "satoshi", "permlink": "what-is-bitcoin", "votableAssets": [123, "NKT"] }'));
      transactions.push(new Transaction(12345678902, 'TXID1342', 'null', 'comments', 'comment', '{ "author": "satoshi", "permlink": "what-is-bitcoin", "votableAssets": ["TKNAZEZAZEAE", "NKT"] }'));
      transactions.push(new Transaction(12345678902, 'TXID1343', 'null', 'comments', 'comment', '{ "author": "satoshi", "permlink": "what-is-bitcoin", "votableAssets": ["TKN", "NKT"] }'));
      transactions.push(new Transaction(12345678902, 'TXID1345', 'null', 'comments', 'comment', '{ "author": "satoshi", "permlink": "what-is-bitcoin", "votableAssets": ["BTC"] }'));
      transactions.push(new Transaction(12345678902, 'TXID1346', 'null', 'comments', 'comment', '{ "author": "satoshi", "permlink": "what-is-bitcoin", "votableAssets": ["BTC", "ETH"] }'));
      transactions.push(new Transaction(12345678902, 'TXID1347', 'null', 'comments', 'comment', '{ "author": "satoshi", "permlink": "what-is-bitcoin", "votableAssets": ["TKN"] }'));
      transactions.push(new Transaction(12345678902, 'TXID1348', 'null', 'comments', 'comment', '{ "author": "satoshi", "permlink": "what-is-bitcoin", "votableAssets": ["TKN"] }'));

      block = {
        refSteemBlockNumber: 12345678902,
        refSteemBlockId: 'ABCD2',
        prevRefSteemBlockId: 'ABCD3',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let txs = res.payload.transactions;
      assert.equal(JSON.parse(txs[0].logs).errors[0], 'votableAssets invalid');
      assert.equal(JSON.parse(txs[1].logs).errors[0], 'votableAssets invalid');
      assert.equal(JSON.parse(txs[2].logs).errors[0], 'votableAssets invalid');
      assert.equal(JSON.parse(txs[3].logs).errors[0], 'votableAssets invalid');
      assert.equal(JSON.parse(txs[4].logs).errors[0], 'invalid tokens');
      assert.equal(JSON.parse(txs[5].logs).errors[0], 'none of the tokens have staking enabled and voting enabled');
      assert.equal(JSON.parse(txs[6].logs).errors[0], 'none of the tokens have staking enabled and voting enabled');
      assert.equal(JSON.parse(txs[8].logs).errors[0], 'comment already exists');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not vote for a comment', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const votingParams = {
        symbol: 'TKN',
        voteRegenerationPeriodSeconds: 60 * 60 * 24 * 5, // 5 days
        votesPerRegenerationPeriod: 50,
        cashoutWindowSeconds: 60 * 60 * 24 * 7, // 7 days
        reverseAuctionWindowSeconds: 60 * 60 * 12, // 12 hours
        voteDustThreshold: '0',
        contentConstant: '2000000000000',
        allowCurationRewards: true,
        percentCurationRewards: 25,
        percentContentRewards: '0',
        authorRewardCurve: 'linear',
        curationRewardCurve: 'squareRoot',
        isSignedWithActiveKey: true,
      };

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'deploy', JSON.stringify(commentsContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "2000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "BTC", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "ETH", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1240', 'harpagon', 'tokens', 'enableVoting', JSON.stringify(votingParams)));
      transactions.push(new Transaction(12345678902, 'TXID1241', 'null', 'comments', 'comment', '{ "author": "satoshi", "permlink": "what-is-bitcoin", "votableAssets": ["TKN"] }'));
      transactions.push(new Transaction(12345678902, 'TXID1242', 'null', 'comments', 'comment', '{ "author": "satoshi", "permlink": "what-bitcoin-is-not", "votableAssets": ["TKN"] }'));
      transactions.push(new Transaction(12345678902, 'TXID1243', 'null', 'comments', 'commentOptions', '{ "author": "satoshi", "permlink": "what-bitcoin-is-not", "allowVotes": false }'));
      
      console.log('start generating comments')
      for (let index = 10; index < 303; index++) {
        transactions.push(new Transaction(12345678902, `TXID1644${index}`, 'null', 'comments', 'comment', `{ "author": "satoshi", "permlink": "what-is-bitcoin${index}", "votableAssets": ["TKN"] }`));
      }
      console.log('start generating comments')

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1440', 'null', 'comments', 'vote', '{ "voter": "dan", "author": "satoshi", "permlink": "what-is-eos", "weight": 10000 }'));
      transactions.push(new Transaction(12345678901, 'TXID1441', 'null', 'comments', 'vote', '{ "voter": "dan", "author": "satoshi", "permlink": "what-bitcoin-is-not", "weight": 10000 }'));
      transactions.push(new Transaction(12345678901, 'TXID1443', 'null', 'comments', 'vote', '{ "voter": "dan", "author": "satoshi", "permlink": "what-is-bitcoin", "weight": 10000 }'));
      transactions.push(new Transaction(12345678901, 'TXID1442', 'null', 'tokens', 'issue', `{ "symbol": "TKN", "to": "dan", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1444', 'dan', 'tokens', 'stake', `{ "symbol": "TKN", "quantity": "1000", "isSignedWithActiveKey": true }`));

      console.log('start generating votes');
      for (let index = 10; index < 303; index++) {
        transactions.push(new Transaction(12345678901, `TXID1444${index}`, 'null', 'comments', 'vote', `{ "voter": "dan", "author": "satoshi", "permlink": "what-is-bitcoin${index}", "weight": 10000 }`));
      }
      console.log('done generating votes');

      transactions.push(new Transaction(12345678901, 'TXID1501', 'null', 'tokens', 'issue', `{ "symbol": "TKN", "to": "ned", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1502', 'ned', 'tokens', 'stake', `{ "symbol": "TKN", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, `TXID1503`, 'null', 'comments', 'vote', `{ "voter": "ned", "author": "satoshi", "permlink": "what-is-bitcoin302", "weight": 0 }`));
      transactions.push(new Transaction(12345678901, `TXID1504`, 'null', 'comments', 'vote', `{ "voter": "ned", "author": "satoshi", "permlink": "what-is-bitcoin302", "weight": 10000 }`));
      transactions.push(new Transaction(12345678901, `TXID1505`, 'null', 'comments', 'vote', `{ "voter": "ned", "author": "satoshi", "permlink": "what-is-bitcoin302", "weight": 10000 }`));
      transactions.push(new Transaction(12345678901, `TXID1506`, 'null', 'comments', 'vote', `{ "voter": "ned", "author": "satoshi", "permlink": "what-is-bitcoin302", "weight": 1 }`));
      transactions.push(new Transaction(12345678901, `TXID1507`, 'null', 'comments', 'vote', `{ "voter": "ned", "author": "satoshi", "permlink": "what-is-bitcoin302", "weight": 2 }`));
      transactions.push(new Transaction(12345678901, `TXID1508`, 'null', 'comments', 'vote', `{ "voter": "ned", "author": "satoshi", "permlink": "what-is-bitcoin302", "weight": 3 }`));
      transactions.push(new Transaction(12345678901, `TXID1509`, 'null', 'comments', 'vote', `{ "voter": "ned", "author": "satoshi", "permlink": "what-is-bitcoin302", "weight": 4 }`));
      transactions.push(new Transaction(12345678901, `TXID1510`, 'null', 'comments', 'vote', `{ "voter": "ned", "author": "satoshi", "permlink": "what-is-bitcoin302", "weight": 5 }`));
      transactions.push(new Transaction(12345678901, `TXID1511`, 'null', 'comments', 'vote', `{ "voter": "ned", "author": "satoshi", "permlink": "what-is-bitcoin302", "weight": 6 }`));


      block = {
        refSteemBlockNumber: 12345678902,
        refSteemBlockId: 'ABCD2',
        prevRefSteemBlockId: 'ABCD3',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      console.log('start producing block');
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      console.log('done producing block');

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let txs = res.payload.transactions;

      assert.equal(JSON.parse(txs[0].logs).errors[0], 'comment does not exist');
      assert.equal(JSON.parse(txs[1].logs).errors[0], 'comment does not allow votes');
      assert.equal(JSON.parse(txs[2].logs).errors[0], 'no balance available');
      assert.equal(JSON.parse(txs[297].logs).errors[0], 'no voting power available for token TKN');
      assert.equal(JSON.parse(txs[300].logs).errors[0], 'weight cannot be 0');
      assert.equal(JSON.parse(txs[302].logs).errors[0], 'your current vote on this comment is identical to this vote');
      assert.equal(JSON.parse(txs[308].logs).errors[0], 'voter has used the maximum number of vote changes on this comment');


      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'dan'
          }
        }
      });

      let balance = res.payload;

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });


  it('should vote for a comment', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      const votingParams = {
        symbol: 'TKN',
        voteRegenerationPeriodSeconds: 60 * 60 * 24 * 5, // 5 days
        votesPerRegenerationPeriod: 50,
        cashoutWindowSeconds: 60 * 60 * 24 * 7, // 7 days
        reverseAuctionWindowSeconds: 60 * 60 * 12, // 12 hours
        voteDustThreshold: '0',
        contentConstant: '2000000000000',
        allowCurationRewards: true,
        percentCurationRewards: 25,
        percentContentRewards: '0',
        authorRewardCurve: 'linear',
        curationRewardCurve: 'squareRoot',
        isSignedWithActiveKey: true,
      };

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1232', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'deploy', JSON.stringify(commentsContractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "10000" }'));
      transactions.push(new Transaction(12345678901, 'TXID12312', 'harpagon', 'tokens', 'issue', `{ "symbol": "TKN", "to": "dan", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'harpagon', 'tokens', 'enableVoting', JSON.stringify(votingParams)));

      transactions.push(new Transaction(12345678901, 'TXID1239', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "NKT", "precision": 8, "maxSupply": "10000" }'));
      transactions.push(new Transaction(12345678901, 'TXID12310', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "NKT", "unstakingCooldown": 30, "numberTransactions": 4, "isSignedWithActiveKey": true }'));
      votingParams.symbol = 'NKT'
      votingParams.cashoutWindowSeconds = 60 * 60 * 24 * 3; // 3 days
      transactions.push(new Transaction(12345678901, 'TXID12311', 'harpagon', 'tokens', 'enableVoting', JSON.stringify(votingParams)));

      transactions.push(new Transaction(12345678901, 'TXID12313', 'dan', 'tokens', 'stake', `{ "symbol": "TKN", "quantity": "1000", "isSignedWithActiveKey": true }`));


      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1339', 'null', 'comments', 'comment', '{ "author": "satoshi", "permlink": "what-is-bitcoin", "votableAssets": ["TKN", "NKT"] }'));

      block = {
        refSteemBlockNumber: 12345678902,
        refSteemBlockId: 'ABCD2',
        prevRefSteemBlockId: 'ABCD3',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1340', 'null', 'comments', 'vote', '{ "voter": "dan", "author": "satoshi", "permlink": "what-is-bitcoin", "weight": 10000 }'));

      block = {
        refSteemBlockNumber: 12345678903,
        refSteemBlockId: 'ABCD2',
        prevRefSteemBlockId: 'ABCD3',
        timestamp: '2018-06-02T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'comments',
          table: 'comments',
          query: {
            commentID: 'satoshi/what-is-bitcoin'
          }
        }
      });

      let comment = res.payload;

      /*assert.equal(comment.commentID, 'satoshi/what-is-bitcoin');
      assert.equal(comment.created, 1527811200);
      assert.equal(comment.votableAssets[0].symbol, 'TKN');
      assert.equal(comment.votableAssets[0].cashoutTime, 1528416000);
      assert.equal(comment.votableAssets[0].netRshares, '0');
      assert.equal(comment.votableAssets[0].absRshares, '0');
      assert.equal(comment.votableAssets[0].totalVoteWeight, '0');
      assert.equal(comment.votableAssets[0].rewardWeight, '0');
      assert.equal(comment.votableAssets[1].symbol, 'NKT');
      assert.equal(comment.votableAssets[1].cashoutTime, 1528070400);
      assert.equal(comment.votableAssets[1].netRshares, '0');
      assert.equal(comment.votableAssets[1].absRshares, '0');
      assert.equal(comment.votableAssets[1].totalVoteWeight, '0');
      assert.equal(comment.votableAssets[1].rewardWeight, '0');*/

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'comments',
          table: 'commentVotes',
          query: {
            voter: 'dan',
            symbol: 'TKN',
            commentID: 'satoshi/what-is-bitcoin'
          }
        }
      });

      let commentVote = res.payload;

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should enable staking', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      let token = res.payload;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.stakingEnabled, true);
      assert.equal(token.unstakingCooldown, 7);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not enable staking', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "NKT", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 0, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 366, "numberTransactions": 1, "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      let token = res.payload;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.stakingEnabled, false);
      assert.equal(token.unstakingCooldown, 1);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let txs = res.payload.transactions;

      assert.equal(JSON.parse(txs[4].logs).errors[0], 'must be the issuer');
      assert.equal(JSON.parse(txs[5].logs).errors[0], 'unstakingCooldown must be an integer between 1 and 365');
      assert.equal(JSON.parse(txs[6].logs).errors[0], 'unstakingCooldown must be an integer between 1 and 365');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not enable staking again', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 10, "numberTransactions": 1, "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      let token = res.payload;

      assert.equal(token.symbol, 'TKN');
      assert.equal(token.issuer, 'harpagon');
      assert.equal(token.stakingEnabled, true);
      assert.equal(token.unstakingCooldown, 7);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_TRANSACTION_INFO,
        payload: 'TXID1238'
      });

      let tx = res.payload;

      assert.equal(JSON.parse(tx.logs).errors[0], 'staking already enabled');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should stake tokens', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:01',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999998');
      assert.equal(balance.stake, '0.00000002');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_TRANSACTION_INFO,
        payload:  'TXID1239'
      });

      const tx = res.payload;
      const logs = JSON.parse(tx.logs);
      const event = logs.events[0];

      assert.equal(event.contract, 'tokens');
      assert.equal(event.event, 'stake');
      assert.equal(event.data.account, 'satoshi');
      assert.equal(event.data.quantity, '0.00000001');
      assert.equal(event.data.symbol, 'TKN');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      const token = res.payload;

      assert.equal(token.totalStaked, '0.00000002');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not stake tokens', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "-1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12310', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "100.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID12311', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.000000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "100");
      assert.equal(balance.stake, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let txs = res.payload.transactions;

      assert.equal(JSON.parse(txs[4].logs).errors[0], 'staking not enabled');
      assert.equal(JSON.parse(txs[6].logs).errors[0], 'must stake positive quantity');
      assert.equal(JSON.parse(txs[7].logs).errors[0], 'overdrawn balance');
      assert.equal(JSON.parse(txs[8].logs).errors[0], 'symbol precision mismatch');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should start the unstake process', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      assert.equal(unstake.quantityLeft, '0.00000001');
      assert.equal(unstake.numberTransactionsLeft, 1);
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(unstake.txID, 'TXID1239');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not start the unstake process', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "-1", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1240', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1241', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.000000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "100");
      assert.equal(balance.stake, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let txs = res.payload.transactions;

      assert.equal(JSON.parse(txs[4].logs).errors[0], 'staking not enabled');
      assert.equal(JSON.parse(txs[6].logs).errors[0], 'must unstake positive quantity');
      assert.equal(JSON.parse(txs[7].logs).errors[0], 'overdrawn stake');
      assert.equal(JSON.parse(txs[8].logs).errors[0], 'symbol precision mismatch');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should cancel an unstake', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID123910', 'satoshi', 'tokens', 'cancelUnstake', '{ "txID": "TXID1239", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:03:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, '0.00000001');
      assert.equal(balance.pendingUnstake, '0.00000000');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake, null);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should not cancel an unstake', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      let blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID123910', 'satoshi', 'tokens', 'cancelUnstake', '{ "txID": "TXID12378", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID123911', 'harpagon', 'tokens', 'cancelUnstake', '{ "txID": "TXID1239", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:03:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, '0.00000000');
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(unstake.txID, 'TXID1239');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should process the pending unstakes', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      let token = res.payload;

      assert.equal(token.totalStaked, '0.00000001');

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123810', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-07T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '100.00000000');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake, null);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let vtxs = res.payload.virtualTransactions;
      const logs = JSON.parse(vtxs[0].logs);
      const event = logs.events[0];

      assert.equal(event.contract, 'tokens');
      assert.equal(event.event, 'unstake');
      assert.equal(event.data.account, 'satoshi');
      assert.equal(event.data.quantity, '0.00000001');
      assert.equal(event.data.symbol, 'TKN');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'tokens',
          query: {
            symbol: 'TKN'
          }
        }
      });

      token = res.payload;

      assert.equal(token.totalStaked, 0);

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it.skip('should process thousands of pending unstakes', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 7, "numberTransactions": 1, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999999");
      assert.equal(balance.stake, "0.00000001");

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-30T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999999');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, '0.00000001');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000001');
      const blockDate = new Date('2018-06-30T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 7));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123810', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-07T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '100.00000000');
      assert.equal(balance.stake, 0);
      assert.equal(balance.pendingUnstake, 0);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake, null);

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
        payload: {}
      });

      let vtxs = res.payload.virtualTransactions;
      const logs = JSON.parse(vtxs[0].logs);
      const event = logs.events[0];

      assert.equal(event.contract, 'tokens');
      assert.equal(event.event, 'unstake');
      assert.equal(event.data.account, 'satoshi');
      assert.equal(event.data.quantity, '0.00000001');
      assert.equal(event.data.symbol, 'TKN');

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID223811', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "1", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-14T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      // generate thousands of unstakes
      console.log('start generating pending unstakes');
      for (let index = 10000; index < 12000; index++) {
        transactions = [];
        transactions.push(new Transaction(12345678901, `TXID${index}`, 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));

        block = {
          refSteemBlockNumber: 12345678901,
          refSteemBlockId: 'ABCD1',
          prevRefSteemBlockId: 'ABCD2',
          timestamp: '2018-07-14T00:02:00',
          transactions,
        };

        await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      }

      transactions = [];
      transactions.push(new Transaction(12345678901, `TXID2000`, 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000001", "isSignedWithActiveKey": true }'));
      console.log('done generating pending unstakes');

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-14T00:02:01',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.00000000');
      assert.equal(balance.stake, '0.99997999');
      assert.equal(balance.pendingUnstake, '0.00002001');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123899', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-21T00:02:00',
        transactions,
      };

      console.log('start processing pending unstakes');
      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });
      console.log('done processing pending unstakes')
      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.00002000');
      assert.equal(balance.stake, '0.99997999');
      assert.equal(balance.pendingUnstake, '0.00000001');

      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

  it('should process the pending unstakes (with multi transactions)', (done) => {
    new Promise(async (resolve) => {
      cleanDataFolder();

      await loadPlugin(database);
      await loadPlugin(blockchain);

      await send(database.PLUGIN_NAME, 'MASTER', { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });

      let transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1233', 'steemsc', 'contract', 'update', JSON.stringify(contractPayload)));
      transactions.push(new Transaction(12345678901, 'TXID1234', 'steemsc', 'tokens', 'transfer', `{ "symbol": "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "harpagon", "quantity": "1000", "isSignedWithActiveKey": true }`));
      transactions.push(new Transaction(12345678901, 'TXID1235', 'harpagon', 'tokens', 'create', '{ "name": "token", "symbol": "TKN", "precision": 8, "maxSupply": "1000" }'));
      transactions.push(new Transaction(12345678901, 'TXID1237', 'harpagon', 'tokens', 'enableStaking', '{ "symbol": "TKN", "unstakingCooldown": 3, "numberTransactions": 3, "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1236', 'harpagon', 'tokens', 'issue', '{ "symbol": "TKN", "quantity": "100", "to": "satoshi", "isSignedWithActiveKey": true }'));
      transactions.push(new Transaction(12345678901, 'TXID1238', 'satoshi', 'tokens', 'stake', '{ "symbol": "TKN", "quantity": "0.00000008", "isSignedWithActiveKey": true }'));

      let block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-06-01T00:00:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      let res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, "99.99999992");
      assert.equal(balance.stake, "0.00000008");

      transactions = [];
      transactions.push(new Transaction(12345678901, 'TXID1239', 'satoshi', 'tokens', 'unstake', '{ "symbol": "TKN", "quantity": "0.00000006", "isSignedWithActiveKey": true }'));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-01T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999992');
      assert.equal(balance.stake, '0.00000002');
      assert.equal(balance.pendingUnstake, '0.00000006');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      let unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000006');
      assert.equal(unstake.quantityLeft, '0.00000006');
      assert.equal(unstake.numberTransactionsLeft, 3);
      let blockDate = new Date('2018-07-01T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 1));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123810', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-02T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999994');
      assert.equal(balance.stake, '0.00000002');
      assert.equal(balance.pendingUnstake, '0.00000004');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000006');
      assert.equal(unstake.quantityLeft, '0.00000004');
      assert.equal(unstake.numberTransactionsLeft, 2);
      blockDate = new Date('2018-07-02T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 1));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123811', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-03T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999996');
      assert.equal(balance.stake, '0.00000002');
      assert.equal(balance.pendingUnstake, '0.00000002');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake.symbol, 'TKN');
      assert.equal(unstake.account, 'satoshi');
      assert.equal(unstake.quantity, '0.00000006');
      assert.equal(unstake.quantityLeft, '0.00000002');
      assert.equal(unstake.numberTransactionsLeft, 1);
      blockDate = new Date('2018-07-03T00:02:00.000Z')
      assert.equal(unstake.nextTransactionTimestamp, blockDate.setDate(blockDate.getDate() + 1));
      assert.equal(unstake.txID, 'TXID1239');

      transactions = [];
      // send whatever transaction
      transactions.push(new Transaction(12345678901, 'TXID123812', 'satoshi', 'whatever', 'whatever', ''));

      block = {
        refSteemBlockNumber: 12345678901,
        refSteemBlockId: 'ABCD1',
        prevRefSteemBlockId: 'ABCD2',
        timestamp: '2018-07-04T00:02:00',
        transactions,
      };

      await send(blockchain.PLUGIN_NAME, 'MASTER', { action: blockchain.PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC, payload: block });

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'balances',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      balance = res.payload;

      assert.equal(balance.symbol, 'TKN');
      assert.equal(balance.account, 'satoshi');
      assert.equal(balance.balance, '99.99999998');
      assert.equal(balance.stake, '0.00000002');
      assert.equal(balance.pendingUnstake, '0.00000000');

      res = await send(database.PLUGIN_NAME, 'MASTER', {
        action: database.PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'tokens',
          table: 'pendingUnstakes',
          query: {
            account: 'satoshi',
            symbol: 'TKN'
          }
        }
      });

      unstake = res.payload;

      assert.equal(unstake, null);



      resolve();
    })
      .then(() => {
        unloadPlugin(blockchain);
        unloadPlugin(database);
        done();
      });
  });

});
