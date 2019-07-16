/* eslint-disable no-await-in-loop */
/* global actions, api */

const NB_APPROVALS_ALLOWED = 30;
const NB_TOP_WITNESSES = 20;
const NB_BACKUP_WITNESSES = 1;
const NB_WITNESSES = NB_TOP_WITNESSES + NB_BACKUP_WITNESSES;
const NB_WITNESSES_REQUIRED_TO_VALIDATE_BLOCK = 17;
const BLOCK_PROPOSITION_PERIOD = 11;
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
    await api.db.createTable('disputes');
    await api.db.createTable('proposedBlocks');

    const params = {
      totalApprovalWeight: '0',
      numberOfApprovedWitnesses: 0,
      lastVerifiedBlockNumber: 0,
      lastProposedBlockNumber: 0,
      round: 0,
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
    params.totalApprovalWeight = api.BigNumber(params.totalApprovalWeight)
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

actions.updateWitnessesApprovals = async (payload) => {
  const { account, callingContractInfo } = payload;

  if (callingContractInfo === undefined) return;
  if (callingContractInfo.name !== 'tokens') return;

  const acct = await api.db.findOne('accounts', { account });
  if (acct !== null) {
    // calculate approval weight of the account
    // eslint-disable-next-line no-template-curly-in-string
    const balance = await api.db.findOneInTable('tokens', 'balances', { account, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });
    let approvalWeight = 0;
    if (balance && balance.stake) {
      approvalWeight = balance.stake;
    }

    if (balance && balance.pendingUnstake) {
      approvalWeight = api.BigNumber(approvalWeight)
        .plus(balance.pendingUnstake)
        // eslint-disable-next-line no-template-curly-in-string
        .toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');
    }

    if (balance && balance.delegationsIn) {
      approvalWeight = api.BigNumber(approvalWeight)
        .plus(balance.delegationsIn)
        // eslint-disable-next-line no-template-curly-in-string
        .toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');
    }

    const oldApprovalWeight = acct.approvalWeight;

    const deltaApprovalWeight = api.BigNumber(approvalWeight)
      .minus(oldApprovalWeight)
      // eslint-disable-next-line no-template-curly-in-string
      .toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');

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
    RPCUrl, enabled, isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'active key required')
    && api.assert(RPCUrl && typeof RPCUrl === 'string' && RPCUrl.length > 0 && RPCUrl.length <= 255, 'RPCUrl must be a string with a max. of 255 chars.')
    && api.assert(typeof enabled === 'boolean', 'enabled must be a boolean')) {
    let witness = await api.db.findOne('witnesses', { account: api.sender });

    // if the witness is already registered
    if (witness) {
      witness.RPCUrl = RPCUrl;
      witness.enabled = enabled;
      await api.db.update('witnesses', witness);
    } else {
      witness = {
        account: api.sender,
        approvalWeight: { $numberDecimal: '0' },
        RPCUrl,
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

          if (balance && balance.pendingUnstake) {
            approvalWeight = api.BigNumber(approvalWeight)
              .plus(balance.pendingUnstake)
              // eslint-disable-next-line no-template-curly-in-string
              .toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');
          }

          if (balance && balance.delegationsIn) {
            approvalWeight = api.BigNumber(approvalWeight)
              .plus(balance.delegationsIn)
              // eslint-disable-next-line no-template-curly-in-string
              .toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');
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
          acct.approvalWeight = approvalWeight;

          await api.db.update('accounts', acct);

          // update the rank of the witness that received the disapproval
          await updateWitnessRank(witness, `-${approvalWeight}`);
        }
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
    lastProposedBlockNumber,
  } = params;

  // check the current schedule
  const currentBlock = lastProposedBlockNumber + 1;
  let schedule = await api.db.findOne('schedules', { blockNumber: currentBlock });
  const proposedBlock = await api.db.findOne('proposedBlocks', { blockNumber: currentBlock });

  // if the scheduled witness has not proposed the block on time we need to reschedule a new witness
  if (schedule
    && api.blockNumber >= schedule.blockPropositionDeadline
    && proposedBlock === null) {
    // update the witness
    const scheduledWitness = await api.db.findOne('witnesses', { account: schedule.witness });
    scheduledWitness.missedBlocks += 1;
    scheduledWitness.missedBlocksInARow += 1;

    // disable the witness if missed MAX_BLOCK_MISSED_IN_A_ROW
    if (scheduledWitness.missedBlocksInARow >= MAX_BLOCK_MISSED_IN_A_ROW) {
      scheduledWitness.missedBlocksInARow = 0;
      scheduledWitness.enabled = false;
    }

    await api.db.update('witnesses', scheduledWitness);

    let witnessFound = false;
    // get a deterministic random weight
    const random = api.random();
    const randomWeight = api.BigNumber(totalApprovalWeight)
      .times(random)
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
        // and different from the scheduled one
        if (witness.enabled === true
          && witness.account !== schedule.witness
          && api.BigNumber(randomWeight).lte(accWeight)) {
          schedule.witness = witness.account;
          schedule.blockPropositionDeadline = api.blockNumber + BLOCK_PROPOSITION_PERIOD;
          await api.db.update('schedules', schedule);
          params.currentWitness = witness.account;
          await api.db.update('params', params);
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

  // if the current block has not been scheduled already we have to create a new schedule
  if (schedule === null) {
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

            randomWeight = api.BigNumber(totalApprovalWeight)
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
      let j; let x;
      for (let i = schedule.length - 1; i > 0; i -= 1) {
        const random = api.random();
        j = Math.floor(random * (i + 1));
        x = schedule[i];
        schedule[i] = schedule[j];
        schedule[j] = x;
      }

      // block number attribution
      // eslint-disable-next-line prefer-destructuring
      let blockNumber = lastProposedBlockNumber === 0
        ? api.blockNumber
        : lastProposedBlockNumber + 1;
      params.round += 1;
      for (let i = 0; i < schedule.length; i += 1) {
        // the block number that the witness will have to "sign"
        schedule[i].blockNumber = blockNumber;
        // if the witness is unable to "sign" the block on time, another witness will be schedule
        schedule[i].blockPropositionDeadline = i === 0
          ? api.blockNumber + BLOCK_PROPOSITION_PERIOD
          : 0;
        schedule[i].round = params.round;
        await api.db.insert('schedules', schedule[i]);
        blockNumber += 1;
      }

      if (lastProposedBlockNumber === 0) {
        params.lastVerifiedBlockNumber = api.blockNumber - 1;
        params.lastProposedBlockNumber = api.blockNumber - 1;
      }

      params.currentWitness = schedule[0].witness;

      await api.db.update('params', params);
    }
  }
};

actions.proposeBlock = async (payload) => {
  const {
    blockNumber,
    previousHash,
    previousDatabaseHash,
    hash,
    databaseHash,
    merkleRoot,
    isSignedWithActiveKey,
  } = payload;

  let blockAddedForVerification = false;

  if (isSignedWithActiveKey === true
    && blockNumber && Number.isInteger(blockNumber)
    && previousHash && typeof previousHash === 'string' && previousHash.length === 64
    && previousDatabaseHash && typeof previousDatabaseHash === 'string' && previousDatabaseHash.length === 64
    && hash && typeof hash === 'string' && hash.length === 64
    && databaseHash && typeof databaseHash === 'string' && databaseHash.length === 64
    && merkleRoot && typeof merkleRoot === 'string' && merkleRoot.length === 64) {
    const params = await api.db.findOne('params', {});
    const { lastProposedBlockNumber, currentWitness } = params;
    const currentBlock = lastProposedBlockNumber + 1;
    api.debug(`proposing block ${blockNumber} by ${api.sender}`)
    api.debug(`lastProposedBlockNumber ${lastProposedBlockNumber}`)

    // the block proposed must be the current block waiting for signature
    if (blockNumber === currentBlock && api.sender === currentWitness) {
      // the sender must be the witness
      let schedule = await api.db.findOne('schedules', { blockNumber: currentBlock, witness: api.sender });

      if (schedule !== null) {
        schedule.blockDisputeDeadline = api.blockNumber + BLOCK_DISPUTE_PERIOD;
        await api.db.update('schedules', schedule);

        // save the proposed block
        await api.db.insert('proposedBlocks', {
          blockNumber,
          witnesses: [{ witness: api.sender, txID: api.transactionId }],
          round: schedule.round,
          previousHash,
          previousDatabaseHash,
          hash,
          databaseHash,
          merkleRoot,
        });

        params.lastProposedBlockNumber = blockNumber;

        // get the next witness on schedule
        schedule = await api.db.findOne('schedules', { blockNumber: currentBlock + 1 });

        if (schedule !== null) {
          params.currentWitness = schedule.witness;
          schedule.blockPropositionDeadline = api.blockNumber + BLOCK_PROPOSITION_PERIOD;
          await api.db.update('schedules', schedule);
        } else {
          params.currentWitness = null;
        }

        await api.db.update('params', params);

        blockAddedForVerification = true;

        await manageWitnessesSchedule();
      }
    }
  }

  api.assert(blockAddedForVerification === true, 'invalid block proposition');
};

actions.disputeBlock = async (payload) => {
  const {
    blockNumber,
    previousHash,
    previousDatabaseHash,
    hash,
    databaseHash,
    merkleRoot,
    isSignedWithActiveKey,
  } = payload;

  if (isSignedWithActiveKey === true
    && blockNumber && Number.isInteger(blockNumber)
    && previousHash && typeof previousHash === 'string' && previousHash.length === 64
    && previousDatabaseHash && typeof previousDatabaseHash === 'string' && previousDatabaseHash.length === 64
    && hash && typeof hash === 'string' && hash.length === 64
    && databaseHash && typeof databaseHash === 'string' && databaseHash.length === 64
    && merkleRoot && typeof merkleRoot === 'string' && merkleRoot.length === 64) {
    // check if the block has been proposed for validation
    const proposedBlock = await api.db.findOne('proposedBlocks', { blockNumber });

    // the witness that proposed the block cannot open a dispute
    if (proposedBlock !== null && proposedBlock.witness !== api.sender) {
      // check if the block can still be disputed
      let schedule = await api.db.findOne('schedules', { blockNumber });
      // check if a dispute has been started before the deadline
      let dispute = await api.db.findOne('disputes', { blockNumber });

      if (api.blockNumber <= schedule.blockPropositionDeadline || dispute != null) {
        // check if the sender is part of the round
        schedule = await api.db.findOne('schedules', { round: proposedBlock.round, witness: api.sender });

        if (schedule !== null) {
          // check if there is already a dispute opened by this witness
          dispute = await api.db.findOne('disputes', { blockNumber, 'witnesses.witness': api.sender });

          // if there is already one, remove the previous proposition
          if (dispute !== null) {
            dispute.witnesses = dispute.witnesses.filter(w => w.witness !== api.sender);
            dispute.numberPropositions -= 1;
            if (dispute.numberPropositions <= 0) {
              await api.db.remove('disputes', dispute);
            } else {
              await api.db.update('disputes', dispute);
            }
          }

          const newProposedBlock = {
            blockNumber,
            previousHash,
            previousDatabaseHash,
            hash,
            databaseHash,
            merkleRoot,
          };
          // check if there is already a dispute with the same block proposition
          dispute = await api.db.findOne('disputes', newProposedBlock);

          if (dispute !== null) {
            dispute.numberPropositions += 1;
            dispute.witnesses.push({ witness: api.sender, txID: api.transactionId });
            await api.db.update('disputes', dispute);
          } else {
            dispute = newProposedBlock;
            dispute.numberPropositions = 1;
            dispute.witnesses = [{ witness: api.sender, txID: api.transactionId }];
            await api.db.insert('disputes', dispute);
          }

          // check if a proposition matches NB_WITNESSES_REQUIRED_TO_VALIDATE_BLOCK
          dispute = await api.db.findOne('disputes', {
            blockNumber,
            numberPropositions: {
              $gte: NB_WITNESSES_REQUIRED_TO_VALIDATE_BLOCK,
            },
          });

          if (dispute !== null) {
            // if the dispute has been resolved
            // and if the result is different from what the scheduled witness sent
            // disable the scheduled witness
            if (proposedBlock.previousHash !== dispute.previousHash
              || proposedBlock.previousDatabaseHash !== dispute.previousDatabaseHash
              || proposedBlock.hash !== dispute.hash
              || proposedBlock.databaseHash !== dispute.databaseHash
              || proposedBlock.merkleRoot !== dispute.merkleRoot) {
              const scheduledWitness = await api.db.findOne('witnesses', { account: proposedBlock.witness });
              scheduledWitness.missedBlocks += 1;
              scheduledWitness.missedBlocksInARow = 0;
              scheduledWitness.enabled = false;

              await api.db.update('witnesses', scheduledWitness);
            }

            // clean the disputes for that block number
            const disputes = await api.db.find('disputes', { blockNumber });
            for (let index = 0; index < disputes.length; index += 1) {
              await api.db.remove('disputes', disputes[index]);
            }

            // update proposedBlock
            proposedBlock.witnesses = dispute.witnesses;
            await api.db.update('proposedBlocks', proposedBlock);

            /*
            // mark the current block as verified
            const params = await api.db.findOne('params', {});
            params.lastVerifiedBlockNumber = blockNumber;
            await api.db.update('params', params);

            // remove the proposed block
            await api.db.remove('proposedBlocks', proposedBlock);
            api.debug(`consensus reached, block ${proposedBlock.blockNumber} verified on block ${api.blockNumber} `)
            // TODO: burn the rewards for the production of this block
            api.emit('blockVerified', {
              blockNumber,
              witnesses: dispute.witnesses,
            });

            // if the block was the last of the round
            const { round } = schedule;
            schedule = await api.db.findOne('schedules', { blockNumber: blockNumber + 1 });
            if (schedule !== null && schedule.round !== round) {
              // clean last round
              const lastRound = await api.db.find('schedules', { round });
              for (let index = 0; index < lastRound.length; index += 1) {
                await api.db.remove('schedules', lastRound[index]);
              }
            }
            */
          }
        }
      }
    }
  }
};

actions.checkBlockVerificationStatus = async () => {
  if (api.sender !== 'null') return;

  const params = await api.db.findOne('params', {});
  const { lastVerifiedBlockNumber } = params;
  const currentBlock = lastVerifiedBlockNumber + 1;

  let schedule = await api.db.findOne('schedules', { blockNumber: currentBlock });
  const proposedBlock = await api.db.findOne('proposedBlocks', { blockNumber: currentBlock });

  // if there was a schedule and the dispute period expired
  if (schedule
    && api.blockNumber >= schedule.blockDisputeDeadline
    && proposedBlock !== null) {
    const disputes = await api.db.find('disputes', { blockNumber: currentBlock });

    // if there are no disputes regarding the current block
    if (disputes.length === 0) {
      // update the witness that just verified the block
      const scheduledWitness = await api.db.findOne('witnesses', { account: schedule.witness });

      // check that the witness that proposed the block
      // is actually part of the witnesses that verified the block
      if (proposedBlock.witnesses.find(w => w.witness === schedule.witness)
        && scheduledWitness.missedBlocksInARow > 0) {
        // clear the missed blocks
        scheduledWitness.missedBlocksInARow = 0;
      } else {
        // disable the witness
        scheduledWitness.missedBlocks += 1;
        scheduledWitness.missedBlocksInARow = 0;
        scheduledWitness.enabled = false;
      }

      await api.db.update('witnesses', scheduledWitness);

      // mark the current block as verified
      params.lastVerifiedBlockNumber = currentBlock;
      await api.db.update('params', params);

      // remove the proposed block
      await api.db.remove('proposedBlocks', proposedBlock);
      api.debug(`block ${currentBlock} verified on block ${api.blockNumber} `)
      // TODO: reward the witness for the production of this block
      // if
      api.emit('blockVerified', {
        blockNumber: currentBlock,
        witnesses: proposedBlock.witnesses,
      });

      // if the block was the last of the round
      const { round } = schedule;
      schedule = await api.db.findOne('schedules', { blockNumber: currentBlock + 1 });
      if (schedule !== null && schedule.round !== round) {
        // clean last round
        const lastRound = await api.db.find('schedules', { round });
        for (let index = 0; index < lastRound.length; index += 1) {
          await api.db.remove('schedules', lastRound[index]);
        }
      }
    }
  }

  await manageWitnessesSchedule();
};
