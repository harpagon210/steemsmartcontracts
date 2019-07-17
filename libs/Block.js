const SHA256 = require('crypto-js/sha256');
const enchex = require('crypto-js/enc-hex');
const dsteem = require('dsteem');

const { SmartContracts } = require('./SmartContracts');
const { Transaction } = require('../libs/Transaction');

const DB_PLUGIN_NAME = require('../plugins/Database.constants').PLUGIN_NAME;
const DB_PLUGIN_ACTIONS = require('../plugins/Database.constants').PLUGIN_ACTIONS;

class Block {
  constructor(timestamp, refSteemBlockNumber, refSteemBlockId, prevRefSteemBlockId, transactions, previousBlockNumber, previousHash = '', previousDatabaseHash = '') {
    this.blockNumber = previousBlockNumber + 1;
    this.refSteemBlockNumber = refSteemBlockNumber;
    this.refSteemBlockId = refSteemBlockId;
    this.prevRefSteemBlockId = prevRefSteemBlockId;
    this.previousHash = previousHash;
    this.previousDatabaseHash = previousDatabaseHash;
    this.timestamp = timestamp;
    this.transactions = transactions;
    this.virtualTransactions = [];
    this.hash = this.calculateHash();
    this.databaseHash = '';
    this.merkleRoot = '';
    this.witnesses = [];
    this.verified = false;
  }

  // calculate the hash of the block
  calculateHash() {
    return SHA256(
      this.previousHash
      + this.previousDatabaseHash
      + this.blockNumber.toString()
      + this.refSteemBlockNumber.toString()
      + this.refSteemBlockId
      + this.prevRefSteemBlockId
      + this.timestamp
      + JSON.stringify(this.transactions) // eslint-disable-line
    )
      .toString(enchex);
  }

  // calculate the Merkle root of the block ((#TA + #TB) + (#TC + #TD) )
  calculateMerkleRoot(transactions) {
    if (transactions.length <= 0) return '';

    const tmpTransactions = transactions.slice(0, transactions.length);
    const newTransactions = [];
    const nbTransactions = tmpTransactions.length;

    for (let index = 0; index < nbTransactions; index += 2) {
      const left = tmpTransactions[index].hash;
      const right = index + 1 < nbTransactions ? tmpTransactions[index + 1].hash : left;

      const leftDbHash = tmpTransactions[index].databaseHash;
      const rightDbHash = index + 1 < nbTransactions
        ? tmpTransactions[index + 1].databaseHash
        : leftDbHash;

      newTransactions.push({
        hash: SHA256(left + right).toString(enchex),
        databaseHash: SHA256(leftDbHash + rightDbHash).toString(enchex),
      });
    }

    if (newTransactions.length === 1) {
      return {
        hash: newTransactions[0].hash,
        databaseHash: newTransactions[0].databaseHash,
      };
    }

    return this.calculateMerkleRoot(newTransactions);
  }

  // dispute a block if a proposed block doesn't match the one produced by this node
  static async handleDispute(action, proposedBlock, ipc, steemClient) {
    // eslint-disable-next-line no-await-in-loop
    let res = await ipc.send({
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.GET_BLOCK_INFO,
      payload: proposedBlock.blockNumber,
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

      // check if this witness already disputed the block
      res = await ipc.send({
        to: DB_PLUGIN_NAME,
        action: DB_PLUGIN_ACTIONS.FIND_ONE,
        payload: {
          contract: 'witnesses',
          table: 'disputes',
          query: {
            blockNumber,
            'witnesses.witness': steemClient.account,
          },
        },
      });

      if (res.payload === null) {
        // get the round of the block
        res = await ipc.send({
          to: DB_PLUGIN_NAME,
          action: DB_PLUGIN_ACTIONS.FIND_ONE,
          payload: {
            contract: 'witnesses',
            table: 'proposedBlocks',
            query: {
              blockNumber,
            },
          },
        });

        if (res.payload !== null) {
          const { round } = res.payload;

          // check if the witness is allowed to dispute the block
          res = await ipc.send({
            to: DB_PLUGIN_NAME,
            action: DB_PLUGIN_ACTIONS.FIND_ONE,
            payload: {
              contract: 'witnesses',
              table: 'schedules',
              query: {
                round,
                witness: steemClient.account,
              },
            },
          });

          if (res.payload !== null) {
            let disputeBlock = false;
            const json = {
              contractName: 'witnesses',
              contractAction: 'disputeBlock',
              contractPayload: {
                blockNumber,
                previousHash,
                previousDatabaseHash,
                hash,
                databaseHash,
                merkleRoot,
              },
            };
            if (action === 'proposeBlock') {
              if (blockNumber !== proposedBlock.blockNumber
                || previousHash !== proposedBlock.previousHash
                || previousDatabaseHash !== proposedBlock.previousDatabaseHash
                || hash !== proposedBlock.hash
                || databaseHash !== proposedBlock.databaseHash
                || merkleRoot !== proposedBlock.merkleRoot) {
                disputeBlock = true;
              }
            } else if (action === 'disputeBlock') {
              disputeBlock = true;
            }

            if (disputeBlock === true) {
              steemClient.sendCustomJSON(json);
            }
          }
        }
      }
    }
  }

  // produce the block (deploy a smart contract or execute a smart contract)
  async produceBlock(ipc, jsVMTimeout, steemClient) {
    const nbTransactions = this.transactions.length;

    let currentDatabaseHash = this.previousDatabaseHash;

    for (let i = 0; i < nbTransactions; i += 1) {
      const transaction = this.transactions[i];
      await this.processTransaction(ipc, jsVMTimeout, transaction, currentDatabaseHash); // eslint-disable-line

      currentDatabaseHash = transaction.databaseHash;

      // check if a dispute is needed when a new block has been proposed
      if (steemClient.account !== null
        && transaction.sender !== steemClient.account
        && transaction.contract === 'witnesses'
        && (transaction.action === 'proposeBlock' || transaction.action === 'disputeBlock')
        && transaction.logs === '{}') {
        const blockInfo = JSON.parse(transaction.payload);

        if (blockInfo && blockInfo.blockNumber) {
          Block.handleDispute(transaction.action, blockInfo, ipc, steemClient);
        }
      }
    }

    // remove comment, comment_options and votes if not relevant
    this.transactions = this.transactions.filter(value => value.contract !== 'comments' || value.logs === '{}');

    // handle virtual transactions
    const virtualTransactions = [];

    // check the pending unstakings and undelegation
    if (this.refSteemBlockNumber >= 32713424) {
      virtualTransactions.push(new Transaction(0, '', 'null', 'tokens', 'checkPendingUnstakes', ''));
      virtualTransactions.push(new Transaction(0, '', 'null', 'tokens', 'checkPendingUndelegations', ''));
    }

    virtualTransactions.push(new Transaction(0, '', 'null', 'witnesses', 'checkBlockVerificationStatus', ''));

    const nbVirtualTransactions = virtualTransactions.length;
    for (let i = 0; i < nbVirtualTransactions; i += 1) {
      const transaction = virtualTransactions[i];
      transaction.refSteemBlockNumber = this.refSteemBlockNumber;
      transaction.transactionId = `${this.refSteemBlockNumber}-${i}`;
      await this.processTransaction(ipc, jsVMTimeout, transaction, currentDatabaseHash); // eslint-disable-line
      currentDatabaseHash = transaction.databaseHash;

      // if there are outputs in the virtual transaction we save the transaction into the block
      // the "unknown error" errors are removed as they are related to a non existing action
      if (transaction.logs !== '{}' && transaction.logs !== '{"errors":["unknown error"]}') {
        this.virtualTransactions.push(transaction);
        // if a block has been verified
        if (transaction.contract === 'witnesses'
          && transaction.action === 'checkBlockVerificationStatus') {
          const logs = JSON.parse(transaction.logs);
          const event = logs.events ? logs.events.find(ev => ev.event === 'blockVerified') : null;
          if (event && event.data && event.data.blockNumber && event.data.witnesses) {
            await ipc.send({ // eslint-disable-line
              to: DB_PLUGIN_NAME,
              action: DB_PLUGIN_ACTIONS.VERIFY_BLOCK,
              payload: event.data,
            });
          }
        }
      }
    }

    if (this.transactions.length > 0 || this.virtualTransactions.length > 0) {
      this.hash = this.calculateHash();
      // calculate the merkle root of the transactions' hashes and the transactions' database hashes
      const finalTransactions = this.transactions.concat(this.virtualTransactions);

      const merkleRoots = this.calculateMerkleRoot(finalTransactions);
      this.merkleRoot = merkleRoots.hash;
      this.databaseHash = merkleRoots.databaseHash;
    }
  }

  async processTransaction(ipc, jsVMTimeout, transaction, currentDatabaseHash) {
    const {
      sender,
      contract,
      action,
      payload,
    } = transaction;

    let results = null;
    let newCurrentDatabaseHash = currentDatabaseHash;

    // init the database hash for that transactions
    await ipc.send({ // eslint-disable-line
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.INIT_DATABASE_HASH,
      payload: newCurrentDatabaseHash,
    });

    if (sender && contract && action) {
      if (contract === 'contract' && (action === 'deploy' || action === 'update') && payload) {
        const authorizedAccountContractDeployment = ['null', 'steemsc', 'steem-peg'];

        if (authorizedAccountContractDeployment.includes(sender)) {
          results = await SmartContracts.deploySmartContract( // eslint-disable-line
            ipc, transaction, this.blockNumber, this.timestamp,
            this.refSteemBlockId, this.prevRefSteemBlockId, jsVMTimeout,
          );
        } else {
          results = { logs: { errors: ['the contract deployment is currently unavailable'] } };
        }
      } else if (contract === 'blockProduction' && payload) {
        // results = await bp.processTransaction(transaction); // eslint-disable-line
        results = { logs: { errors: ['blockProduction contract not available'] } };
      } else {
        results = await SmartContracts.executeSmartContract(// eslint-disable-line
          ipc, transaction, this.blockNumber, this.timestamp,
          this.refSteemBlockId, this.prevRefSteemBlockId, jsVMTimeout,
        );
      }
    } else {
      results = { logs: { errors: ['the parameters sender, contract and action are required'] } };
    }

    // get the database hash
    const res = await ipc.send({ // eslint-disable-line
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.GET_DATABASE_HASH,
      payload: {
      },
    });

    newCurrentDatabaseHash = res.payload;


    // console.log('transac logs', results.logs);
    transaction.addLogs(results.logs);
    transaction.executedCodeHash = results.executedCodeHash || ''; // eslint-disable-line
    transaction.databaseHash = newCurrentDatabaseHash; // eslint-disable-line

    transaction.calculateHash();
  }
}

module.exports.Block = Block;
