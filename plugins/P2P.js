/* eslint-disable no-await-in-loop */
const SHA256 = require('crypto-js/sha256');
const enchex = require('crypto-js/enc-hex');
const { IPC } = require('../libs/IPC');
const WebSocket = require('ws');

const DB_PLUGIN_NAME = require('./Database.constants').PLUGIN_NAME;
const DB_PLUGIN_ACTIONS = require('./Database.constants').PLUGIN_ACTIONS;

const { PLUGIN_NAME, PLUGIN_ACTIONS } = require('./P2P.constants');

const PLUGIN_PATH = require.resolve(__filename);

const actions = {};

const ipc = new IPC(PLUGIN_NAME);

let webSocketServer = null;
let webSockets = {};

const find = async (contract, table, query, limit = 1000, offset = 0, indexes = []) => {
  const res = await ipc.send({
    to: DB_PLUGIN_NAME,
    action: DB_PLUGIN_ACTIONS.FIND,
    payload: {
      contract,
      table,
      query,
      limit,
      offset,
      indexes,
    },
  });

  return res.payload;
};

const findOne = async (contract, table, query) => {
  const res = await ipc.send({
    to: DB_PLUGIN_NAME,
    action: DB_PLUGIN_ACTIONS.FIND_ONE,
    payload: {
      contract,
      table,
      query,
    },
  });

  return res.payload;
};

const sendData = (ip, data) => {
  try {
    if (webSockets[ip]) {
      webSockets[ip].ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error(`An error occured while sending data to ${ip}`, error);
  }
};

const messageHandler = async (ip, data) => {
  console.log(ip, data);
};

const errorHandler = async (ip, error) => {
  console.log(ip, error);
};

const closeHandler = async (ip, code, reason) => {
  console.log(`closed connection from peer ${ip}`, code, reason);
  if (webSockets[ip]) {
    delete webSockets[ip];
  }
};

const connectionHandler = async (ws, req) => {
  const { remoteAddress } = req.connection;
  const ip = remoteAddress.replace('::ffff:', '');

  // if already connected to this peer, close the web socket
  if (webSockets[ip]) {
    ws.terminate();
  } else {
    // check if this peer is a witness
    let witness = await findOne('witnesses', 'witnesses', {
      IP: remoteAddress.replace('::ffff:', ''),
    });

    witness = 'true'

    if (witness) {
      console.log(`accepted connection from peer ${ip}`);
      ws.on('message', data => messageHandler(ip, data));
      ws.on('close', (code, reason) => closeHandler(ip, code, reason));
      ws.on('error', error => errorHandler(ip, error));
      ws.emit('test', 'test')
      ws.on('test', (data) => {
        console.log('test', data)
      })
      webSockets[ip] = { ws };
      //sendData(ip, { test: 'testdata' });
    } else {
      console.log(`rejected connection from peer ${ip}`);
      ws.terminate();
    }
  }
};

// init the P2P plugin
const init = async (conf, callback) => {
  const {
    p2pPort,
  } = conf;

  // enable the web socket server
  webSocketServer = new WebSocket.Server({ port: p2pPort });
  webSocketServer.on('connection', (ws, req) => connectionHandler(ws, req));
  console.log(`P2P Node now listening on port ${p2pPort}`); // eslint-disable-line

  // retrieve the existing witnesses (only the top 50)
  const witnesses = await find('witnesses', 'witnesses',
    {
      approvalWeight: {
        $gt: {
          $numberDecimal: '0',
        },
      },
      enabled: true,
    },
    50,
    0,
    [
      { index: 'approvalWeight', descending: true },
    ]);

  console.log(witnesses)
  if (witnesses.length > 0) {
    // connect to the witnesses
  }

  callback(null);
};

// stop the P2P plugin
const stop = (callback) => {
  if (webSocketServer) {
    webSocketServer.close();
  }
  callback();
};

ipc.onReceiveMessage((message) => {
  const {
    action,
    payload,
  } = message;

  if (action === 'init') {
    init(payload, (res) => {
      console.log('successfully initialized on port'); // eslint-disable-line no-console
      ipc.reply(message, res);
    });
  } else if (action === 'stop') {
    stop((res) => {
      console.log('successfully stopped'); // eslint-disable-line no-console
      ipc.reply(message, res);
    });
  } else if (action && typeof actions[action] === 'function') {
    actions[action](payload, (res) => {
      // console.log('action', action, 'res', res, 'payload', payload);
      ipc.reply(message, res);
    });
  } else {
    ipc.reply(message);
  }
});

module.exports.PLUGIN_PATH = PLUGIN_PATH;
module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLUGIN_ACTIONS = PLUGIN_ACTIONS;
