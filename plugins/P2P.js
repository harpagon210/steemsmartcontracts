/* eslint-disable no-await-in-loop */
const SHA256 = require('crypto-js/sha256');
const enchex = require('crypto-js/enc-hex');
const dsteem = require('dsteem');
const io = require('socket.io');
const ioclient = require('socket.io-client');
const http = require('http');
const { IPC } = require('../libs/IPC');
const { Queue } = require('../libs/Queue');


const DB_PLUGIN_NAME = require('./Database.constants').PLUGIN_NAME;
const DB_PLUGIN_ACTIONS = require('./Database.constants').PLUGIN_ACTIONS;

const { PLUGIN_NAME, PLUGIN_ACTIONS } = require('./P2P.constants');

const PLUGIN_PATH = require.resolve(__filename);
const NB_WITNESSES_SIGNATURES_REQUIRED = 3;

const actions = {};

const ipc = new IPC(PLUGIN_NAME);

let socketServer = null;
const sockets = {};

let currentRound = 0;
let currentWitness = null;
let lastBlockRound = 0;
let lastVerifiedRoundNumber = 0;
let lastProposedRoundNumber = 0;
let lastProposedRound = null;

let manageRoundPropositionTimeoutHandler = null;
let manageP2PConnectionsTimeoutHandler = null;
let sendingToSidechain = false;

const steemClient = {
  account: null,
  signingKey: null,
  sidechainId: null,
  steemAddressPrefix: null,
  steemChainId: null,
  client: null,
  nodes: new Queue(),
  getSteemNode() {
    const node = this.nodes.pop();
    this.nodes.push(node);
    return node;
  },
  async sendCustomJSON(json) {
    const transaction = {
      required_auths: [this.account],
      required_posting_auths: [],
      id: `ssc-${this.sidechainId}`,
      json: JSON.stringify(json),
    };

    if (this.client === null) {
      this.client = new dsteem.Client(this.getSteemNode(), {
        addressPrefix: this.steemAddressPrefix,
        chainId: this.steemChainId,
      });
    }

    try {
      if ((json.contractPayload.round === undefined
          || (json.contractPayload.round && json.contractPayload.round > lastVerifiedRoundNumber))
        && sendingToSidechain === false) {
        sendingToSidechain = true;

        await this.client.broadcast.json(transaction, this.signingKey);
        if (json.contractAction === 'proposeRound') {
          lastProposedRound = null;
        }
        sendingToSidechain = false;
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      sendingToSidechain = false;
      console.error(error);
      this.client = null;
      setTimeout(() => this.sendCustomJSON(json), 1000);
    }
  },
};

if (process.env.ACTIVE_SIGNING_KEY && process.env.ACCOUNT) {
  steemClient.signingKey = dsteem.PrivateKey.fromString(process.env.ACTIVE_SIGNING_KEY);
  // eslint-disable-next-line prefer-destructuring
  steemClient.account = process.env.ACCOUNT;
}

const generateRandomString = (length) => {
  let text = '';
  const possibleChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-=';

  for (let i = 0; i < length; i += 1) {
    text += possibleChars.charAt(Math.floor(Math.random() * possibleChars.length));
  }

  return text;
};

async function calculateRoundHash(startBlockRound, endBlockRound) {
  let blockNum = startBlockRound;
  let calculatedRoundHash = '';
  // calculate round hash
  while (blockNum <= endBlockRound) {
    // get the block from the current node
    const queryRes = await ipc.send({
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.GET_BLOCK_INFO,
      payload: blockNum,
    });

    const blockFromNode = queryRes.payload;
    if (blockFromNode !== null) {
      calculatedRoundHash = SHA256(`${calculatedRoundHash}${blockFromNode.hash}`).toString(enchex);
    } else {
      return null;
    }
    blockNum += 1;
  }
  return calculatedRoundHash;
}

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
    if (sockets[id]) {
      console.log(`closed connection with peer ${sockets[id].witness.account}`);
      delete sockets[id];
    }
  }
};

const disconnectHandler = async (id, reason) => {
  if (sockets[id]) {
    console.log(`closed connection with peer ${sockets[id].witness.account}`, reason);
    delete sockets[id];
  }
};

const checkSignature = (payload, signature, publicKey, isPayloadSHA256 = false) => {
  try {
    const sig = dsteem.Signature.fromString(signature);
    let payloadHash;

    if (isPayloadSHA256 === true) {
      payloadHash = payload;
    } else {
      payloadHash = typeof payload === 'string'
        ? SHA256(payload).toString(enchex)
        : SHA256(JSON.stringify(payload)).toString(enchex);
    }

    const buffer = Buffer.from(payloadHash, 'hex');

    return dsteem.PublicKey.fromString(publicKey).verify(buffer, sig);
  } catch (error) {
    console.log(error);
    return false;
  }
};

const signPayload = (payload, isPayloadSHA256 = false) => {
  let payloadHash;
  if (isPayloadSHA256 === true) {
    payloadHash = payload;
  } else {
    payloadHash = typeof payload === 'string'
      ? SHA256(payload).toString(enchex)
      : SHA256(JSON.stringify(payload)).toString(enchex);
  }

  const buffer = Buffer.from(payloadHash, 'hex');

  return this.signingKey.sign(buffer).toString();
};

const verifyRoundHandler = async (witnessAccount, data) => {
  if (lastProposedRound !== null) {
    console.log('verification round received from', witnessAccount);
    const {
      round,
      roundHash,
      signature,
    } = data;

    if (signature && typeof signature === 'string'
      && round && Number.isInteger(round)
      && roundHash && typeof roundHash === 'string' && roundHash.length === 64) {
      // get witness signing key
      const witness = await findOne('witnesses', 'witnesses', { account: witnessAccount });
      if (witness !== null) {
        const { signingKey } = witness;
        if (lastProposedRound.roundHash === roundHash) {
          // check if the signature is valid
          if (checkSignature(roundHash, signature, signingKey, true)) {
            // check if we reached the consensus
            lastProposedRound.signatures.push([witnessAccount, signature]);

            // if all the signatures have been gathered
            if (lastProposedRound.signatures.length >= NB_WITNESSES_SIGNATURES_REQUIRED) {
              // send round to sidechain
              const json = {
                contractName: 'witnesses',
                contractAction: 'proposeRound',
                contractPayload: {
                  round,
                  roundHash,
                  signatures: lastProposedRound.signatures,
                },
              };
              await steemClient.sendCustomJSON(json);
              lastVerifiedRoundNumber = round;
            }
          } else {
            console.error(`invalid signature, round ${round}, witness ${witness.account}`);
          }
        }
      }
    }
  }
};

const proposeRoundHandler = async (id, data, cb) => {
  console.log('round hash proposition received', id, data.round);
  if (sockets[id] && sockets[id].authenticated === true) {
    const witnessSocket = sockets[id];

    const {
      round,
      roundHash,
      signature,
    } = data;

    if (signature && typeof signature === 'string'
      && round && Number.isInteger(round)
      && roundHash && typeof roundHash === 'string' && roundHash.length === 64) {
      // check if the witness is the one scheduled for this block
      const schedule = await findOne('witnesses', 'schedules', { round, witness: witnessSocket.witness.account });

      if (schedule !== null) {
        // get witness signing key
        const witness = await findOne('witnesses', 'witnesses', { account: witnessSocket.witness.account });

        if (witness !== null) {
          const { signingKey } = witness;

          // check if the signature is valid
          if (checkSignature(roundHash, signature, signingKey, true)) {
            // get the current round info
            const params = await findOne('witnesses', 'params', {});

            if (currentRound < params.round) {
              // eslint-disable-next-line prefer-destructuring
              currentRound = params.round;
            }

            // eslint-disable-next-line prefer-destructuring
            lastBlockRound = params.lastBlockRound;

            const startblockNum = params.lastVerifiedBlockNumber + 1;
            const calculatedRoundHash = await calculateRoundHash(startblockNum, lastBlockRound);

            if (calculatedRoundHash === roundHash) {
              if (round > lastVerifiedRoundNumber) {
                lastVerifiedRoundNumber = round;
              }

              const sig = signPayload(calculatedRoundHash, true);
              const roundPayload = {
                round,
                roundHash,
                signature: sig,
              };

              cb(null, roundPayload);
              console.log('verified round', round);
            } else {
              // TODO: handle dispute
              cb('round hash different', null);
            }
          } else {
            cb('invalid signature', null);
            console.error(`invalid signature, round ${round}, witness ${witness.account}`);
          }
        }
      } else {
        cb('non existing schedule', null);
      }
    }
  } else if (sockets[id] && sockets[id].authenticated === false) {
    cb('not authenticated', null);
    console.error(`witness ${sockets[id].witness.account} not authenticated`);
  }
};

const handshakeResponseHandler = async (id, data) => {
  const { authToken, signature, account } = data;
  let authFailed = true;

  if (authToken && typeof authToken === 'string' && authToken.length === 32
    && signature && typeof signature === 'string' && signature.length === 130
    && account && typeof account === 'string' && account.length >= 3 && account.length <= 16
    && sockets[id]) {
    const witnessSocket = sockets[id];

    // check if this peer is a witness
    const witness = await findOne('witnesses', 'witnesses', { account });

    if (witness && witnessSocket.witness.authToken === authToken) {
      const {
        signingKey,
      } = witness;

      if (checkSignature({ authToken }, signature, signingKey)) {
        witnessSocket.witness.account = account;
        witnessSocket.authenticated = true;
        authFailed = false;
        witnessSocket.socket.on('proposeRound', (round, cb) => proposeRoundHandler(id, round, cb));
        witnessSocket.socket.emitWithTimeout = (event, arg, cb, timeout) => {
          const finalTimeout = timeout || 10000;
          let called = false;
          let timeoutHandler = null;
          witnessSocket.socket.emit(event, arg, (err, res) => {
            if (called) return;
            called = true;
            if (timeoutHandler) {
              clearTimeout(timeoutHandler);
            }
            cb(err, res);
          });

          timeoutHandler = setTimeout(() => {
            if (called) return;
            called = true;
            cb(new Error('callback timeout'));
          }, finalTimeout);
        };
        console.log(`witness ${witnessSocket.witness.account} is now authenticated`);
      }
    }
  }

  if (authFailed === true && sockets[id]) {
    console.log(`handshake failed, dropping connection with peer ${account}`);
    sockets[id].socket.disconnect();
    delete sockets[id];
  }
};

const handshakeHandler = async (id, payload, cb) => {
  const { authToken, account, signature } = payload;
  let authFailed = true;

  if (authToken && typeof authToken === 'string' && authToken.length === 32
    && signature && typeof signature === 'string' && signature.length === 130
    && account && typeof account === 'string' && account.length >= 3 && account.length <= 16
    && sockets[id]) {
    const witnessSocket = sockets[id];

    // get the current round info
    const params = await findOne('witnesses', 'params', {});
    const { round } = params;
    // check if the account is a witness scheduled for the current round
    const schedule = await findOne('witnesses', 'schedules', { round, witness: account });

    if (schedule) {
      // get the witness details
      const witness = await findOne('witnesses', 'witnesses', {
        account,
      });

      if (witness) {
        const {
          IP,
          signingKey,
        } = witness;

        const ip = witnessSocket.address;
        if ((IP === ip || IP === ip.replace('::ffff:', ''))
          && checkSignature({ authToken }, signature, signingKey)) {
          witnessSocket.witness.account = account;
          authFailed = false;
          cb({ authToken, signature: signPayload({ authToken }), account: this.witnessAccount });

          if (witnessSocket.authenticated !== true) {
            const respAuthToken = generateRandomString(32);
            witnessSocket.witness.authToken = respAuthToken;
            witnessSocket.socket.emit('handshake',
              {
                authToken: respAuthToken,
                signature: signPayload({ authToken: respAuthToken }),
                account: this.witnessAccount,
              },
              data => handshakeResponseHandler(id, data));
          }
        }
      }
    }
  }

  if (authFailed === true && sockets[id]) {
    console.log(`handshake failed, dropping connection with peer ${account}`);
    sockets[id].socket.disconnect();
    delete sockets[id];
  }
};

const connectionHandler = async (socket) => {
  const { id } = socket;
  // if already connected to this peer, close the web socket
  if (sockets[id]) {
    console.log('connectionHandler', 'closing because of existing connection with id', id);
    socket.disconnect();
  } else {
    socket.on('close', reason => disconnectHandler(id, reason));
    socket.on('disconnect', reason => disconnectHandler(id, reason));
    socket.on('error', error => errorHandler(id, error));

    const authToken = generateRandomString(32);
    sockets[id] = {
      socket,
      address: socket.handshake.address,
      witness: {
        authToken,
      },
      authenticated: false,
    };

    socket.on('handshake', (payload, cb) => handshakeHandler(id, payload, cb));

    sockets[id].socket.emit('handshake',
      {
        authToken,
        signature: signPayload({ authToken }),
        account: this.witnessAccount,
      },
      data => handshakeResponseHandler(id, data));
  }
};

const connectToWitness = (witness) => {
  const {
    IP,
    P2PPort,
    account,
    signingKey,
  } = witness;

  const socket = ioclient.connect(`http://${IP}:${P2PPort}`);

  const id = `${IP}:${P2PPort}`;
  sockets[id] = {
    socket,
    address: IP,
    witness: {
      account,
      signingKey,
    },
    authenticated: false,
  };

  socket.on('disconnect', reason => disconnectHandler(id, reason));
  socket.on('error', error => errorHandler(id, error));
  socket.on('handshake', (payload, cb) => handshakeHandler(id, payload, cb));
};

const proposeRound = async (witness, round) => {
  const witnessSocket = Object.values(sockets).find(w => w.witness.account === witness);
  // if a websocket with this witness is already opened and authenticated
  if (witnessSocket !== undefined && witnessSocket.authenticated === true) {
    // eslint-disable-next-line func-names
    witnessSocket.socket.emitWithTimeout('proposeRound', round, (err, res) => {
      if (err) console.error(witness, err);
      if (res) {
        verifyRoundHandler(witness, res);
      } else if (err === 'round hash different') {
        setTimeout(() => {
          proposeRound(witness, round);
        }, 3000);
      }
    });
    console.log('proposing round', round.round, 'to witness', witnessSocket.witness.account);
  } else {
    // wait for the connection to be established
    setTimeout(() => {
      proposeRound(witness, round);
    }, 3000);
  }
};

const manageRoundProposition = async () => {
  // get the current round info
  const params = await findOne('witnesses', 'params', {});

  if (params) {
    if (currentRound < params.round) {
      // eslint-disable-next-line prefer-destructuring
      currentRound = params.round;
    }

    // eslint-disable-next-line prefer-destructuring
    lastBlockRound = params.lastBlockRound;
    // eslint-disable-next-line prefer-destructuring
    currentWitness = params.currentWitness;

    // get the schedule for the lastBlockRound
    console.log('currentRound', currentRound);
    console.log('currentWitness', currentWitness);
    console.log('lastBlockRound', lastBlockRound);

    // get the witness participating in this round
    const schedules = await find('witnesses', 'schedules', { round: currentRound });

    // check if this witness is part of the round
    const witnessFound = schedules.find(w => w.witness === this.witnessAccount);

    if (witnessFound !== undefined
      && lastProposedRound === null
      && currentWitness === this.witnessAccount
      && currentRound > lastProposedRoundNumber) {
      // handle round propositions
      const res = await ipc.send({
        to: DB_PLUGIN_NAME,
        action: DB_PLUGIN_ACTIONS.GET_BLOCK_INFO,
        payload: lastBlockRound,
      });

      const block = res.payload;

      if (block !== null) {
        const startblockNum = params.lastVerifiedBlockNumber + 1;
        const calculatedRoundHash = await calculateRoundHash(startblockNum, lastBlockRound);
        const signature = signPayload(calculatedRoundHash, true);

        lastProposedRoundNumber = currentRound;
        lastProposedRound = {
          round: currentRound,
          roundHash: calculatedRoundHash,
          signatures: [[this.witnessAccount, signature]],
        };

        const round = {
          round: currentRound,
          roundHash: calculatedRoundHash,
          signature,
        };

        for (let index = 0; index < schedules.length; index += 1) {
          const schedule = schedules[index];
          if (schedule.witness !== this.witnessAccount) {
            proposeRound(schedule.witness, round);
          }
        }
      }
    }
  }

  manageRoundPropositionTimeoutHandler = setTimeout(() => {
    manageRoundProposition();
  }, 3000);
};

const manageP2PConnections = async () => {
  if (currentRound > 0) {
    // get the witness participating in this round
    const schedules = await find('witnesses', 'schedules', { round: currentRound });

    // check if this witness is part of the round
    const witnessFound = schedules.find(w => w.witness === this.witnessAccount);

    if (witnessFound !== undefined) {
      // connect to the witnesses
      for (let index = 0; index < schedules.length; index += 1) {
        const schedule = schedules[index];
        const witnessSocket = Object.values(sockets)
          .find(w => w.witness.account === schedule.witness);
        if (schedule.witness !== this.witnessAccount
          && witnessSocket === undefined) {
          // connect to the witness
          const witnessInfo = await findOne('witnesses', 'witnesses', { account: schedule.witness });
          if (witnessInfo !== null) {
            connectToWitness(witnessInfo);
          }
        }
      }
    }
  }

  manageP2PConnectionsTimeoutHandler = setTimeout(() => {
    manageP2PConnections();
  }, 3000);
};

// init the P2P plugin
const init = async (conf, callback) => {
  const {
    p2pPort,
    streamNodes,
    chainId,
    witnessEnabled,
    steemAddressPrefix,
    steemChainId,
  } = conf;

  if (witnessEnabled === false
    || process.env.ACTIVE_SIGNING_KEY === null
    || process.env.ACCOUNT === null) {
    console.log('P2P not started, missing env variables ACCOUNT and/or ACTIVE_SIGNING_KEY and/or witness not enabled in config.json file');
    callback(null);
  } else {
    streamNodes.forEach(node => steemClient.nodes.push(node));
    steemClient.sidechainId = chainId;
    steemClient.steemAddressPrefix = steemAddressPrefix;
    steemClient.steemChainId = steemChainId;

    this.witnessAccount = process.env.ACCOUNT || null;
    this.signingKey = process.env.ACTIVE_SIGNING_KEY
      ? dsteem.PrivateKey.fromString(process.env.ACTIVE_SIGNING_KEY)
      : null;

    // enable the web socket server
    if (this.signingKey && this.witnessAccount) {
      const server = http.createServer();
      server.listen(p2pPort, '0.0.0.0');
      socketServer = io.listen(server);
      socketServer.on('connection', socket => connectionHandler(socket));
      console.log(`P2P Node now listening on port ${p2pPort}`); // eslint-disable-line

      manageRoundProposition();
      manageP2PConnections();
    }

    callback(null);
  }
};

// stop the P2P plugin
const stop = (callback) => {
  if (manageRoundPropositionTimeoutHandler) clearTimeout(manageRoundPropositionTimeoutHandler);
  if (manageP2PConnectionsTimeoutHandler) clearTimeout(manageP2PConnectionsTimeoutHandler);

  if (socketServer) {
    socketServer.close();
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
