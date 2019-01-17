const jayson = require('jayson');
const http = require('http');
const cors = require('cors');
const express = require('express');
const bodyParser = require('body-parser');
const { IPC } = require('../libs/IPC');
const DB_PLUGIN_NAME = require('./Database.constants').PLUGIN_NAME;
const DB_PLUGIN_ACTION = require('./Database.constants').PLUGIN_ACTIONS;

const PLUGIN_NAME = 'JsonRPCServer';
const PLUGIN_PATH = require.resolve(__filename);

const ipc = new IPC(PLUGIN_NAME);
let serverRPC = null;

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

  http.createServer(serverRPC)
    .listen(rpcNodePort, () => {
      console.log(`RPC Node now listening on port ${rpcNodePort}`); // eslint-disable-line
    });
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
      console.log('successfully stopped'); // eslint-disable-line no-console
      ipc.reply(message);
      break;
    default:
      ipc.reply(message);
      break;
  }
});

module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLUGIN_PATH = PLUGIN_PATH;
