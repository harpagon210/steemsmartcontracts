const currency = require('currency.js');

const DB_PLUGIN_NAME = require('../plugins/Database.constants').PLUGIN_NAME;
const DB_PLUGIN_ACTIONS = require('../plugins/Database.constants').PLUGIN_ACTIONS;
const { CONSTANTS } = require('./BlockProduction.contants');

class BlockProduction {
  constructor(ipc, refSteemBlockNumber) {
    this.ipc = ipc;
    this.refSteemBlockNumber = refSteemBlockNumber;
    this.results = {
      logs: {
        errors: [],
        events: [],
      },
    };
  }

  static initialize(database, genesisSteemBlock) {
    // get the tables created via the tokens contract
    const tokensTable = database.getCollection(`${CONSTANTS.TOKENS_CONTRACT_NAME}_${CONSTANTS.TOKENS_TABLE}`);
    const balancesTable = database.getCollection(`${CONSTANTS.TOKENS_CONTRACT_NAME}_${CONSTANTS.BALANCES_TABLE}`);

    if (tokensTable && balancesTable) {
      // create the necessary tables
      database.addCollection(`${CONSTANTS.CONTRACT_NAME}_${CONSTANTS.BP_PRODUCERS_TABLE}`, { indices: ['account', 'power'], disableMeta: true });
      database.addCollection(`${CONSTANTS.CONTRACT_NAME}_${CONSTANTS.BP_STAKES_TABLE}`, { indices: ['account'], disableMeta: true });
      database.addCollection(`${CONSTANTS.CONTRACT_NAME}_${CONSTANTS.BP_VOTES_TABLE}`, { indices: ['account'], disableMeta: true });
      const rewardsTable = database.addCollection(`${CONSTANTS.CONTRACT_NAME}_${CONSTANTS.BP_REWARDS_TABLE}`, { disableMeta: true });

      // add the contract to the database
      const bpContract = {
        name: CONSTANTS.CONTRACT_NAME,
        owner: 'null',
        code: '',
        codeHash: '',
        tables: [
          `${CONSTANTS.CONTRACT_NAME}_${CONSTANTS.BP_PRODUCERS_TABLE}`,
          `${CONSTANTS.CONTRACT_NAME}_${CONSTANTS.BP_STAKES_TABLE}`,
          `${CONSTANTS.CONTRACT_NAME}_${CONSTANTS.BP_VOTES_TABLE}`,
          `${CONSTANTS.CONTRACT_NAME}_${CONSTANTS.BP_REWARDS_TABLE}`,
        ],
      };
      const contracts = database.getCollection('contracts');
      contracts.insert(bpContract);

      // calculate rewards parameters
      const totalRewards = CONSTANTS.UTILITY_TOKEN_INITIAL_SUPPLY
        * CONSTANTS.INITIAL_INFLATION_RATE
        / CONSTANTS.NB_INFLATION_DECREASE_PER_YEAR;
      const rewardsPerBlockPerProducer = BlockProduction
        .calculateRewardsPerBlockPerProducer(totalRewards);

      const rewardsParams = {
        lastInflationCalculation: genesisSteemBlock,
        inflationRate: CONSTANTS.INITIAL_INFLATION_RATE,
        rewardsPerBlockPerProducer,
        proposalSystemBalance: 0,
      };

      rewardsTable.insert(rewardsParams);

      // create the utility token
      tokensTable.insert(CONSTANTS.UTILITY_TOKEN);

      // issue tokens to the initial accounts
      balancesTable.insert(CONSTANTS.INITIAL_BALANCES);
    } else {
      throw Object.assign({ error: 'MissingContractException', message: 'The tokens and accounts contracts are missing, you need to bootstrap them.' });
    }
  }

  static calculateNewRewards(rewardsPerBlockPerProducer) {
    return currency(
      rewardsPerBlockPerProducer,
      { precision: CONSTANTS.UTILITY_TOKEN_PRECISION },
    ).multiply(CONSTANTS.NB_BLOCKS_UPDATE_INFLATION_RATE).value;
  }

  static calculateRewardsPerBlockPerProducer(totalRewards) {
    const rewardsPerBlock = totalRewards / CONSTANTS.NB_BLOCKS_UPDATE_INFLATION_RATE;
    const nbUnitsToReward = CONSTANTS.NB_BLOCK_PRODUCERS + CONSTANTS.PROPOSAL_SYSTEM_REWARD_UNITS;

    let rewardsPerBlockPerBP = currency(
      rewardsPerBlock,
      { precision: CONSTANTS.UTILITY_TOKEN_PRECISION },
    ).divide(nbUnitsToReward).value;

    const calculatedRewardsPerBlock = currency(
      rewardsPerBlockPerBP,
      { precision: CONSTANTS.UTILITY_TOKEN_PRECISION },
    ).multiply(nbUnitsToReward).value;

    if (calculatedRewardsPerBlock > rewardsPerBlock) {
      // console.log('adjusting rewardsPerBlockPerBP');
      rewardsPerBlockPerBP = currency(
        rewardsPerBlockPerBP,
        { precision: CONSTANTS.UTILITY_TOKEN_PRECISION },
      ).subtract(CONSTANTS.MINIMUM_TOKEN_VALUE).value;
    }

    return rewardsPerBlockPerBP;
  }

  async calculateRewardsParameters() {
    // get the rewards params
    const rewardsParams = await this.findOne(
      CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_REWARDS_TABLE, {},
    );

    // check if we need to calculate the new inflation
    if (rewardsParams && (this.refSteemBlockNumber - rewardsParams.lastInflationCalculation
        > CONSTANTS.NB_BLOCKS_UPDATE_INFLATION_RATE)) {
      // get current supply
      const token = await this.findOne(CONSTANTS.TOKENS_CONTRACT_NAME, CONSTANTS.TOKENS_TABLE, {
        symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL,
      });

      // calculate the new inflation rate if needed
      let inflationRate = rewardsParams.inflationRate; // eslint-disable-line
      if (inflationRate > CONSTANTS.MINIMUM_INFLATION_RATE) {
        inflationRate = currency(
          rewardsParams.inflationRate,
          { precision: CONSTANTS.UTILITY_TOKEN_PRECISION },
        ).subtract(CONSTANTS.INFLATION_RATE_DECREASING_RATE);
      }

      // calculate the new rewards that will be distributed
      const totalRewards = token.supply * inflationRate / CONSTANTS.NB_INFLATION_DECREASE_PER_YEAR;

      // calculate the rewards per block per producer for the new year
      rewardsParams.rewardsPerBlockPerProducer = BlockProduction
        .calculateRewardsPerBlockPerProducer(totalRewards);
      rewardsParams.inflationRate = inflationRate;
      rewardsParams.lastInflationCalculation = this.refSteemBlockNumber;

      await this.update(
        CONSTANTS.CONTRACT_NAME,
        CONSTANTS.BP_REWARDS_TABLE,
        rewardsParams,
      );
    }
  }

  async rewardBlockProducers() {
    // update the rewards parameters if needed
    await this.calculateRewardsParameters();

    // get the top producers
    const producers = await this.find(
      CONSTANTS.CONTRACT_NAME,
      CONSTANTS.BP_PRODUCERS_TABLE,
      {},
      CONSTANTS.NB_BLOCK_PRODUCERS,
      0,
      'power',
      true,
    );

    // if there are producers
    if (producers.length > 0) {
      // get the rewards per block
      const rewardsParams = await this.findOne(
        CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_REWARDS_TABLE, {},
      );

      let totalDistributedTokens = 0;

      // reward the producers
      for (let index = 0; index < producers.length; index += 1) {
        const producer = producers[index];

        // add the rewards to the producer's tokens balances
        await this.addBalance(producer.account, rewardsParams.rewardsPerBlockPerProducer); // eslint-disable-line

        // update the total od distributed tokens
        totalDistributedTokens = BlockProduction.calculateBalance(
          totalDistributedTokens, rewardsParams.rewardsPerBlockPerProducer,
        ).value;
      }

      // "reward" the proposal system
      let tokenToAddProposalSystem = 0;
      for (let index = 0; index < CONSTANTS.PROPOSAL_SYSTEM_REWARD_UNITS; index += 1) {
        tokenToAddProposalSystem = BlockProduction.calculateBalance(tokenToAddProposalSystem, rewardsParams.rewardsPerBlockPerProducer);
      }
      // add the rewards to the proposal system balance (hold by the 'null' account)
      await this.addBalance('null', tokenToAddProposalSystem); // eslint-disable-line
      rewardsParams.proposalSystemBalance = BlockProduction.calculateBalance(
        rewardsParams.proposalSystemBalance, tokenToAddProposalSystem
      ).value;

      totalDistributedTokens = BlockProduction.calculateBalance(
        totalDistributedTokens, tokenToAddProposalSystem,
      ).value;
      
      await this.update(
        CONSTANTS.CONTRACT_NAME,
        CONSTANTS.BP_REWARDS_TABLE,
        rewardsParams,
      );

      // get current supply of the token
      const token = await this.findOne(
        CONSTANTS.TOKENS_CONTRACT_NAME,
        CONSTANTS.TOKENS_TABLE, {
          symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL,
        },
      );

      // update the total supply of the token
      token.supply = BlockProduction.calculateBalance(
        token.supply, totalDistributedTokens,
      ).value;

      await this.update(
        CONSTANTS.TOKENS_CONTRACT_NAME,
        CONSTANTS.TOKENS_TABLE,
        token,
      );
    }
  }

  async processTransaction(transaction) {
    try {
      const {
        action,
        payload,
      } = transaction;

      this.results = {
        logs: {
          errors: [],
          events: [],
        },
      };

      if (!CONSTANTS.AUTHORIZED_ACTIONS.includes(action)) return { logs: { errors: ['invalid action'] } };

      if (action === CONSTANTS.STAKE_ACTION && payload) {
        await this.stake(transaction);
      } else if (action === CONSTANTS.UNSTAKE_ACTION && payload) {
        await this.unstake(transaction);
      } else if (action === CONSTANTS.REGISTER_NODE_ACTION) {
        await this.registerNode(transaction);
      } else if (action === CONSTANTS.VOTE) {
        await this.vote(transaction);
      } else if (action === CONSTANTS.UNVOTE) {
        await this.unvote(transaction);
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
        let votes = await this.findOne(
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

    return stake ? stake.balance : 0;
  }

  async updateProducerRank(account, power) {
    const producer = await this.findOne(
      CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_PRODUCERS_TABLE, { account },
    );

    if (producer) {
      producer.power = BlockProduction.calculateBalance(producer.power, power);
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
        balance.balance = BlockProduction.calculateBalance(balance.balance, -quantity);

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
      balance.balance = BlockProduction.calculateBalance(balance.balance, quantity);
      balance.stakedBlockNumber = refSteemBlockNumber;

      await this.update(CONSTANTS.CONTRACT_NAME, CONSTANTS.BP_STAKES_TABLE, balance);
    }
  }

  async subBalance(account, quantity) {
    const balance = await this.findOne(CONSTANTS.TOKENS_CONTRACT_NAME, CONSTANTS.BALANCES_TABLE,
      { account, symbol: CONSTANTS.UTILITY_TOKEN_SYMBOL });

    if (this.assert(balance !== null, 'balance does not exist')
      && this.assert(balance.balance >= quantity, 'overdrawn balance')) {
      balance.balance = BlockProduction.calculateBalance(balance.balance, -quantity);

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
      balance.balance = BlockProduction.calculateBalance(balance.balance, quantity);

      await this.update(CONSTANTS.TOKENS_CONTRACT_NAME, CONSTANTS.BALANCES_TABLE, balance);
    }
  }

  static calculateBalance(balance, quantity) {
    if (CONSTANTS.UTILITY_TOKEN_PRECISION === 0) {
      return balance + quantity;
    }

    return quantity >= 0
      ? currency(balance, { precision: CONSTANTS.UTILITY_TOKEN_PRECISION }).add(quantity)
      : currency(balance, { precision: CONSTANTS.UTILITY_TOKEN_PRECISION }).subtract(-quantity);
  }

  static countDecimals(value) {
    if (Math.floor(value) === value) return 0;
    return value.toString().split('.')[1].length || 0;
  }
}

module.exports.BlockProduction = BlockProduction;
