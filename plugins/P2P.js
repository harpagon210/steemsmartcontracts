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

const ACCOUNT = 'harpagon';
const SIGNING_KEY = dsteem.PrivateKey.fromLogin(ACCOUNT, 'testnet', 'active');
const PUB_SIGNING_KEY = SIGNING_KEY.createPublic().toString();

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

const errorHandler = async (ip, error) => {
  console.error(ip, error);

  if (error.code === 'ECONNREFUSED') {
    if (webSockets[ip]) {
      console.log(`closed connection from peer ${ip} (${webSockets[ip].witness.account})`);
      delete webSockets[ip];
    }
  }
};

const closeHandler = async (ip, code, reason) => {
  if (webSockets[ip]) {
    console.log(`closed connection from peer ${ip} (${webSockets[ip].witness.account})`, code, reason);
    delete webSockets[ip];
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

  return SIGNING_KEY.sign(buffer).toString();
};

const handshakeResponseHandler = async (ip, data) => {
  const { authToken, signature, account } = data;

  let authFailed = true;

  if (authToken && signature && account && webSockets[ip]) {
    const witnessSocket = webSockets[ip];

    // check if this peer is a witness
    const witness = await findOne('witnesses', 'witnesses', {
      account,
    });

    if (witness && witnessSocket.witness.authToken === authToken) {
      const {
        IP,
        signingKey,
      } = witness;

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

  if (authFailed === true && webSockets[ip]) {
    console.log(`handshake failed, dropping connection with peer ${ip}`);
    webSockets[ip].ws.terminate();
    delete webSockets[ip];
  }
};

const handshakeHandler = async (ip, payload) => {
  const { authToken, account, signature } = payload;
  console.log('handshake requested: authToken', authToken);

  let authFailed = true;

  if (authToken && signature && account && webSockets[ip]) {
    const witnessSocket = webSockets[ip];

    // check if this peer is a witness
    const witness = await findOne('witnesses', 'witnesses', {
      account,
    });

    if (witness) {
      const {
        IP,
        signingKey,
      } = witness;

      if ((IP === ip || IP === ip.replace('::ffff:', ''))
        && checkSignature({ authToken }, signature, signingKey)) {
        witnessSocket.witness.account = account;
        witnessSocket.witness.signingKey = signingKey;
        witnessSocket.witness.authToken = authToken;
        witnessSocket.authenticated = true;
        authFailed = false;
        console.log(`witness ${witnessSocket.witness.account} is now authenticated`);
        webSockets[ip].ws.emit('handshakeResponse', { authToken, signature: signPayload({ authToken }), account: ACCOUNT });
      }
    }
  }

  if (authFailed === true && webSockets[ip]) {
    console.log(`handshake failed, dropping connection with peer ${ip}`);
    webSockets[ip].ws.terminate();
    delete webSockets[ip];
  }
};

const connectionHandler = async (ws, req) => {
  const { remoteAddress } = req.connection;
  const ip = remoteAddress;
  // if already connected to this peer, close the web socket
  if (webSockets[ip]) {
    ws.terminate();
  } else {
    const wsEvents = WSEvents(ws);
    ws.on('close', (code, reason) => closeHandler(ip, code, reason));
    ws.on('error', error => errorHandler(ip, error));

    const authToken = generateRandomString(32);
    webSockets[ip] = {
      ws: wsEvents,
      witness: {
        authToken,
      },
      authenticated: false,
    };

    wsEvents.on('handshake', payload => handshakeHandler(ip, payload));
    wsEvents.on('handshakeResponse', data => handshakeResponseHandler(ip, data));

    console.log('requesting handshake peer ', ip);
    webSockets[ip].ws.emit('handshake', { authToken, signature: signPayload({ authToken }), account: ACCOUNT });
  }
};

const connectToWitness = (witness) => {
  const {
    IP,
    P2PPort,
    account,
    signingKey,
    authToken,
  } = witness;

  const ws = new WebSocket(`ws://${IP}:${P2PPort}`);
  const wsEvents = WSEvents(ws);

  webSockets[IP] = {
    ws: wsEvents,
    witness: {
      account,
      signingKey,
      authToken,
    },
    authenticated: false,
  };
  console.log('connection to witness ', account)
  ws.on('close', (code, reason) => closeHandler(IP, code, reason));
  ws.on('error', error => errorHandler(IP, error));
  wsEvents.on('handshake', payload => handshakeHandler(IP, payload));
  wsEvents.on('handshakeResponse', data => handshakeResponseHandler(IP, data));
};

const connectToWitnesses = async () => {
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
    500,
    0,
    [
      { index: 'approvalWeight', descending: true },
    ]);

  console.log(witnesses);
  for (let index = 0; index < witnesses.length; index += 1) {
    if (witnesses[index].account !== ACCOUNT) {
      connectToWitness(witnesses[index]);
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
