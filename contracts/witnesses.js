/* eslint-disable no-await-in-loop */
/* global actions, api */

const NB_APPROVALS_ALLOWED = 30;
const NB_TOP_WITNESSES = 4;
const NB_BACKUP_WITNESSES = 1;
const NB_WITNESSES = NB_TOP_WITNESSES + NB_BACKUP_WITNESSES;
const NB_WITNESSES_SIGNATURES_REQUIRED = 3;
const MAX_ROUNDS_MISSED_IN_A_ROW = 3; // after that the witness is disabled
const MAX_ROUND_PROPOSITION_WAITING_PERIOD = 100; // 10 blocks
const NB_TOKENS_TO_REWARD = '0.01902587';
const NB_TOKENS_NEEDED_BEFORE_REWARDING = '0.09512935';
// eslint-disable-next-line no-template-curly-in-string
const UTILITY_TOKEN_SYMBOL = "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'";
// eslint-disable-next-line no-template-curly-in-string
const UTILITY_TOKEN_PRECISION = '${CONSTANTS.UTILITY_TOKEN_PRECISION}$';
// eslint-disable-next-line no-template-curly-in-string
const UTILITY_TOKEN_MIN_VALUE = '${CONSTANTS.UTILITY_TOKEN_MIN_VALUE}$';

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('witnesses');

  if (tableExists === false) {
    await api.db.createTable('witnesses', ['approvalWeight']);
    await api.db.createTable('approvals', ['from', 'to']);
    await api.db.createTable('accounts', ['account']);
    await api.db.createTable('schedules');
    await api.db.createTable('params');

    const params = {
      totalApprovalWeight: '0',
      numberOfApprovedWitnesses: 0,
      lastVerifiedBlockNumber: 0,
      round: 0,
      lastBlockRound: 0,
      currentWitness: null,
      lastBlockWitnessChange: 0,
      lastWitnesses: [],
    };

    await api.db.insert('params', params);
  }

  // TODO: cleanup when launching for mainnet / next update
  const witnesses = await api.db.find('witnesses', { });

  for (let index = 0; index < witnesses.length; index += 1) {
    const witness = witnesses[index];
    witness.missedRounds = 0;
    witness.missedRoundsInARow = 0;
    witness.enabled = true;
    await api.db.update('witnesses', witness);
  }

  const schedules = await api.db.find('schedules', { });

  for (let index = 0; index < schedules.length; index += 1) {
    const schedule = schedules[index];
    await api.db.remove('schedules', schedule);
  }

  const params = await api.db.findOne('params', {});
  params.currentWitness = null;
  params.lastWitnesses = [];
  await api.db.update('params', params);
};

const updateWitnessRank = async (witness, approvalWeight) => {
  // check if witness exists
  const witnessRec = await api.db.findOne('witnesses', { account: witness });

  if (witnessRec) {
    // update witness approvalWeight
    const oldApprovalWeight = witnessRec.approvalWeight.$numberDecimal;
    witnessRec.approvalWeight.$numberDecimal = api.BigNumber(
      witnessRec.approvalWeight.$numberDecimal,
    )
      .plus(approvalWeight)
      .toFixed(UTILITY_TOKEN_PRECISION);

    await api.db.update('witnesses', witnessRec);

    const params = await api.db.findOne('params', {});

    // update totalApprovalWeight
    params.totalApprovalWeight = api.BigNumber(params.totalApprovalWeight)
      .plus(approvalWeight)
      .toFixed(UTILITY_TOKEN_PRECISION);

    // update numberOfApprovedWitnesses
    if (api.BigNumber(oldApprovalWeight).eq(0)
      && api.BigNumber(witnessRec.approvalWeight.$numberDecimal).gt(0)) {
      params.numberOfApprovedWitnesses += 1;
    } else if (api.BigNumber(oldApprovalWeight).gt(0)
      && api.BigNumber(witnessRec.approvalWeight.$numberDecimal).eq(0)) {
      params.numberOfApprovedWitnesses -= 1;
    }

    await api.db.update('params', params);
  }
};

actions.updateWitnessesApprovals = async (payload) => {
  const { account, callingContractInfo } = payload;

  if (callingContractInfo === undefined) return;
  if (callingContractInfo.name !== 'tokens') return;

  const acct = await api.db.findOne('accounts', { account });
  if (acct !== null) {
    // calculate approval weight of the account
    const balance = await api.db.findOneInTable('tokens', 'balances', { account, symbol: UTILITY_TOKEN_SYMBOL });
    let approvalWeight = 0;
    if (balance && balance.stake) {
      approvalWeight = balance.stake;
    }

    if (balance && balance.pendingUnstake) {
      approvalWeight = api.BigNumber(approvalWeight)
        .plus(balance.pendingUnstake)
        .toFixed(UTILITY_TOKEN_PRECISION);
    }

    if (balance && balance.delegationsIn) {
      approvalWeight = api.BigNumber(approvalWeight)
        .plus(balance.delegationsIn)
        .toFixed(UTILITY_TOKEN_PRECISION);
    }

    const oldApprovalWeight = acct.approvalWeight;

    const deltaApprovalWeight = api.BigNumber(approvalWeight)
      .minus(oldApprovalWeight)
      .toFixed(UTILITY_TOKEN_PRECISION);

    acct.approvalWeight = approvalWeight;

    if (!api.BigNumber(deltaApprovalWeight).eq(0)) {
      await api.db.update('accounts', acct);

      const approvals = await api.db.find('approvals', { from: account });

      for (let index = 0; index < approvals.length; index += 1) {
        const approval = approvals[index];
        await updateWitnessRank(approval.to, deltaApprovalWeight);
      }
    }
  }
};

actions.register = async (payload) => {
  const {
    IP, RPCPort, P2PPort, signingKey, enabled, isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'active key required')
    && api.assert(IP && typeof IP === 'string' && api.validator.isIP(IP), 'IP is invalid')
    && api.assert(RPCPort && Number.isInteger(RPCPort) && RPCPort >= 0 && RPCPort <= 65535, 'RPCPort must be an integer between 0 and 65535')
    && api.assert(P2PPort && Number.isInteger(P2PPort) && P2PPort >= 0 && P2PPort <= 65535, 'P2PPort must be an integer between 0 and 65535')
    && api.assert(api.validator.isAlphanumeric(signingKey) && signingKey.length === 53, 'invalid signing key')
    && api.assert(typeof enabled === 'boolean', 'enabled must be a boolean')) {
    // check if there is already a witness with the same signing key
    let witness = await api.db.findOne('witnesses', { signingKey });

    if (api.assert(witness === null || witness.account === api.sender, 'a witness is already using this signing key')) {
      // check if there is already a witness with the same IP/Port
      witness = await api.db.findOne('witnesses', { IP, P2PPort });

      if (api.assert(witness === null || witness.account === api.sender, 'a witness is already using this IP/Port')) {
        witness = await api.db.findOne('witnesses', { account: api.sender });

        // if the witness is already registered
        if (witness) {
          witness.IP = IP;
          witness.RPCPort = RPCPort;
          witness.P2PPort = P2PPort;
          witness.signingKey = signingKey;
          witness.enabled = enabled;
          await api.db.update('witnesses', witness);
        } else {
          witness = {
            account: api.sender,
            approvalWeight: { $numberDecimal: '0' },
            signingKey,
            IP,
            RPCPort,
            P2PPort,
            enabled,
            missedRounds: 0,
            missedRoundsInARow: 0,
            verifiedRounds: 0,
            lastRoundVerified: null,
            lastBlockVerified: null,
          };
          await api.db.insert('witnesses', witness);
        }
      }
    }
  }
};

actions.approve = async (payload) => {
  const { witness } = payload;

  if (api.assert(witness && typeof witness === 'string' && witness.length >= 3 && witness.length <= 16, 'invalid witness account')) {
    // check if witness exists
    const witnessRec = await api.db.findOne('witnesses', { account: witness });

    if (api.assert(witnessRec, 'witness does not exist')) {
      let acct = await api.db.findOne('accounts', { account: api.sender });

      if (acct === null) {
        acct = {
          account: api.sender,
          approvals: 0,
          approvalWeight: { $numberDecimal: '0' },
        };

        acct = await api.db.insert('accounts', acct);
      }

      // a user can approve NB_APPROVALS_ALLOWED witnesses only
      if (api.assert(acct.approvals < NB_APPROVALS_ALLOWED, `you can only approve ${NB_APPROVALS_ALLOWED} witnesses`)) {
        let approval = await api.db.findOne('approvals', { from: api.sender, to: witness });

        if (api.assert(approval === null, 'you already approved this witness')) {
          approval = {
            from: api.sender,
            to: witness,
          };
          await api.db.insert('approvals', approval);

          // update the rank of the witness that received the approval
          const balance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: UTILITY_TOKEN_SYMBOL });
          let approvalWeight = 0;
          if (balance && balance.stake) {
            approvalWeight = balance.stake;
          }

          if (balance && balance.pendingUnstake) {
            approvalWeight = api.BigNumber(approvalWeight)
              .plus(balance.pendingUnstake)
              .toFixed(UTILITY_TOKEN_PRECISION);
          }

          if (balance && balance.delegationsIn) {
            approvalWeight = api.BigNumber(approvalWeight)
              .plus(balance.delegationsIn)
              .toFixed(UTILITY_TOKEN_PRECISION);
          }

          acct.approvals += 1;
          acct.approvalWeight = approvalWeight;

          await api.db.update('accounts', acct);

          await updateWitnessRank(witness, approvalWeight);
        }
      }
    }
  }
};

actions.disapprove = async (payload) => {
  const { witness } = payload;

  if (api.assert(witness && typeof witness === 'string' && witness.length >= 3 && witness.length <= 16, 'invalid witness account')) {
    // check if witness exists
    const witnessRec = await api.db.findOne('witnesses', { account: witness });


    if (api.assert(witnessRec, 'witness does not exist')) {
      let acct = await api.db.findOne('accounts', { account: api.sender });

      if (acct === null) {
        acct = {
          account: api.sender,
          approvals: 0,
          approvalWeight: { $numberDecimal: '0' },
        };

        await api.db.insert('accounts', acct);
      }

      // a user can only disapprove if it already approved a witness
      if (api.assert(acct.approvals > 0, 'no approvals found')) {
        const approval = await api.db.findOne('approvals', { from: api.sender, to: witness });

        if (api.assert(approval !== null, 'you have not approved this witness')) {
          await api.db.remove('approvals', approval);

          const balance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: UTILITY_TOKEN_SYMBOL });
          let approvalWeight = 0;
          if (balance && balance.stake) {
            approvalWeight = balance.stake;
          }

          if (balance && balance.delegationsIn) {
            approvalWeight = api.BigNumber(approvalWeight)
              .plus(balance.delegationsIn)
              .toFixed(UTILITY_TOKEN_PRECISION);
          }

          acct.approvals -= 1;
          acct.approvalWeight = approvalWeight;

          await api.db.update('accounts', acct);

          // update the rank of the witness that received the disapproval
          await updateWitnessRank(witness, `-${approvalWeight}`);
        }
      }
    }
  }
};

const changeCurrentWitness = async () => {
  const params = await api.db.findOne('params', {});
  const {
    currentWitness,
    totalApprovalWeight,
    lastWitnesses,
    lastBlockRound,
    round,
  } = params;

  let witnessFound = false;
  // get a deterministic random weight
  const random = api.random();
  const randomWeight = api.BigNumber(totalApprovalWeight)
    .times(random)
    .toFixed(UTILITY_TOKEN_PRECISION);

  let offset = 0;
  let accWeight = 0;

  let witnesses = await api.db.find(
    'witnesses',
    {
      approvalWeight: {
        $gt: {
          $numberDecimal: '0',
        },
      },
    },
    100, // limit
    offset, // offset
    [
      { index: 'approvalWeight', descending: true },
    ],
  );
  // get the witnesses on schedule
  const schedules = await api.db.find('schedules', { round });

  const previousRoundWitness = lastWitnesses.length > 1 ? lastWitnesses[lastWitnesses.length - 2] : '';

  // get the current schedule
  const schedule = await api.db
    .findOne('schedules', { round, witness: currentWitness, blockNumber: lastBlockRound });

  do {
    for (let index = 0; index < witnesses.length; index += 1) {
      const witness = witnesses[index];

      accWeight = api.BigNumber(accWeight)
        .plus(witness.approvalWeight.$numberDecimal)
        .toFixed(UTILITY_TOKEN_PRECISION);

      // if the witness is enabled
      // and different from the scheduled one from the previous round
      // and different from an already scheduled witness for this round
      if (witness.enabled === true
        && witness.account !== previousRoundWitness
        && schedules.find(s => s.witness === witness.account) === undefined
        && api.BigNumber(randomWeight).lte(accWeight)) {
        api.debug(`changed current witness from ${schedule.witness} to ${witness.account}`);
        schedule.witness = witness.account;
        await api.db.update('schedules', schedule);
        params.currentWitness = witness.account;
        params.lastWitnesses.push(witness.account);
        params.lastBlockWitnessChange = api.blockNumber;
        await api.db.update('params', params);

        // update the current witness
        const scheduledWitness = await api.db.findOne('witnesses', { account: currentWitness });
        scheduledWitness.missedRounds += 1;
        scheduledWitness.missedRoundsInARow += 1;

        // disable the witness if missed MAX_ROUNDS_MISSED_IN_A_ROW
        if (scheduledWitness.missedRoundsInARow >= MAX_ROUNDS_MISSED_IN_A_ROW) {
          scheduledWitness.missedRoundsInARow = 0;
          scheduledWitness.enabled = false;
        }

        await api.db.update('witnesses', scheduledWitness);
        witnessFound = true;
        api.emit('currentWitnessChanged', { });
        break;
      }
    }

    if (witnessFound === false) {
      offset += 100;
      witnesses = await api.db.find(
        'witnesses',
        {
          approvalWeight: {
            $gt: {
              $numberDecimal: '0',
            },
          },
        },
        100, // limit
        offset, // offset
        [
          { index: 'approvalWeight', descending: true },
        ],
      );
    }
  } while (witnesses.length > 0 && witnessFound === false);

  if (witnessFound === false) {
    api.debug('no backup witness was found, interchanging witnesses within the current schedule');
    for (let index = 0; index < schedules.length - 1; index += 1) {
      const sched = schedules[index];
      const newWitness = sched.witness;
      if (newWitness !== previousRoundWitness) {
        api.debug(`changed current witness from ${currentWitness} to ${newWitness}`);
        schedule.witness = newWitness;
        await api.db.update('schedules', schedule);
        sched.witness = currentWitness;
        await api.db.update('schedules', sched);
        params.currentWitness = newWitness;
        params.lastWitnesses.push(newWitness);
        params.lastBlockWitnessChange = api.blockNumber;
        await api.db.update('params', params);

        // update the current witness
        const scheduledWitness = await api.db.findOne('witnesses', { account: currentWitness });
        scheduledWitness.missedRounds += 1;
        scheduledWitness.missedRoundsInARow += 1;

        // disable the witness if missed MAX_ROUNDS_MISSED_IN_A_ROW
        if (scheduledWitness.missedRoundsInARow >= MAX_ROUNDS_MISSED_IN_A_ROW) {
          scheduledWitness.missedRoundsInARow = 0;
          scheduledWitness.enabled = false;
        }

        await api.db.update('witnesses', scheduledWitness);
        api.emit('currentWitnessChanged', { });
        break;
      }
    }
  }
};

const manageWitnessesSchedule = async () => {
  if (api.sender !== 'null') return;

  const params = await api.db.findOne('params', {});
  const {
    numberOfApprovedWitnesses,
    totalApprovalWeight,
    lastVerifiedBlockNumber,
    lastBlockRound,
    lastBlockWitnessChange,
  } = params;

  // check the current schedule
  const currentBlock = lastVerifiedBlockNumber + 1;
  let schedule = await api.db.findOne('schedules', { blockNumber: currentBlock });

  // if the current block has not been scheduled already we have to create a new schedule
  if (schedule === null) {
    api.debug('calculating new schedule');
    schedule = [];

    // there has to be enough top witnesses to start a schedule
    if (numberOfApprovedWitnesses >= NB_WITNESSES) {
      /*
        example:
        -> total approval weight = 10,000
        ->  approval weights:
          acct A : 1000 (from 0 to 1000)
          acct B : 900 (from 1000.00000001 to 1900)
          acct C : 800 (from 1900.00000001 to 2700)
          acct D : 700 (from 2700.00000001 to 3400)
          ...
          acct n : from ((n-1).upperBound + 0.00000001) to 10,000)

          -> total approval weight top witnesses (A-D) = 3,400
          -> pick up backup witnesses (E-n): weight range:
            from 3,400.0000001 to 10,000
      */

      // get a deterministic random weight
      const random = api.random();
      let randomWeight = null;

      let offset = 0;
      let accWeight = 0;

      let witnesses = await api.db.find(
        'witnesses',
        {
          approvalWeight: {
            $gt: {
              $numberDecimal: '0',
            },
          },
        },
        100, // limit
        offset, // offset
        [
          { index: 'approvalWeight', descending: true },
        ],
      );

      do {
        for (let index = 0; index < witnesses.length; index += 1) {
          const witness = witnesses[index];

          // calculate a random weight if not done yet
          if (schedule.length >= NB_TOP_WITNESSES
            && randomWeight === null) {
            const min = api.BigNumber(accWeight)
              .plus(UTILITY_TOKEN_MIN_VALUE);

            randomWeight = api.BigNumber(totalApprovalWeight)
              .minus(min)
              .times(random)
              .plus(min)
              .toFixed(UTILITY_TOKEN_PRECISION);
          }

          accWeight = api.BigNumber(accWeight)
            .plus(witness.approvalWeight.$numberDecimal)
            .toFixed(UTILITY_TOKEN_PRECISION);

          // if the witness is enabled
          if (witness.enabled === true) {
            // if we haven't found all the top witnesses yet
            if (schedule.length < NB_TOP_WITNESSES
              || api.BigNumber(randomWeight).lte(accWeight)) {
              schedule.push({
                witness: witness.account,
                blockNumber: null,
              });
            }
          }

          if (schedule.length >= NB_WITNESSES) {
            index = witnesses.length;
          }
        }

        if (schedule.length < NB_WITNESSES) {
          offset += 100;
          witnesses = await api.db.find(
            'witnesses',
            {
              approvalWeight: {
                $gt: {
                  $numberDecimal: '0',
                },
              },
            },
            100, // limit
            offset, // offset
            [
              { index: 'approvalWeight', descending: true },
            ],
          );
        }
      } while (witnesses.length > 0 && schedule.length < NB_WITNESSES);
    }

    // if there are enough witnesses scheduled
    if (schedule.length === NB_WITNESSES) {
      // shuffle the witnesses
      let j; let x;
      for (let i = schedule.length - 1; i > 0; i -= 1) {
        const random = api.random();
        j = Math.floor(random * (i + 1));
        x = schedule[i];
        schedule[i] = schedule[j];
        schedule[j] = x;
      }

      // eslint-disable-next-line
      let lastWitnesses = params.lastWitnesses;
      const previousRoundWitness = lastWitnesses.length > 0 ? lastWitnesses[lastWitnesses.length - 1] : '';

      if (lastWitnesses.length >= NB_WITNESSES) {
        lastWitnesses = [];
      }

      // make sure the last witness of this round is not one of the last witnesses scheduled
      const lastWitness = schedule[schedule.length - 1].witness;
      if (lastWitnesses.includes(lastWitness) || previousRoundWitness === lastWitness) {
        for (let i = 0; i < schedule.length; i += 1) {
          if (!lastWitnesses.includes(schedule[i].witness)
            && schedule[i].witness !== previousRoundWitness) {
            const thisWitness = schedule[i].witness;
            schedule[i].witness = lastWitness;
            schedule[schedule.length - 1].witness = thisWitness;
            break;
          }
        }
      }

      // make sure the witness of the previous round is not the first witness of this round
      if (schedule[0].witness === previousRoundWitness) {
        const firstWitness = schedule[0].witness;
        const secondWitness = schedule[1].witness;
        schedule[0].witness = secondWitness;
        schedule[1].witness = firstWitness;
      }

      // block number attribution
      // eslint-disable-next-line prefer-destructuring
      let blockNumber = lastVerifiedBlockNumber === 0
        ? api.blockNumber
        : lastVerifiedBlockNumber + 1;
      params.round += 1;
      for (let i = 0; i < schedule.length; i += 1) {
        // the block number that the witness will have to "sign"
        schedule[i].blockNumber = blockNumber;
        schedule[i].round = params.round;
        api.debug(`scheduled witness ${schedule[i].witness} for block ${blockNumber} (round ${params.round})`);
        await api.db.insert('schedules', schedule[i]);
        blockNumber += 1;
      }

      if (lastVerifiedBlockNumber === 0) {
        params.lastVerifiedBlockNumber = api.blockNumber - 1;
      }
      const lastWitnessRoundSchedule = schedule[schedule.length - 1];
      params.lastBlockRound = lastWitnessRoundSchedule.blockNumber;
      params.currentWitness = lastWitnessRoundSchedule.witness;
      lastWitnesses.push(lastWitnessRoundSchedule.witness);
      params.lastWitnesses = lastWitnesses;
      params.lastBlockWitnessChange = params.lastBlockRound;
      await api.db.update('params', params);
      api.emit('newSchedule', { });
    }
  } else if (api.blockNumber - lastBlockWitnessChange >= MAX_ROUND_PROPOSITION_WAITING_PERIOD) {
    // otherwise we change the current witness if it has not proposed the round in time
    await changeCurrentWitness();
  }
};

actions.proposeRound = async (payload) => {
  const {
    roundHash,
    isSignedWithActiveKey,
    signatures,
  } = payload;

  if (isSignedWithActiveKey === true
    && roundHash && typeof roundHash === 'string' && roundHash.length === 64
    && Array.isArray(signatures)
    && signatures.length <= NB_WITNESSES
    && signatures.length >= NB_WITNESSES_SIGNATURES_REQUIRED) {
    const params = await api.db.findOne('params', {});
    const {
      lastVerifiedBlockNumber,
      round,
      lastBlockRound,
      currentWitness,
    } = params;
    let currentBlock = lastVerifiedBlockNumber + 1;
    let calculatedRoundHash = '';

    // the sender must be the current witness of the round
    if (api.sender === currentWitness) {
      // calculate round hash
      while (currentBlock <= lastBlockRound) {
        const block = await api.db.getBlockInfo(currentBlock);

        if (block !== null) {
          calculatedRoundHash = api.SHA256(`${calculatedRoundHash}${block.hash}`);
        } else {
          calculatedRoundHash = '';
          break;
        }

        currentBlock += 1;
      }

      if (calculatedRoundHash !== '' && calculatedRoundHash === roundHash) {
        // get the witnesses on schedule
        const schedules = await api.db.find('schedules', { round });

        // check the signatures
        let signaturesChecked = 0;
        const verifiedBlockInformation = [];
        const currentWitnessInfo = await api.db.findOne('witnesses', { account: currentWitness });
        const currentWitnessSignature = signatures.find(s => s[0] === currentWitness);
        for (let index = 0; index < schedules.length; index += 1) {
          const scheduledWitness = schedules[index];
          const witness = await api.db.findOne('witnesses', { account: scheduledWitness.witness });
          if (witness !== null) {
            const signature = signatures.find(s => s[0] === witness.account);
            if (signature) {
              if (api.checkSignature(
                calculatedRoundHash, signature[1], witness.signingKey, true,
              )) {
                api.debug(`witness ${witness.account} signed round ${round}`);
                signaturesChecked += 1;
              }
            }

            // the current witness will show as the witness that verified the blocks from the round
            verifiedBlockInformation.push(
              {
                blockNumber: scheduledWitness.blockNumber,
                witness: currentWitness,
                signingKey: currentWitnessInfo.signingKey,
                roundSignature: currentWitnessSignature[1],
                round,
                roundHash,
              },
            );
          }
        }

        if (signaturesChecked >= NB_WITNESSES_SIGNATURES_REQUIRED) {
          // mark blocks of the verified round as verified by the current witness
          for (let index = 0; index < verifiedBlockInformation.length; index += 1) {
            await api.verifyBlock(verifiedBlockInformation[index]);
          }

          // get contract balance
          const contractBalance = await api.db.findOneInTable('tokens', 'contractsBalances', { account: 'witnesses', symbol: UTILITY_TOKEN_SYMBOL });
          let rewardWitnesses = false;

          if (contractBalance
            && api.BigNumber(contractBalance.balance).gte(NB_TOKENS_NEEDED_BEFORE_REWARDING)) {
            rewardWitnesses = true;
          }

          // remove the schedules
          for (let index = 0; index < schedules.length; index += 1) {
            const schedule = schedules[index];
            // reward the witness that help verifying this round
            if (rewardWitnesses === true) {
              await api.executeSmartContract('tokens', 'stakeFromContract', { to: schedule.witness, symbol: UTILITY_TOKEN_SYMBOL, quantity: NB_TOKENS_TO_REWARD });
            }
            await api.db.remove('schedules', schedule);
          }

          params.currentWitness = null;
          params.lastVerifiedBlockNumber = lastBlockRound;
          await api.db.update('params', params);

          // update information for the current witness
          const witness = await api.db.findOne('witnesses', { account: currentWitness });
          witness.missedRoundsInARow = 0;
          witness.lastRoundVerified = round;
          witness.lastBlockVerified = lastBlockRound;
          witness.verifiedRounds += 1;
          await api.db.update('witnesses', witness);

          // calculate new schedule
          await manageWitnessesSchedule();
        }
      }
    }
  }
};

actions.scheduleWitnesses = async () => {
  if (api.sender !== 'null') return;

  await manageWitnessesSchedule();
};
