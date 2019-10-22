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
const MAX_PENDING_ACK_WAITING_TIME = 10000;
const MAX_ROUND_PROPOSITION_ATTEMPTS = 3;
const NB_ROUND_PROPOSITION_WAITING_PERIOS = 10;

const actions = {};

const ipc = new IPC(PLUGIN_NAME);

let socketServer = null;
const sockets = {};

let currentRound = 0;
let currentWitness = null;
let witnessPreviousAttempt = null;
let lastBlockRound = 0;
let lastVerifiedRoundNumber = 0;
let lastProposedRoundNumber = 0;
let lastProposedRound = null;
let roundPropositionWaitingPeriod = 0;
let lastProposedWitnessChange = null;
let lastProposedWitnessChangeRoundNumber = 0;

let manageRoundTimeoutHandler = null;
let managePendingAckHandler = null;
let manageP2PConnectionsTimeoutHandler = null;
let sendingToSidechain = false;

const pendingAcknowledgments = {};

const steemClient = {
  account: null,
  signingKey: null,
  sidechainId: null,
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
        addressPrefix: 'TST',
        chainId: '46d90780152dac449ab5a8b6661c969bf391ac7e277834c9b96278925c243ea8',
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
        } else if (json.contractAction === 'changeCurrentWitness') {
          lastProposedWitnessChange = null;
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
    }
    blockNum += 1;
  }
  return calculatedRoundHash;
}

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

const witnessChangeHandler = async (witnessAccount, data) => {
  if (lastProposedWitnessChange !== null) {
    console.log('witness change received from', witnessAccount);
    const {
      signature,
    } = data;

    if (signature && typeof signature === 'string') {
      // get the current round info
      const params = await findOne('witnesses', 'params', {});
      const witnessToCheck = params.currentWitness;
      const { round } = params;

      // get witness signing key
      const witness = await findOne('witnesses', 'witnesses', { account: witnessAccount });
      if (witness !== null) {
        const { signingKey } = witness;
        // check if the signature is valid
        if (checkSignature(`${witnessToCheck}:${round}`, signature, signingKey)) {
          // check if we reached the consensus
          lastProposedWitnessChange.signatures.push([witnessAccount, signature]);

          // if all the signatures have been gathered
          if (lastProposedWitnessChange.signatures.length >= NB_WITNESSES_SIGNATURES_REQUIRED) {
            // send witness change to sidechain
            const json = {
              contractName: 'witnesses',
              contractAction: 'changeCurrentWitness',
              contractPayload: {
                signatures: lastProposedWitnessChange.signatures,
              },
            };
            await steemClient.sendCustomJSON(json);
          }
        } else {
          console.error(`invalid signature, witness change, round ${round}, witness ${witness.account}`);
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

const proposeWitnessChangeHandler = async (id, data, cb) => {
  console.log('witness change proposition received', id, data.round);
  if (sockets[id] && sockets[id].authenticated === true) {
    const witnessSocket = sockets[id];

    const {
      signature,
    } = data;

    if (signature && typeof signature === 'string') {
      // get the current round info
      const params = await findOne('witnesses', 'params', {});
      const witnessToCheck = params.currentWitness;
      const { round } = params;
      // check if the witness is the first witness scheduled for this round
      const schedules = await find('witnesses', 'schedules', { round });

      if (schedules.length > 0 && schedules[0].witness === witnessSocket.witness.account) {
        // get witness signing key
        const witness = await findOne('witnesses', 'witnesses', { account: witnessSocket.witness.account });

        if (witness !== null) {
          const { signingKey } = witness;
          const payloadToCheck = `${witnessToCheck}:${round}`;
          // check if the signature is valid
          if (checkSignature(payloadToCheck, signature, signingKey)) {
            // check if the witness is connected to this node
            const witnessSocketTmp = Object.values(sockets)
              .find(w => w.witness.account === witnessToCheck);
            // if a websocket with this witness is already opened and authenticated
            // TODO: try to send a request to the witness?
            if (witnessSocketTmp !== undefined && witnessSocketTmp.authenticated === true) {
              cb('witness change rejected', null);
            } else {
              const sig = signPayload(payloadToCheck);
              const roundPayload = {
                signature: sig,
              };

              console.log('witness change accepted', round, 'witness change', witnessToCheck);
              cb(null, roundPayload);
            }
          } else {
            cb('invalid signature', null);
            console.error(`invalid signature witness change proposition, round ${round}, witness ${witness.account}`);
          }
        }
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
        witnessSocket.socket.on('proposeWitnessChange', (round, cb) => proposeWitnessChangeHandler(id, round, cb));
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

  for (let index = 0; index < witnesses.length; index += 1) {
    if (witnesses[index].account !== this.witnessAccount) {
      connectToWitness(witnesses[index]);
    }
  }
};

const addPendingAck = (witness, round) => {
  const ackId = `${witness}:${round.round}`;

  if (pendingAcknowledgments[ackId]) {
    pendingAcknowledgments[ackId].attempts += 1;
    pendingAcknowledgments[ackId].timestamp = new Date();
  } else {
    pendingAcknowledgments[ackId] = {
      witness,
      round,
      timestamp: new Date(),
      attempts: 0,
    };
  }
};

const removePendingAck = (witness, round) => {
  const ackId = `${witness}:${round.round}`;

  if (pendingAcknowledgments[ackId]) {
    delete pendingAcknowledgments[ackId];
  }
};

const proposeRound = async (witness, round) => {
  const witnessSocket = Object.values(sockets).find(w => w.witness.account === witness);
  // if a websocket with this witness is already opened and authenticated
  if (witnessSocket !== undefined && witnessSocket.authenticated === true) {
    addPendingAck(witness, round);
    witnessSocket.socket.emit('proposeRound', round, (err, res) => {
      removePendingAck(witness, round);
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

const proposeWitnessChange = async (witness, round) => {
  const witnessSocket = Object.values(sockets).find(w => w.witness.account === witness);
  // if a websocket with this witness is already opened and authenticated
  if (witnessSocket !== undefined && witnessSocket.authenticated === true) {
    witnessSocket.socket.emit('proposeWitnessChange', round, (err, res) => {
      if (err) console.error(witness, err);
      if (res) {
        witnessChangeHandler(witness, res);
      }
    });
    console.log('proposing witness change', round.round, 'to witness', witnessSocket.witness.account);
  } else {
    // wait for the connection to be established
    setTimeout(() => {
      proposeWitnessChange(witness, round);
    }, 3000);
  }
};

const managePendingAck = () => {
  if (lastProposedRound !== null) {
    const dateNow = new Date().getTime();
    Object.keys(pendingAcknowledgments).forEach((key) => {
      const pendingAck = pendingAcknowledgments[key];
      const deltaDates = dateNow - pendingAck.timestamp.getTime();
      if (deltaDates >= MAX_PENDING_ACK_WAITING_TIME) {
        if (pendingAcknowledgments.attempts >= MAX_ROUND_PROPOSITION_ATTEMPTS) {
          console.error(`cannot reach witness ${pendingAck.witness} / round ${pendingAck.round.round}`);
          delete pendingAcknowledgments[key];
        } else {
          // try to propose the round again
          console.log(`proposing round ${pendingAck.round.round} to witness ${pendingAck.witness} again`);
          proposeRound(pendingAck.witness, pendingAck.round);
        }
      }
    });
  }

  managePendingAckHandler = setTimeout(() => {
    managePendingAck();
  }, 1000);
};

const clearPendingAck = () => {
  Object.keys(pendingAcknowledgments).forEach((key) => {
    delete pendingAcknowledgments[key];
  });
};

const manageRound = async () => {
  if (this.signingKey === null || this.witnessAccount === null || process.env.NODE_MODE === 'REPLAY') return;

  // get the current round info
  const params = await findOne('witnesses', 'params', {});

  if (currentRound < params.round) {
    // eslint-disable-next-line prefer-destructuring
    currentRound = params.round;
  }

  // eslint-disable-next-line prefer-destructuring
  lastBlockRound = params.lastBlockRound;
  // eslint-disable-next-line prefer-destructuring
  currentWitness = params.currentWitness;

  if (currentWitness !== witnessPreviousAttempt) {
    roundPropositionWaitingPeriod = 0;
  }

  // get the schedule for the lastBlockRound
  console.log('currentRound', currentRound);
  console.log('currentWitness', currentWitness);
  console.log('lastBlockRound', lastBlockRound);

  // get the witness participating in this round
  const schedules = await find('witnesses', 'schedules', { round: currentRound });

  // check if this witness is part of the round
  const witnessFound = schedules.find(w => w.witness === this.witnessAccount);

  if (witnessFound !== undefined) {
    if (currentWitness !== this.witnessAccount) {
      if (lastProposedWitnessChange === null) {
        const res = await ipc.send({
          to: DB_PLUGIN_NAME,
          action: DB_PLUGIN_ACTIONS.GET_LATEST_BLOCK_INFO,
          payload: lastBlockRound,
        });

        const block = res.payload;
        if (block !== null && block.blockNumber < lastBlockRound) {
          roundPropositionWaitingPeriod = 0;
        } else {
          roundPropositionWaitingPeriod += 1;
        }

        console.log('roundPropositionWaitingPeriod', roundPropositionWaitingPeriod);

        if (roundPropositionWaitingPeriod >= NB_ROUND_PROPOSITION_WAITING_PERIOS
          && lastProposedWitnessChangeRoundNumber < currentRound) {
          roundPropositionWaitingPeriod = 0;
          lastProposedWitnessChangeRoundNumber = currentRound;
          const firstWitnessRound = schedules[0];
          if (this.witnessAccount === firstWitnessRound.witness) {
            // propose current witness change
            const signature = signPayload(`${currentWitness}:${currentRound}`);

            lastProposedWitnessChange = {
              round: currentRound,
              signatures: [[this.witnessAccount, signature]],
            };

            const round = {
              round: currentRound,
              signature,
            };

            for (let index = 0; index < schedules.length; index += 1) {
              const schedule = schedules[index];
              if (schedule.witness !== this.witnessAccount && schedule.witness !== currentWitness) {
                proposeWitnessChange(schedule.witness, round);
              }
            }
          }
        }
      }
    } else if (lastProposedRound === null
      && currentWitness !== null
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

        clearPendingAck();
        for (let index = 0; index < schedules.length; index += 1) {
          const schedule = schedules[index];
          if (schedule.witness !== this.witnessAccount) {
            proposeRound(schedule.witness, round);
          }
        }
      }
    }
  }

  witnessPreviousAttempt = currentWitness;

  manageRoundTimeoutHandler = setTimeout(() => {
    manageRound();
  }, 3000);
};

const manageP2PConnections = async () => {
  if (this.signingKey === null || this.witnessAccount === null || process.env.NODE_MODE === 'REPLAY') return;

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
  } = conf;

  if (witnessEnabled === false) callback(null);

  streamNodes.forEach(node => steemClient.nodes.push(node));
  steemClient.sidechainId = chainId;

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

    // TEST ONLY
    /* await insert('witnesses', 'witnesses', {
      account: 'harpagon',
      approvalWeight: {
        $numberDecimal: '10',
      },
      signingKey: dsteem.PrivateKey.fromLogin('harpagon', 'testnet', 'active')
        .createPublic()
        .toString(),
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
      signingKey: dsteem.PrivateKey.fromLogin('vitalik', 'testnet', 'active')
        .createPublic()
        .toString(),
      IP: '127.0.0.1',
      RPCPort: 7000,
      P2PPort: 7001,
      enabled: true,
    }); */

    // connectToWitnesses();
    manageRound();
    managePendingAck();
    manageP2PConnections();
  } else {
    console.log(`P2P not started, missing env variables ACCOUNT and ACTIVE_SIGNING_KEY`); // eslint-disable-line
  }

  callback(null);
};

// stop the P2P plugin
const stop = (callback) => {
  if (manageRoundTimeoutHandler) clearTimeout(manageRoundTimeoutHandler);
  if (managePendingAckHandler) clearTimeout(managePendingAckHandler);
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
