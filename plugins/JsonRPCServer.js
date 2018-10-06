const jayson = require('jayson');
const https = require('https');
const http = require('http');
const cors = require('cors');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const { IPC } = require('../libs/IPC');
const DB_PLUGIN_NAME = require('./Database').PLUGIN_NAME;
const DB_PLUGIN_ACTION = require('./Database').PLUGIN_ACTIONS;

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
  };
}

function init(conf) {
  const {
    rpcNodePort,
    keyCertificate,
    certificate,
    chainCertificate,
  } = conf;

  serverRPC = express();
  serverRPC.use(cors({ methods: ['POST'] }));
  serverRPC.use(bodyParser.urlencoded({ extended: true }));
  serverRPC.use(bodyParser.json());
  serverRPC.post('/blockchain', jayson.server(blockchainRPC()).middleware());

  if (keyCertificate === '' || certificate === '' || chainCertificate === '') {
    http.createServer(serverRPC)
      .listen(rpcNodePort, () => {
        console.log(`RPC Node now listening on port ${rpcNodePort}`); // eslint-disable-line
      });
  } else {
    https.createServer({
      key: fs.readFileSync(keyCertificate),
      cert: fs.readFileSync(certificate),
      ca: fs.readFileSync(chainCertificate),
    }, serverRPC)
      .listen(rpcNodePort, () => {
        console.log(`RPC Node now listening on port ${rpcNodePort}`); // eslint-disable-line
      });
  }
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
      console.log('successfully stopped');
      ipc.reply(message);
      process.exit(0);
      break;
    default:
      ipc.reply(message);
      break;
  }
});

module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLUGIN_PATH = PLUGIN_PATH;
