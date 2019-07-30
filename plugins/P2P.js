/* eslint-disable no-await-in-loop */
const SHA256 = require('crypto-js/sha256');
const enchex = require('crypto-js/enc-hex');
const dsteem = require('dsteem');
const WebSocket = require('ws');
const WSEvents = require('ws-events');
const { IPC } = require('../libs/IPC');


const DB_PLUGIN_NAME = require('./Database.constants').PLUGIN_NAME;
const DB_PLUGIN_ACTIONS = require('./Database.constants').PLUGIN_ACTIONS;

const { PLUGIN_NAME, PLUGIN_ACTIONS } = require('./P2P.constants');

const PLUGIN_PATH = require.resolve(__filename);

const actions = {};

const ipc = new IPC(PLUGIN_NAME);

let webSocketServer = null;
const webSockets = {};

const generateRandomString = (length) => {
  let text = '';
  const possibleChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-=';

  for (let i = 0; i < length; i += 1) {
    text += possibleChars.charAt(Math.floor(Math.random() * possibleChars.length));
  }

  return text;
};

const insert = async (contract, table, record) => {
  const res = await ipc.send({
    to: DB_PLUGIN_NAME,
    action: DB_PLUGIN_ACTIONS.INSERT,
    payload: {
      contract,
      table,
      record,
    },
  });

  return res.payload;
};

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

const errorHandler = async (id, error) => {
  console.error(id, error);

  if (error.code === 'ECONNREFUSED') {
    if (webSockets[id]) {
      console.log(`closed connection with peer ${webSockets[id].witness.account}`);
      delete webSockets[id];
    }
  }
};

const closeHandler = async (id, code, reason) => {
  if (webSockets[id]) {
    console.log(`closed connection with peer ${webSockets[id].witness.account}`, code, reason);
    delete webSockets[id];
  }
};

const checkSignature = (payload, signature, publicKey) => {
  const sig = dsteem.Signature.fromString(signature);
  const payloadHash = SHA256(JSON.stringify(payload)).toString(enchex);
  const buffer = Buffer.from(payloadHash, 'hex');

  return dsteem.PublicKey.fromString(publicKey).verify(buffer, sig);
};

const signPayload = (payload) => {
  const payloadHash = SHA256(JSON.stringify(payload)).toString(enchex);
  const buffer = Buffer.from(payloadHash, 'hex');

  return this.signingKey.sign(buffer).toString();
};

const handshakeResponseHandler = async (id, data) => {
  const { authToken, signature, account } = data;
  let authFailed = true;

  if (authToken && typeof authToken === 'string' && authToken.length === 32
    && signature && typeof signature === 'string' && signature.length === 130
    && account && typeof account === 'string' && account.length >= 3 && account.length <= 16
    && webSockets[id]) {
    const witnessSocket = webSockets[id];

    // check if this peer is a witness
    const witness = await findOne('witnesses', 'witnesses', {
      account,
    });

    if (witness && witnessSocket.witness.authToken === authToken) {
      const {
        IP,
        signingKey,
      } = witness;
      const ip = id.split(':')[0];
      if ((IP === ip || IP === ip.replace('::ffff:', ''))
        && checkSignature({ authToken }, signature, signingKey)) {
        witnessSocket.witness.account = account;
        witnessSocket.witness.signingKey = signingKey;
        witnessSocket.authenticated = true;
        authFailed = false;
        console.log(`witness ${witnessSocket.witness.account} is now authenticated`);
      }
    }
  }

  if (authFailed === true && webSockets[id]) {
    console.log(`handshake failed, dropping connection with peer ${account}`);
    webSockets[id].ws.terminate();
    delete webSockets[id];
  }
};

const handshakeHandler = async (id, payload) => {
  const { authToken, account, signature } = payload;
  let authFailed = true;

  if (authToken && typeof authToken === 'string' && authToken.length === 32
    && signature && typeof signature === 'string' && signature.length === 130
    && account && typeof account === 'string' && account.length >= 3 && account.length <= 16
    && webSockets[id]) {
    const witnessSocket = webSockets[id];

    // check if this peer is a witness
    const witness = await findOne('witnesses', 'witnesses', {
      account,
    });

    if (witness) {
      const {
        IP,
        signingKey,
      } = witness;

      const ip = id.split(':')[0];
      if ((IP === ip || IP === ip.replace('::ffff:', ''))
        && checkSignature({ authToken }, signature, signingKey)) {
        witnessSocket.witness.account = account;
        witnessSocket.witness.signingKey = signingKey;
        authFailed = false;
        witnessSocket.ws.emit('handshakeResponse', { authToken, signature: signPayload({ authToken }), account: this.witnessAccount });

        if (witnessSocket.authenticated !== true) {
          const respAuthToken = generateRandomString(32);
          witnessSocket.witness.authToken = respAuthToken;
          witnessSocket.ws.emit('handshake', { authToken: respAuthToken, signature: signPayload({ authToken: respAuthToken }), account: this.witnessAccount });
        }
      }
    }
  }

  if (authFailed === true && webSockets[id]) {
    console.log(`handshake failed, dropping connection with peer ${account}`);
    webSockets[id].ws.terminate();
    delete webSockets[id];
  }
};

const connectionHandler = async (ws, req) => {
  const { remoteAddress, remotePort } = req.connection;

  const id = `${remoteAddress.replace('::ffff:', '')}:${remotePort}`;
  // if already connected to this peer, close the web socket
  if (webSockets[id]) {
    ws.terminate();
  } else {
    const wsEvents = WSEvents(ws);
    ws.on('close', (code, reason) => closeHandler(id, code, reason));
    ws.on('error', error => errorHandler(id, error));

    const authToken = generateRandomString(32);
    webSockets[id] = {
      ws: wsEvents,
      witness: {
        authToken,
      },
      authenticated: false,
    };

    wsEvents.on('handshake', payload => handshakeHandler(id, payload));
    wsEvents.on('handshakeResponse', data => handshakeResponseHandler(id, data));

    webSockets[id].ws.emit('handshake', { authToken, signature: signPayload({ authToken }), account: this.witnessAccount });
  }
};

const connectToWitness = (witness) => {
  const {
    IP,
    P2PPort,
    account,
    signingKey,
  } = witness;

  const ws = new WebSocket(`ws://${IP}:${P2PPort}`);
  const wsEvents = WSEvents(ws);
  const id = `${IP}:${P2PPort}`;
  webSockets[id] = {
    ws: wsEvents,
    witness: {
      account,
      signingKey,
    },
    authenticated: false,
  };

  ws.on('close', (code, reason) => closeHandler(id, code, reason));
  ws.on('error', error => errorHandler(id, error));
  wsEvents.on('handshake', payload => handshakeHandler(id, payload));
  wsEvents.on('handshakeResponse', data => handshakeResponseHandler(id, data));
};

const connectToWitnesses = async () => {
  // retrieve the existing witnesses (only the top 30)
  const witnesses = await find('witnesses', 'witnesses',
    {
      approvalWeight: {
        $gt: {
          $numberDecimal: '0',
        },
      },
      enabled: true,
    },
    30,
    0,
    [
      { index: 'approvalWeight', descending: true },
    ]);

  console.log(witnesses);
  for (let index = 0; index < witnesses.length; index += 1) {
    if (witnesses[index].account !== this.witnessAccount) {
      connectToWitness(witnesses[index]);
    }
  }
};

// init the P2P plugin
const init = async (conf, callback) => {
  const {
    p2pPort,
  } = conf;

  this.witnessAccount = process.env.ACCOUNT || null;
  this.signingKey = process.env.ACTIVE_SIGNING_KEY
    ? dsteem.PrivateKey.fromString(process.env.ACTIVE_SIGNING_KEY)
    : null;

  // enable the web socket server
  if (this.signingKey && this.witnessAccount) {
    webSocketServer = new WebSocket.Server({ port: p2pPort });
    webSocketServer.on('connection', (ws, req) => connectionHandler(ws, req));
    console.log(`P2P Node now listening on port ${p2pPort}`); // eslint-disable-line

    // TEST ONLY
    /* await insert('witnesses', 'witnesses', {
      account: 'harpagon',
      approvalWeight: {
        $numberDecimal: '10',
      },
      signingKey: dsteem.PrivateKey.fromLogin('harpagon', 'testnet', 'active').createPublic().toString(),
      IP: '127.0.0.1',
      RPCPort: 5000,
      P2PPort: 5001,
      enabled: true,
    });

    await insert('witnesses', 'witnesses', {
      account: 'dan',
      approvalWeight: {
        $numberDecimal: '10',
      },
      signingKey: dsteem.PrivateKey.fromLogin('dan', 'testnet', 'active').createPublic().toString(),
      IP: '127.0.0.1',
      RPCPort: 6000,
      P2PPort: 6001,
      enabled: true,
    });

    
    await insert('witnesses', 'witnesses', {
      account: 'vitalik',
      approvalWeight: {
        $numberDecimal: '10',
      },
      signingKey: dsteem.PrivateKey.fromLogin('vitalik', 'testnet', 'active').createPublic().toString(),
      IP: '127.0.0.1',
      RPCPort: 7000,
      P2PPort: 7001,
      enabled: true,
    });*/

    connectToWitnesses();
  } else {
    console.log(`P2P not started, missing env variables ACCOUNT and ACTIVE_SIGNING_KEY`); // eslint-disable-line
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
module.exports.PLUGIN_ACTIONS = PLUGIN_ACTIONS;
