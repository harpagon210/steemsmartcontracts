const jayson = require('jayson');
const http = require('http');
const cors = require('cors');
const express = require('express');
const bodyParser = require('body-parser');
const { IPC } = require('../libs/IPC');
const DB_PLUGIN_NAME = require('./Database.constants').PLUGIN_NAME;
const DB_PLUGIN_ACTION = require('./Database.constants').PLUGIN_ACTIONS;
const STREAMER_PLUGIN_NAME = require('./Streamer.constants').PLUGIN_NAME;
const STREAMER_PLUGIN_ACTION = require('./Streamer.constants').PLUGIN_ACTIONS;
const packagejson = require('../package.json');

const PLUGIN_NAME = 'JsonRPCServer';
const PLUGIN_PATH = require.resolve(__filename);

const ipc = new IPC(PLUGIN_NAME);
let serverRPC = null;
let server = null;

function blockchainRPC() {
  return {
    getLatestBlockInfo: async (args, callback) => {
      try {
        const res = await ipc.send(
          { to: DB_PLUGIN_NAME, action: DB_PLUGIN_ACTION.GET_LATEST_BLOCK_INFO },
        );
        callback(null, res.payload);
      } catch (error) {
        callback(error, null);
      }
    },
    getBlockInfo: async (args, callback) => {
      const { blockNumber } = args;

      if (Number.isInteger(blockNumber)) {
        const res = await ipc.send(
          { to: DB_PLUGIN_NAME, action: DB_PLUGIN_ACTION.GET_BLOCK_INFO, payload: blockNumber },
        );
        callback(null, res.payload);
      } else {
        callback({
          code: 400,
          message: 'missing or wrong parameters: blockNumber is required',
        }, null);
      }
    },
    getTransactionInfo: async (args, callback) => {
      const { txid } = args;

      if (txid && typeof txid === 'string') {
        const res = await ipc.send(
          { to: DB_PLUGIN_NAME, action: DB_PLUGIN_ACTION.GET_TRANSACTION_INFO, payload: txid },
        );
        callback(null, res.payload);
      } else {
        callback({
          code: 400,
          message: 'missing or wrong parameters: txid is required',
        }, null);
      }
    },
    getStatus: async (args, callback) => {
      try {
        const result = {};
        // retrieve the last block of the sidechain
        let res = await ipc.send(
          { to: DB_PLUGIN_NAME, action: DB_PLUGIN_ACTION.GET_LATEST_BLOCK_METADATA },
        );
        if (res && res.payload) {
          result.lastBlockNumber = res.payload.blockNumber;
          result.lastBlockRefSteemBlockNumber = res.payload.refSteemBlockNumber;
        }

        // get the Steem block number that the streamer is currently parsing
        res = await ipc.send(
          { to: STREAMER_PLUGIN_NAME, action: STREAMER_PLUGIN_ACTION.GET_CURRENT_BLOCK },
        );

        if (res && res.payload) {
          result.lastParsedSteemBlockNumber = res.payload;
        }

        // get the version of the SSC node
        result.SSCnodeVersion = packagejson.version;

        callback(null, result);
      } catch (error) {
        callback(error, null);
      }
    },
  };
}

function contractsRPC() {
  return {
    getContract: async (args, callback) => {
      const { name } = args;

      if (name && typeof name === 'string') {
        const res = await ipc.send(
          { to: DB_PLUGIN_NAME, action: DB_PLUGIN_ACTION.FIND_CONTRACT, payload: { name } },
        );
        callback(null, res.payload);
      } else {
        callback({
          code: 400,
          message: 'missing or wrong parameters: contract is required',
        }, null);
      }
    },

    findOne: async (args, callback) => {
      const { contract, table, query } = args;

      if (contract && typeof contract === 'string'
        && table && typeof table === 'string'
        && query && typeof query === 'object') {
        const res = await ipc.send(
          {
            to: DB_PLUGIN_NAME,
            action: DB_PLUGIN_ACTION.FIND_ONE,
            payload: {
              contract,
              table,
              query,
            },
          },
        );
        callback(null, res.payload);
      } else {
        callback({
          code: 400,
          message: 'missing or wrong parameters: contract and tableName are required',
        }, null);
      }
    },

    find: async (args, callback) => {
      const {
        contract,
        table,
        query,
        limit,
        offset,
        indexes,
      } = args;

      if (contract && typeof contract === 'string'
        && table && typeof table === 'string'
        && query && typeof query === 'object') {
        const lim = limit || 1000;
        const off = offset || 0;
        const ind = indexes || [];
        const res = await ipc.send(
          {
            to: DB_PLUGIN_NAME,
            action: DB_PLUGIN_ACTION.FIND,
            payload: {
              contract,
              table,
              query,
              limit: lim,
              offset: off,
              indexes: ind,
            },
          },
        );
        callback(null, res.payload);
      } else {
        callback({
          code: 400,
          message: 'missing or wrong parameters: contract and tableName are required',
        }, null);
      }
    },
  };
}

function init(conf) {
  const {
    rpcNodePort,
  } = conf;

  serverRPC = express();
  serverRPC.use(cors({ methods: ['POST'] }));
  serverRPC.use(bodyParser.urlencoded({ extended: true }));
  serverRPC.use(bodyParser.json());
  serverRPC.set('trust proxy', true);
  serverRPC.set('trust proxy', 'loopback');
  serverRPC.post('/blockchain', jayson.server(blockchainRPC()).middleware());
  serverRPC.post('/contracts', jayson.server(contractsRPC()).middleware());

  server = http.createServer(serverRPC)
    .listen(rpcNodePort, () => {
      console.log(`RPC Node now listening on port ${rpcNodePort}`); // eslint-disable-line
    });
}

function stop() {
  server.close();
}

ipc.onReceiveMessage((message) => {
  const {
    action,
    payload,
  } = message;

  switch (action) {
    case 'init':
      init(payload);
      ipc.reply(message);
      break;
    case 'stop':
      ipc.reply(message, stop());
      console.log('successfully stopped'); // eslint-disable-line no-console
      break;
    default:
      ipc.reply(message);
      break;
  }
});

module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLUGIN_PATH = PLUGIN_PATH;
