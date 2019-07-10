/* eslint-disable no-await-in-loop */
/* global actions, api */

const NB_APPROVALS_ALLOWED = 30;
const NB_TOP_WITNESSES = 20;
const NB_BACKUP_WITNESSES = 1;
const NB_WITNESSES = NB_TOP_WITNESSES + NB_BACKUP_WITNESSES;
const BLOCK_PROPOSITION_PERIOD = 10;
const BLOCK_DISPUTE_PERIOD = 10;
const MAX_BLOCK_MISSED_IN_A_ROW = 3;

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('witnesses');

  if (tableExists === false) {
    await api.db.createTable('witnesses', ['approvalWeight']);
    await api.db.createTable('approvals', ['from', 'to']);
    await api.db.createTable('accounts', ['account']);
    await api.db.createTable('schedules');
    await api.db.createTable('params');

    const params = {
      totalApprovalWeight: { $numberDecimal: '0' },
      numberOfApprovedWitnesses: 0,
      nextScheduleCalculation: 0,
      lastVerifiedBlockNumber: null,
      currentWitness: null,
    };

    await api.db.insert('params', params);
  }
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
      // eslint-disable-next-line no-template-curly-in-string
      .toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');

    await api.db.update('witnesses', witnessRec);

    const params = await api.db.findOne('params', {});

    // update totalApprovalWeight
    params.totalApprovalWeight.$numberDecimal = api.BigNumber(
      params.totalApprovalWeight.$numberDecimal,
    )
      .plus(approvalWeight)
      // eslint-disable-next-line no-template-curly-in-string
      .toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');

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

actions.updateWitnessesApprovals = async () => {
  const acct = await api.db.findOne('accounts', { account: api.sender });

  if (acct !== null) {
    // calculate approval weight of the account
    // eslint-disable-next-line no-template-curly-in-string
    const balance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });
    let approvalWeight = 0;
    if (balance && balance.stake) {
      approvalWeight = balance.stake;
    }

    if (balance && balance.delegationsIn) {
      // eslint-disable-next-line no-template-curly-in-string
      approvalWeight = api.BigNumber(approvalWeight).plus(balance.delegationsIn).toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');
    }

    const oldApprovalWeight = acct.approvalWeight;

    // eslint-disable-next-line no-template-curly-in-string
    const deltaApprovalWeight = api.BigNumber(approvalWeight).minus(oldApprovalWeight).toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');

    acct.approvalWeight = approvalWeight;

    if (!api.BigNumber(deltaApprovalWeight).eq(0)) {
      await api.db.update('accounts', acct);

      const approvals = await api.db.find('approvals', { from: api.sender });

      for (let index = 0; index < approvals.length; index += 1) {
        const approval = approvals[index];

        await updateWitnessRank(approval.to, deltaApprovalWeight);
      }
    }
  }
};

actions.register = async (payload) => {
  const {
    RPCPUrl, enabled, isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'active key required')
    && api.assert(RPCPUrl && typeof RPCPUrl === 'string' && RPCPUrl.length > 0 && RPCPUrl.length <= 255, 'RPCPUrl must be a string with a max. of 255 chars.')
    && api.assert(typeof enabled === 'boolean', 'enabled must be a boolean')) {
    let witness = await api.db.findOne('witnesses', { account: api.sender });

    // if the witness is already registered
    if (witness) {
      witness.RPCPUrl = RPCPUrl;
      witness.enabled = enabled;
      await api.db.update('witnesses', witness);
    } else {
      witness = {
        account: api.sender,
        approvalWeight: { $numberDecimal: '0' },
        RPCPUrl,
        enabled,
        missedBlocks: 0,
        missedBlocksInARow: 0,
      };
      await api.db.insert('witnesses', witness);
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
          // eslint-disable-next-line no-template-curly-in-string
          const balance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });
          let approvalWeight = 0;
          if (balance && balance.stake) {
            approvalWeight = balance.stake;
          }

          if (balance && balance.delegationsIn) {
            // eslint-disable-next-line no-template-curly-in-string
            approvalWeight = api.BigNumber(approvalWeight).plus(balance.delegationsIn).toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');
          }

          acct.approvals += 1;
          acct.approvalWeight.$numberDecimal = approvalWeight;

          await api.db.update('accounts', acct);

          if (api.BigNumber(approvalWeight).gt(0)) {
            await updateWitnessRank(witness, approvalWeight);
          }
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

          // eslint-disable-next-line no-template-curly-in-string
          const balance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });
          let approvalWeight = 0;
          if (balance && balance.stake) {
            approvalWeight = balance.stake;
          }

          if (balance && balance.delegationsIn) {
            // eslint-disable-next-line no-template-curly-in-string
            approvalWeight = api.BigNumber(approvalWeight).plus(balance.delegationsIn).toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');
          }

          acct.approvals -= 1;
          acct.approvalWeight.$numberDecimal = approvalWeight;

          await api.db.update('accounts', acct);

          // update the rank of the witness that received the disapproval
          if (api.BigNumber(approvalWeight).gt(0)) {
            await updateWitnessRank(witness, `-${approvalWeight}`);
          }
        }
      }
    }
  }
};

actions.manageWitnessesSchedule = async () => {
  if (api.sender !== 'null') return;

  const params = await api.db.findOne('params', {});
  const {
    numberOfApprovedWitnesses,
    totalApprovalWeight,
    nextScheduleCalculation,
    lastVerifiedBlockNumber,
  } = params;

  // check the current schedule
  let schedule = await api.db.findOne('schedules', { blockNumber: lastVerifiedBlockNumber + 1 });

  // if the scheduled witness has not signed the block on time we need to reschedule a new witness
  if (schedule && api.blockNumber >= schedule.blockPropositionDeadline) {
    // update the witness
    const scheduledWitness = await api.db.findOne('witnesses', { account: schedule.witness });
    scheduledWitness.missedBlocks += 1;
    scheduledWitness.missedBlocksInARow += 1;

    // disable the witness if necessary
    if (scheduledWitness.missedBlocksInARow >= MAX_BLOCK_MISSED_IN_A_ROW) {
      scheduledWitness.missedBlocksInARow = 0;
      scheduledWitness.enabled = false;
    }

    await api.db.insert('witnesses', scheduledWitness);

    let witnessFound = false;
    // get a deterministic random weight
    const random = api.random();
    const randomWeight = api.BigNumber(totalApprovalWeight.$numberDecimal)
      .minus(0)
      .times(random)
      .plus(0)
      // eslint-disable-next-line no-template-curly-in-string
      .toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');

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

        accWeight = api.BigNumber(accWeight)
          .plus(witness.approvalWeight.$numberDecimal)
          // eslint-disable-next-line no-template-curly-in-string
          .toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');

        // if the witness is enabled
        // and different from the schdeuled one
        if (witness.enabled === true
          && witness.account !== schedule.witness
          && api.BigNumber(randomWeight).lte(accWeight)) {
          schedule.witness = witness.account;
          schedule.blockPropositionDeadline = api.blockNumber + BLOCK_PROPOSITION_PERIOD;
          await api.db.update('schedules', schedule);
          witnessFound = true;
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
  }

  // check if a new schedule has to be calculated
  if (api.blockNumber >= nextScheduleCalculation) {
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
              // eslint-disable-next-line no-template-curly-in-string
              .plus('${CONSTANTS.UTILITY_TOKEN_MIN_VALUE}$');

            randomWeight = api.BigNumber(totalApprovalWeight.$numberDecimal)
              .minus(min)
              .times(random)
              .plus(min)
              // eslint-disable-next-line no-template-curly-in-string
              .toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');

            api.debug(`random weight: ${randomWeight}`);
          }

          accWeight = api.BigNumber(accWeight)
            .plus(witness.approvalWeight.$numberDecimal)
            // eslint-disable-next-line no-template-curly-in-string
            .toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');

          // if the witness is enabled
          if (witness.enabled === true) {
            // if we haven't found all the top witnesses yet
            if (schedule.length < NB_TOP_WITNESSES
              || api.BigNumber(randomWeight).lte(accWeight)) {
              api.debug(`adding witness ${schedule.length + 1} ${witness.account}`);
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
      const random = api.random();
      let j; let x;
      for (let i = schedule.length - 1; i > 0; i -= 1) {
        j = Math.floor(random * (i + 1));
        x = schedule[i];
        schedule[i] = schedule[j];
        schedule[j] = x;
      }

      // block number attribution
      // eslint-disable-next-line prefer-destructuring
      let blockNumber = nextScheduleCalculation + 1;
      for (let i = 0; i < schedule.length; i += 1) {
        blockNumber += 1;
        // the block number that the witness will have to "sign"
        schedule[i].blockNumber = blockNumber;
        // if the witness is unable to "sign" the block on time, another witness will be schedule
        schedule[i].blockPropositionDeadline = blockNumber + BLOCK_PROPOSITION_PERIOD;
        await api.db.insert('schedules', schedule[i]);
      }

      // if there has never been any schedule we need to intitialize some params
      if (params.currentWitness === null) {
        params.lastVerifiedBlockNumber = schedule[0].blockNumber - 1;
        params.currentWitness = schedule[0].witness;
      }
      params.nextScheduleCalculation = blockNumber;
      await api.db.update('params', params);
    }
  }
};

actions.proposeBlock = async (payload) => {
  const {
    blockNumber,
    refSteemBlockNumber,
    prevRefSteemBlockId,
    previousHash,
    previousDatabaseHash,
    timestamp,
    hash,
    databaseHash,
    merkleRoot,
    isSignedWithActiveKey,
  } = payload;

  if (isSignedWithActiveKey === true
    && blockNumber
    && refSteemBlockNumber
    && prevRefSteemBlockId
    && previousHash
    && previousDatabaseHash
    && timestamp
    && hash
    && databaseHash
    && merkleRoot) {
    const params = await api.db.findOne('params', {});
    const { lastVerifiedBlockNumber, currentWitness } = params;
    const currentBlock = lastVerifiedBlockNumber + 1;

    // the block proposed must be the current block waiting for signature
    // the sender must be the current witness
    if (blockNumber === currentBlock
      && api.sender === currentWitness) {
      // get the block information and check against the proposed ones
      const blockInfo = await api.db.getBlockInfo(blockNumber);

      if (blockInfo !== null
        && blockInfo.refSteemBlockNumber === refSteemBlockNumber
        && blockInfo.prevRefSteemBlockId === prevRefSteemBlockId
        && blockInfo.previousHash === previousHash
        && blockInfo.previousDatabaseHash === previousDatabaseHash
        && blockInfo.timestamp === timestamp
        && blockInfo.hash === hash
        && blockInfo.databaseHash === databaseHash
        && blockInfo.merkleRoot === merkleRoot) {
        // set dispute period where the top witnesses can dispute the block
        let schedule = await api.db.findOne('schedules', { blockNumber: currentBlock });
        schedule.blockDisputeDeadline = api.blockNumber + BLOCK_DISPUTE_PERIOD;
        await api.db.update('schedules', schedule);

        // update the params
        // get the next witness on schedule
        schedule = await api.db.findOne('schedules', { blockNumber: currentBlock + 1 });

        if (schedule !== null) {
          params.currentWitness = schedule.witness;
          await api.db.update('params', params);
        }

        // mark block as verified
        api.emit('blockVerification', { verified: true });
      } else {
        // start dispute
        api.emit('blockVerification', { verified: false });
      }
    }
  }
};
