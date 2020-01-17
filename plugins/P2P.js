/* eslint-disable no-await-in-loop */
const jayson = require('jayson');
const http = require('http');
const cors = require('cors');
const express = require('express');
const bodyParser = require('body-parser');
const SHA256 = require('crypto-js/sha256');
const enchex = require('crypto-js/enc-hex');
const dsteem = require('dsteem');
const axios = require('axios');
const { Queue } = require('../libs/Queue');
const { IPC } = require('../libs/IPC');
const { Database } = require('../libs/Database');

const PLUGIN_NAME = 'P2P';
const PLUGIN_PATH = require.resolve(__filename);
const POST_TIMEOUT = 10000;
const NB_WITNESSES_SIGNATURES_REQUIRED = 3;

const ipc = new IPC(PLUGIN_NAME);
let serverP2P = null;
let server = null;
let database = null;
let currentRound = 0;
let currentWitness = null;
let lastBlockRound = 0;
let lastProposedRoundNumber = 0;
let lastProposedRound = null;
let lastVerifiedRoundNumber = 0;
let SIGNING_KEY = null;
let WITNESS_ACCOUNT = null;

let manageRoundPropositionTimeoutHandler = null;
let sendingToSidechain = false;

let requestId = 1;

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
      required_auths: [this.witnessAccount],
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
        console.log('sending block proposition');
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

async function calculateRoundHash(startBlockRound, endBlockRound) {
  let blockNum = startBlockRound;
  let calculatedRoundHash = '';
  // calculate round hash
  while (blockNum <= endBlockRound) {
    // get the block from the current node
    const blockFromNode = await database.getBlockInfo(blockNum);
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
  const result = await database.find({
    contract,
    table,
    query,
    limit,
    offset,
    indexes,
  });

  return result;
};

const findOne = async (contract, table, query) => {
  const result = await database.findOne({
    contract,
    table,
    query,
  });

  return result;
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

  return SIGNING_KEY.sign(buffer).toString();
};

const getReqId = () => {
  requestId = requestId + 1 > Number.MAX_SAFE_INTEGER ? 1 : requestId + 1;

  return requestId;
};

const verifyRoundHandler = async (witnessAccount, data) => {
  console.log(witnessAccount, data)
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

const proposeRound = async (witness, round, retry = 0) => {
  const witnessRec = await findOne('witnesses', 'witnesses', { account: witness });
  try {
    const data = {
      jsonrpc: '2.0',
      id: getReqId(),
      method: 'proposeRoundHash',
      params: {
        round,
      },
    };
    const url = `http://${witnessRec.IP}:${witnessRec.P2PPort}/p2p`;

    console.log(url)
    const response = await axios({
      url,
      method: 'POST',
      timeout: POST_TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      data,
    });
    console.log(response.data)

    if (currentRound === round.round) {
      if (response.data.result) {
        verifyRoundHandler(witness, response.data.result);
      } else {
        console.error(`Error posting to ${witness} / round ${round} / ${response.data.error.code} / ${response.data.error.message}`);
  
        if (response.data.error.message === 'current round is lower'
          || response.data.error.message === 'current witness is different') {
          if (retry) {
            setTimeout(() => {
              console.log(`propose round: retry ${retry + 1}`)
              proposeRound(witness, round, retry + 1);
            }, 5000);
          }
        }
      }
    } else {
      console.log(`stopped proposing round ${round.round} as it is not the current round anymore`);
    }
  } catch (error) {
    console.error(`Error posting to ${witness} / round ${round} / ${error}`);
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

    if (lastProposedRound && lastProposedRound.round < currentRound) {
      lastProposedRound = null;
    }

    // get the schedule for the lastBlockRound
    console.log('currentRound', currentRound);
    console.log('currentWitness', currentWitness);
    console.log('lastBlockRound', lastBlockRound);
    console.log('lastProposedRound', lastProposedRound);

    // get the witness participating in this round
    const schedules = await find('witnesses', 'schedules', { round: currentRound });

    // check if this witness is part of the round
    const witnessFound = schedules.find(w => w.witness === WITNESS_ACCOUNT);

    if (witnessFound !== undefined
      && lastProposedRound === null
      && currentWitness === WITNESS_ACCOUNT
      && currentRound > lastProposedRoundNumber) {
      // handle round propositions
      const block = await database.getBlockInfo(lastBlockRound);

      if (block !== null) {
        const startblockNum = params.lastVerifiedBlockNumber + 1;
        const calculatedRoundHash = await calculateRoundHash(startblockNum, lastBlockRound);
        const signature = signPayload(calculatedRoundHash, true);

        lastProposedRoundNumber = currentRound;
        lastProposedRound = {
          round: currentRound,
          roundHash: calculatedRoundHash,
          signatures: [[WITNESS_ACCOUNT, signature]],
        };

        const round = {
          round: currentRound,
          roundHash: calculatedRoundHash,
          signature,
          account: process.env.ACCOUNT,
        };

        for (let index = 0; index < schedules.length; index += 1) {
          const schedule = schedules[index];
          if (schedule.witness !== WITNESS_ACCOUNT) {
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

const proposeRoundHandler = async (args, callback) => {
  console.log('round hash proposition received', args.round.account, args.round);

  const {
    round,
    roundHash,
    signature,
    account,
  } = args.round;

  if (signature && typeof signature === 'string'
    && round && Number.isInteger(round)
    && roundHash && typeof roundHash === 'string' && roundHash.length === 64) {
    // get the current round info
    const params = await findOne('witnesses', 'params', {});

    if (params.round === round && params.currentWitness === account) {
      // get witness signing key
      const witness = await findOne('witnesses', 'witnesses', { account });

      if (witness !== null) {
        const { signingKey } = witness;

        // check if the signature is valid
        if (checkSignature(roundHash, signature, signingKey, true)) {
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

            callback(null, roundPayload);
            console.log('verified round', round);
          } else {
            // TODO: handle dispute
            callback({
              code: 404,
              message: 'round hash different',
            }, null);
          }
        } else {
          callback({
            code: 401,
            message: 'invalid signature',
          }, null);
          console.error(`invalid signature, round ${round}, witness ${witness.account}`);
        }
      } else {
        callback({
          code: 401,
          message: 'your witness is not registered',
        }, null);
      }
    } else if (params.round < round) {
      callback({
        code: 404,
        message: 'current round is lower',
      }, null);
    } else if (params.currentWitness !== account) {
      callback({
        code: 404,
        message: 'current witness is different',
      }, null);
    }
  } else {
    callback({
      code: 404,
      message: 'invalid parameters',
    }, null);
  }
};

function p2p() {
  return {
    proposeRoundHash: (args, callback) => proposeRoundHandler(args, callback),
  };
}

const init = async (conf, callback) => {
  const {
    p2pPort,
    streamNodes,
    chainId,
    witnessEnabled,
    steemAddressPrefix,
    steemChainId,
    databaseURL,
    databaseName,
  } = conf;

  if (witnessEnabled === false
    || process.env.ACTIVE_SIGNING_KEY === null
    || process.env.ACCOUNT === null) {
    console.log('P2P not started, missing env variables ACCOUNT and/or ACTIVE_SIGNING_KEY and/or witness not enabled in config.json file');
    callback(null);
  } else {
    database = new Database();
    await database.init(databaseURL, databaseName);
    streamNodes.forEach(node => steemClient.nodes.push(node));
    steemClient.account = process.env.ACCOUNT;
    steemClient.sidechainId = chainId;
    steemClient.steemAddressPrefix = steemAddressPrefix;
    steemClient.steemChainId = steemChainId;

    WITNESS_ACCOUNT = process.env.ACCOUNT || null;
    steemClient.witnessAccount = WITNESS_ACCOUNT;
    SIGNING_KEY = process.env.ACTIVE_SIGNING_KEY
      ? dsteem.PrivateKey.fromString(process.env.ACTIVE_SIGNING_KEY)
      : null;
    steemClient.signingKey = SIGNING_KEY;

    // enable the server
    if (SIGNING_KEY && WITNESS_ACCOUNT) {
      serverP2P = express();
      serverP2P.use(cors({ methods: ['POST'] }));
      serverP2P.use(bodyParser.urlencoded({ extended: true }));
      serverP2P.use(bodyParser.json());
      serverP2P.set('trust proxy', true);
      serverP2P.set('trust proxy', 'loopback');
      serverP2P.post('/p2p', jayson.server(p2p()).middleware());

      server = http.createServer(serverP2P)
        .listen(p2pPort, () => {
          console.log(`P2P server now listening on port ${p2pPort}`); // eslint-disable-line
        });

      manageRoundProposition();
    }

    callback(null);
  }
};

function stop() {
  if (manageRoundPropositionTimeoutHandler) clearTimeout(manageRoundPropositionTimeoutHandler);
  if (server) server.close();
  if (database) database.close();
}

ipc.onReceiveMessage((message) => {
  const {
    action,
    payload,
  } = message;

  switch (action) {
    case 'init':
      init(payload, (res) => {
        console.log('successfully initialized'); // eslint-disable-line no-console
        ipc.reply(message, res);
      });
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
