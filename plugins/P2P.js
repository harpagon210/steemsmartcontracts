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
const NB_WITNESSES_REQUIRED_TO_VALIDATE_BLOCK = 3;

const actions = {};

const ipc = new IPC(PLUGIN_NAME);

let socketServer = null;
const sockets = {};
let lastProposedBlockNumber = 0;
let lastProposedBlock = null;
let lastVerifiedBlockNumber = 0;
let blockPropositionHandler = null;
let sendingToSidechain = false;

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
      if (json.contractPayload.blockNumber > lastVerifiedBlockNumber
        && sendingToSidechain === false) {
        sendingToSidechain = true;
        await this.client.broadcast.json(transaction, this.signingKey);
        if (json.contractAction === 'proposeBlock') {
          lastProposedBlock = null;
          if (json.contractPayload.blockNumber > lastVerifiedBlockNumber) {
            lastVerifiedBlockNumber = json.contractPayload.blockNumber;
          }
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

const verifyBlockHandler = async (witnessAccount, data) => {
  if (lastProposedBlock !== null) {
    console.log('verification received from', witnessAccount);
    const {
      blockNumber,
      previousHash,
      previousDatabaseHash,
      hash,
      databaseHash,
      merkleRoot,
      signature,
    } = data;

    if (signature && typeof signature === 'string'
      && blockNumber && Number.isInteger(blockNumber)
      && blockNumber === lastProposedBlockNumber
      && previousHash && typeof previousHash === 'string' && previousHash.length === 64
      && previousDatabaseHash && typeof previousDatabaseHash === 'string' && previousDatabaseHash.length === 64
      && hash && typeof hash === 'string' && hash.length === 64
      && databaseHash && typeof databaseHash === 'string' && databaseHash.length === 64
      && merkleRoot && typeof merkleRoot === 'string' && merkleRoot.length === 64) {
      // get witness signing key
      const witness = await findOne('witnesses', 'witnesses', { account: witnessAccount });
      if (witness !== null) {
        const { signingKey } = witness;
        const block = {
          blockNumber,
          previousHash,
          previousDatabaseHash,
          hash,
          databaseHash,
          merkleRoot,
        };

        if (lastProposedBlock.previousHash === previousHash
          && lastProposedBlock.previousDatabaseHash === previousDatabaseHash
          && lastProposedBlock.hash === hash
          && lastProposedBlock.databaseHash === databaseHash
          && lastProposedBlock.merkleRoot === merkleRoot) {
          // check if the signature is valid
          if (checkSignature(block, signature, signingKey)) {
            // check if we reached the consensus
            lastProposedBlock.signatures.push({
              witness: witnessAccount,
              signature,
            });
            if (lastProposedBlock.signatures.length >= NB_WITNESSES_REQUIRED_TO_VALIDATE_BLOCK) {
              // send block to sidechain
              const json = {
                contractName: 'witnesses',
                contractAction: 'proposeBlock',
                contractPayload: {
                  blockNumber,
                  previousHash,
                  previousDatabaseHash,
                  hash,
                  databaseHash,
                  merkleRoot,
                  signatures: lastProposedBlock.signatures,
                },
              };
              await steemClient.sendCustomJSON(json);
            }
          } else {
            console.error(`invalid signature, block ${blockNumber}, witness ${witness.account}`);
          }
        }
      }
    }
  }
};

const proposeBlockHandler = async (id, data, cb) => {
  console.log('proposition received', id, data.blockNumber);
  if (sockets[id] && sockets[id].authenticated === true) {
    const witnessSocket = sockets[id];

    const {
      blockNumber,
      previousHash,
      previousDatabaseHash,
      hash,
      databaseHash,
      merkleRoot,
      signature,
    } = data;

    if (signature && typeof signature === 'string'
      && blockNumber && Number.isInteger(blockNumber)
      && blockNumber > lastVerifiedBlockNumber
      && previousHash && typeof previousHash === 'string' && previousHash.length === 64
      && previousDatabaseHash && typeof previousDatabaseHash === 'string' && previousDatabaseHash.length === 64
      && hash && typeof hash === 'string' && hash.length === 64
      && databaseHash && typeof databaseHash === 'string' && databaseHash.length === 64
      && merkleRoot && typeof merkleRoot === 'string' && merkleRoot.length === 64) {
      // check if the witness is the one scheduled for this block
      const schedule = await findOne('witnesses', 'schedules', { blockNumber, witness: witnessSocket.witness.account });

      if (schedule !== null) {
        // get witness signing key
        const witness = await findOne('witnesses', 'witnesses', { account: witnessSocket.witness.account });

        if (witness !== null) {
          const { signingKey } = witness;
          const block = {
            blockNumber,
            previousHash,
            previousDatabaseHash,
            hash,
            databaseHash,
            merkleRoot,
          };

          // check if the signature is valid
          if (checkSignature(block, signature, signingKey)) {
            // get the block from the current node
            const res = await ipc.send({
              to: DB_PLUGIN_NAME,
              action: DB_PLUGIN_ACTIONS.GET_BLOCK_INFO,
              payload: blockNumber,
            });

            const blockFromNode = res.payload;

            if (blockFromNode !== null) {
              if (blockFromNode.previousHash === previousHash
                && blockFromNode.previousDatabaseHash === previousDatabaseHash
                && blockFromNode.hash === hash
                && blockFromNode.databaseHash === databaseHash
                && blockFromNode.merkleRoot === merkleRoot) {
                if (blockNumber > lastVerifiedBlockNumber) {
                  lastVerifiedBlockNumber = blockNumber;
                }
                const sig = signPayload(block);
                block.signature = sig;
                cb(null, block);
                console.log('verified block', block.blockNumber);
              } else {
                // TODO: handle dispute
                cb('block different', null);
              }
            } else {
              cb('block does not exist', null);
            }
          } else {
            cb('invalid signature', null);
            console.error(`invalid signature, block ${blockNumber}, witness ${witness.account}`);
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
        witnessSocket.socket.on('proposeBlock', (block, cb) => proposeBlockHandler(id, block, cb));
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

    // check if this peer is a witness
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

  //console.log(witnesses);
  for (let index = 0; index < witnesses.length; index += 1) {
    if (witnesses[index].account !== this.witnessAccount) {
      connectToWitness(witnesses[index]);
    }
  }
};

const proposeBlock = async (witness, block) => {
  const witnessSocket = Object.values(sockets).find(w => w.witness.account === witness);
  // if a websocket with this witness is already opened and authenticated
  if (witnessSocket !== undefined && witnessSocket.authenticated === true) {
    witnessSocket.socket.emit('proposeBlock', block, (err, res) => {
      if (err) console.error(witness, err);
      if (res) {
        verifyBlockHandler(witness, res);
      } else if (err === 'block does not exist') {
        setTimeout(() => {
          proposeBlock(witness, block);
        }, 3000);
      }
    });
    console.log('proposing block', block.blockNumber, 'to witness', witnessSocket.witness.account);
  } else {
    // connect to the witness
    const witnessInfo = await findOne('witnesses', 'witnesses', { account: witness });
    if (witnessInfo !== null) {
      connectToWitness(witnessInfo);
      setTimeout(() => {
        proposeBlock(witness, block);
      }, 3000);
    }
  }
};

const checkIfNeedToProposeBlock = async () => {
  if (this.signingKey === null || this.witnessAccount === null || process.env.NODE_MODE === 'REPLAY') return;

  // get the last verified blockNumber
  const params = await findOne('witnesses', 'params', {});

  if (params && lastVerifiedBlockNumber < params.lastVerifiedBlockNumber) {
    // eslint-disable-next-line prefer-destructuring
    lastVerifiedBlockNumber = params.lastVerifiedBlockNumber;
  }

  // get the schedule
  const currentBlockNumber = lastVerifiedBlockNumber + 1;
  let schedule = await findOne('witnesses', 'schedules', { blockNumber: currentBlockNumber });

  console.log('lastVerifiedBlockNumber', lastVerifiedBlockNumber);
  console.log('schedule', schedule);
  console.log('currentBlockNumber', currentBlockNumber);
  console.log('lastProposedBlockNumber', lastProposedBlockNumber);

  if (schedule !== null && schedule.witness === this.witnessAccount
    && currentBlockNumber > lastProposedBlockNumber) {
    const res = await ipc.send({
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.GET_BLOCK_INFO,
      payload: currentBlockNumber,
    });

    const block = res.payload;
    if (block !== null) {
      const {
        blockNumber,
        previousHash,
        previousDatabaseHash,
        hash,
        databaseHash,
        merkleRoot,
      } = block;

      const newBlock = {
        blockNumber,
        previousHash,
        previousDatabaseHash,
        hash,
        databaseHash,
        merkleRoot,
      };

      const signature = signPayload(newBlock);
      newBlock.signature = signature;

      lastProposedBlockNumber = blockNumber;
      lastProposedBlock = newBlock;
      lastProposedBlock.signatures = [];
      lastProposedBlock.signatures.push({ witness: this.witnessAccount, signature });

      // get the witness participating in this round
      schedule = await findOne('witnesses', 'schedules', { blockNumber });
      if (schedule !== null) {
        const { round } = schedule;
        const schedules = await find('witnesses', 'schedules', { round });

        for (let index = 0; index < schedules.length; index += 1) {
          schedule = schedules[index];
          if (schedule.witness !== this.witnessAccount) {
            proposeBlock(schedule.witness, newBlock);
          }
        }
      }
    }
  }

  blockPropositionHandler = setTimeout(() => {
    checkIfNeedToProposeBlock();
  }, 3000);
};

// init the P2P plugin
const init = async (conf, callback) => {
  const {
    p2pPort,
    streamNodes,
    chainId,
  } = conf;

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
    checkIfNeedToProposeBlock();
  } else {
    console.log(`P2P not started, missing env variables ACCOUNT and ACTIVE_SIGNING_KEY`); // eslint-disable-line
  }

  callback(null);
};

// stop the P2P plugin
const stop = (callback) => {
  if (blockPropositionHandler) clearTimeout(blockPropositionHandler);
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
