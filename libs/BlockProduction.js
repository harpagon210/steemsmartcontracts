const currency = require('currency.js');

const DB_PLUGIN_NAME = require('../plugins/Database.constants').PLUGIN_NAME;
const DB_PLUGIN_ACTIONS = require('../plugins/Database.constants').PLUGIN_ACTIONS;
const { CONSTANTS } = require('./BlockProduction.contants');

class BlockProduction {
  constructor(ipc) {
    this.ipc = ipc;
    this.results = {
      logs: {
        errors: [],
        events: [],
      },
    };
  }

  static initialize(database) {
    // get the tables created via the tokens contract
    const tokensTable = database.getCollection(`${CONSTANTS.TOKENS_CONTRACT_NAME}_${CONSTANTS.TOKENS_TABLE}`);
    const balancesTable = database.getCollection(`${CONSTANTS.TOKENS_CONTRACT_NAME}_${CONSTANTS.BALANCES_TABLE}`);

    if (tokensTable && balancesTable) {
      // create the necessary tables
      database.addCollection(`${CONSTANTS.CONTRACT_NAME}_${CONSTANTS.BP_PRODUCERS_TABLE}`, { indices: ['account', 'power'] });
      database.addCollection(`${CONSTANTS.CONTRACT_NAME}_${CONSTANTS.BP_STAKES_TABLE}`, { indices: ['account'] });
      database.addCollection(`${CONSTANTS.CONTRACT_NAME}_${CONSTANTS.BP_VOTES_TABLE}`, { indices: ['account'] });

      // add the contract to the database
      const bpContract = {
        name: CONSTANTS.CONTRACT_NAME,
        owner: 'null',
        code: '',
        codeHash: '',
        tables: [`${CONSTANTS.CONTRACT_NAME}_${CONSTANTS.BP_PRODUCERS_TABLE}`, `${CONSTANTS.CONTRACT_NAME}_${CONSTANTS.BP_STAKES_TABLE}`, `${CONSTANTS.CONTRACT_NAME}_${CONSTANTS.BP_VOTES_TABLE}`],
      };
      const contracts = database.getCollection('contracts');
      contracts.insert(bpContract);

      // create the utility token
      tokensTable.insert(CONSTANTS.UTILITY_TOKEN);

      // issue tokens to the initial accounts
      balancesTable.insert(CONSTANTS.INITIAL_BALANCES);
    } else {
      throw Object.assign({ error: 'MissingContractException', message: 'The tokens and accounts contracts are missing, you need to bootstrap them.' });
    }
  }

  async processTransaction(transaction) {
    try {
      const {
        action,
        payload,
      } = transaction;

      if (!CONSTANTS.AUTHORIZED_ACTIONS.includes(action)) return { logs: { errors: ['invalid action'] } };

      if (action === CONSTANTS.STAKE_ACTION && payload) {
        await this.stake(transaction);
      } else if (action === CONSTANTS.UNSTAKE_ACTION && payload) {
        await this.unstake(transaction);
      } else if (action === CONSTANTS.REGISTER_NODE_ACTION) {
        await this.registerNode(transaction);
      }

      return this.results;
    } catch (e) {
      console.error('ERROR DURING TRANSACTION PROCESSING: ', e);
      return { logs: { errors: [`${e.name}: ${e.message}`] } };
    }
  }

  async stake(transaction) {
    const {
      payload,
      refSteemBlockNumber,
      sender,
    } = transaction;

    const payloadObj = payload ? JSON.parse(payload) : {};
    const { quantity } = payloadObj;

    if (quantity && typeof quantity === 'number') {
      if (await this.subBalance(sender, quantity)) {
        await this.addStake(sender, quantity, refSteemBlockNumber);
        await this.updateVotes(sender, quantity);
      }
    }
  }

  async unstake(transaction) {
    const {
      payload,
      refSteemBlockNumber,
      sender,
    } = transaction;

    const payloadObj = payload ? JSON.parse(payload) : {};
    const { quantity } = payloadObj;

    if (quantity && typeof quantity === 'number') {
      if (await this.subStake(sender, quantity, refSteemBlockNumber)) {
        await this.addBalance(sender, quantity);
        await this.updateVotes(sender, -quantity);
      }
    }
  }

  async registerNode(transaction) {
    const {
      payload,
      sender,
    } = transaction;

    const payloadObj = payload ? JSON.parse(payload) : {};

    const { url } = payloadObj;

    if (url && typeof url === 'string') {
      let producer = await this.findOne(
        CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_PRODUCERS_TABLE, { account: sender },
      );

      // if the producer is already registered
      if (producer) {
        producer.url = url;
        await this.update(CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_PRODUCERS_TABLE, producer);
      } else {
        producer = {
          account: sender,
          power: 0,
          url,
        };
        await this.insert(CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_PRODUCERS_TABLE, producer);
      }
    }
  }

  async vote(transaction) {
    const {
      payload,
      sender,
    } = transaction;

    const payloadObj = payload ? JSON.parse(payload) : {};
    const { producer } = payloadObj;

    if (producer && typeof producer === 'string') {
      // check if producer exists
      const producerRec = await this.findOne(
        CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_PRODUCERS_TABLE, { account: producer },
      );

      if (this.assert(producerRec, 'producer does not exist')) {
        let votes = this.findOne(
          CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_VOTES_TABLE, { account: sender },
        );

        // if the sender already voted
        if (votes) {
          // a user can vote for NB_VOTES_ALLOWED BPs only
          if (this.assert(votes.votes.length < CONSTANTS.NB_VOTES_ALLOWED, `you can only vote for ${CONSTANTS.NB_VOTES_ALLOWED} block producers`)) {
            votes.votes.push(producer);
            await this.update(CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_VOTES_TABLE, votes);
          }
        } else {
          votes = {
            account: sender,
            votes: [producer],
          };
          await this.insert(CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_VOTES_TABLE, votes);
        }

        // update the rank of the producer that received the vote
        const votingPower = await this.getUserVotingPower(sender);
        await this.updateProducerRank(producer, votingPower);
      }
    }
  }

  async unvote(transaction) {
    const {
      payload,
      sender,
    } = transaction;

    const payloadObj = payload ? JSON.parse(payload) : {};
    const { producer } = payloadObj;

    if (producer && typeof producer === 'string') {
      const votes = await this.findOne(
        CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_VOTES_TABLE, { account: sender },
      );

      // if the sender already voted
      if (votes) {
        const index = votes.votes.indexOf(producer);
        if (index > -1) {
          votes.votes.splice(index, 1);

          // if no votes remaining, remove the record, otherwise update it
          if (votes.votes.length > 0) {
            this.update(CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_VOTES_TABLE, votes);
          } else {
            this.remove(CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_VOTES_TABLE, votes);
          }

          // upvote the ranking of the produver that lost the vote
          const votingPower = await this.getUserVotingPower(sender);
          await this.updateProducerRank(producer, -votingPower);
        }
      }
    }
  }

  async updateVotes(account, power) {
    const votes = await this.findOne(
      CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_VOTES_TABLE, { account },
    );

    if (votes) {
      for (let i = 0; i < votes.votes.length; i += 1) {
        await this.updateProducerRank(votes.votes[i], power); // eslint-disable-line
      }
    }
  }

  async getUserVotingPower(account) {
    const stake = await this.findOne(
      CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_STAKES_TABLE, { account },
    );

    return stake ? stake.power : 1;
  }

  async updateProducerRank(account, power) {
    const producer = await this.findOne(
      CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_PRODUCERS_TABLE, { account },
    );

    if (producer) {
      producer.power = BlockProduction.calculateBalance(producer.power, power, power > 0);
      await this.update(CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_PRODUCERS_TABLE, producer);
    }
  }

  // logging tools
  // emit an event that will be stored in the logs
  emit(event, data) {
    this.results.logs.events.push({ event, data });
  }

  // add an error that will be stored in the logs
  assert(condition, error) {
    if (!condition && typeof error === 'string') {
      this.results.logs.errors.push(error);
    }
    return condition;
  }

  // DB utils
  async find(contract, table, query, limit = 1000, offset = 0, index = '', descending = false) {
    const res = await this.ipc.send({
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.DFIND,
      payload: {
        table: `${contract}_${table}`,
        query,
        limit,
        offset,
        index,
        descending,
      },
    });

    return res.payload;
  }

  async findOne(contract, table, query) {
    const res = await this.ipc.send({
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.DFIND_ONE,
      payload: {
        table: `${contract}_${table}`,
        query,
      },
    });

    return res.payload;
  }

  async insert(contract, table, record) {
    const res = await this.ipc.send({
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.DINSERT,
      payload: {
        table: `${contract}_${table}`,
        record,
      },
    });

    return res.payload;
  }

  async remove(contract, table, record) {
    const res = await this.ipc.send({
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.DREMOVE,
      payload: {
        table: `${contract}_${table}`,
        record,
      },
    });

    return res.payload;
  }

  async update(contract, table, record) {
    const res = await this.ipc.send({
      to: DB_PLUGIN_NAME,
      action: DB_PLUGIN_ACTIONS.DUPDATE,
      payload: {
        table: `${contract}_${table}`,
        record,
      },
    });

    return res.payload;
  }

  async subStake(account, quantity, refSteemBlockNumber) {
    const balance = await this.findOne(
      CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_STAKES_TABLE, { account },
    );

    if (this.assert(balance !== null, 'balance does not exist')
      && this.assert(balance.balance >= quantity, 'overdrawn balance')) {
      // check it the account can unstake
      if (this.assert(refSteemBlockNumber - balance.stakedBlockNumber >= CONSTANTS.STAKE_WITHDRAWAL_COOLDOWN, `you can only unstake after a period of ${CONSTANTS.STAKE_WITHDRAWAL_COOLDOWN} blocks`)) {
        balance.balance = BlockProduction.calculateBalance(balance.balance, quantity, false);

        if (balance.balance <= 0) {
          await this.remove(CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_STAKES_TABLE, balance);
        } else {
          await this.update(CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_STAKES_TABLE, balance);
        }

        return true;
      }
    }

    return false;
  }

  async addStake(account, quantity, refSteemBlockNumber) {
    let balance = await this.findOne(
      CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_STAKES_TABLE, { account },
    );
    if (balance === null) {
      balance = {
        account,
        balance: quantity,
        stakedBlockNumber: refSteemBlockNumber,
      };

      await this.insert(CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_STAKES_TABLE, balance);
    } else {
      balance.balance = BlockProduction.calculateBalance(balance.balance, quantity, true);
      balance.stakedBlockNumber = refSteemBlockNumber;

      await this.update(CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_STAKES_TABLE, balance);
    }
  }

  async subBalance(account, quantity) {
    const balance = await this.findOne(CONSTANTS.TOKENS_CONTRACT_NAME, CONSTANTS.BALANCES_TABLE,
      { account, symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL });

    if (this.assert(balance !== null, 'balance does not exist')
      && this.assert(balance.balance >= quantity, 'overdrawn balance')) {
      balance.balance = BlockProduction.calculateBalance(balance.balance, quantity, false);

      if (balance.balance <= 0) {
        await this.remove(CONSTANTS.TOKENS_CONTRACT_NAME, CONSTANTS.BALANCES_TABLE, balance);
      } else {
        await this.update(CONSTANTS.TOKENS_CONTRACT_NAME, CONSTANTS.BALANCES_TABLE, balance);
      }

      return true;
    }

    return false;
  }

  async addBalance(account, quantity) {
    let balance = await this.findOne(CONSTANTS.TOKENS_CONTRACT_NAME, CONSTANTS.BALANCES_TABLE,
      { account, symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL });
    if (balance === null) {
      balance = {
        account,
        symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL,
        balance: quantity,
      };

      await this.insert(CONSTANTS.TOKENS_CONTRACT_NAME, CONSTANTS.BALANCES_TABLE, balance);
    } else {
      balance.balance = BlockProduction.calculateBalance(balance.balance, quantity, true);

      await this.update(CONSTANTS.TOKENS_CONTRACT_NAME, CONSTANTS.BALANCES_TABLE, balance);
    }
  }

  static calculateBalance(balance, quantity, add) {
    if (CONSTANTS.UTILITY_TOKEN_PRECISION === 0) {
      return add ? balance + quantity : balance - quantity;
    }

    return add
      ? currency(balance, { precision: CONSTANTS.UTILITY_TOKEN_PRECISION }).add(quantity)
      : currency(balance, { precision: CONSTANTS.UTILITY_TOKEN_PRECISION }).subtract(quantity);
  }

  static countDecimals(value) {
    if (Math.floor(value) === value) return 0;
    return value.toString().split('.')[1].length || 0;
  }
}

module.exports.BlockProduction = BlockProduction;
