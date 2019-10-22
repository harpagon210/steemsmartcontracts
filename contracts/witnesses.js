/* eslint-disable no-await-in-loop */
/* global actions, api */

const NB_APPROVALS_ALLOWED = 30;
const NB_TOP_WITNESSES = 3;
const NB_BACKUP_WITNESSES = 1;
const NB_WITNESSES = NB_TOP_WITNESSES + NB_BACKUP_WITNESSES;
const NB_WITNESSES_SIGNATURES_REQUIRED = 3;
const MAX_ROUNDS_MISSED_IN_A_ROW = 3;

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
      round: 0,
      lastBlockRound: 0,
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
    IP, RPCPort, P2PPort, signingKey, enabled, isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'active key required')
    && api.assert(IP && typeof IP === 'string' && IP.length <= 15, 'IP must be a string with a max. of 15 chars.')
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
    lastVerifiedBlockNumber,
  } = params;

  // check the current schedule
  const currentBlock = lastVerifiedBlockNumber + 1;
  let schedule = await api.db.findOne('schedules', { blockNumber: currentBlock });

  // if the current block has not been scheduled already we have to create a new schedule
  if (schedule === null) {
    api.debug('calculating new schedule')
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

      // make sure the last witness of the previous round is not the last witness of this round
      if (schedule[schedule.length - 1].witness === params.lastWitnessPreviousRound) {
        const firstWitness = schedule[0].witness;
        const lastWitness = schedule[schedule.length - 1].witness;
        schedule[0].witness = lastWitness;
        schedule[schedule.length - 1].witness = firstWitness;
      } else if (schedule[0].witness === params.lastWitnessPreviousRound) {
        // make sure the last witness of the previous round is not the first witness of this round
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

      params.lastBlockRound = schedule[schedule.length - 1].blockNumber;
      params.currentWitness = schedule[schedule.length - 1].witness;
      params.lastWitnessPreviousRound = schedule[schedule.length - 1].witness;


      await api.db.update('params', params);
    }
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
          calculatedRoundHash = api.hash(`${calculatedRoundHash}${block.hash}`);
        }

        currentBlock += 1;
      }

      if (calculatedRoundHash !== '' && calculatedRoundHash === roundHash) {
        // get the witnesses on schedule
        const schedules = await api.db.find('schedules', { round });

        // check the signatures
        let signaturesChecked = 0;
        const verifiedBlockInformation = [];
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
                verifiedBlockInformation.push(
                  {
                    blockNumber: scheduledWitness.blockNumber,
                    witness: witness.account,
                    signingKey: witness.signingKey,
                    roundSignature: signature[1],
                    round,
                    roundHash,
                  },
                );
                signaturesChecked += 1;
              }
            }
          }
        }

        if (signaturesChecked >= NB_WITNESSES_SIGNATURES_REQUIRED) {
          // mark blocks of the verified round as verified
          for (let index = 0; index < verifiedBlockInformation.length; index += 1) {
            await api.verifyBlock(verifiedBlockInformation[index]);
          }

          // remove the schedules
          for (let index = 0; index < schedules.length; index += 1) {
            await api.db.remove('schedules', schedules[index]);
          }

          params.currentWitness = null;
          params.lastVerifiedBlockNumber = lastBlockRound;
          await api.db.update('params', params);

          // update missedRoundsInARow for the current witness
          const witness = await api.db.findOne('witnesses', { account: currentWitness });
          witness.missedRoundsInARow = 0;
          await api.db.update('witnesses', witness);

          // calculate new schedule
          await manageWitnessesSchedule();

          // TODO: reward the witness that produced this block
        }
      }
    }
  }
};

actions.changeCurrentWitness = async (payload) => {
  const {
    signatures,
    isSignedWithActiveKey,
  } = payload;

  if (isSignedWithActiveKey === true
    && Array.isArray(signatures)
    && signatures.length <= NB_WITNESSES
    && signatures.length >= NB_WITNESSES_SIGNATURES_REQUIRED) {
    const params = await api.db.findOne('params', {});
    const {
      currentWitness,
      totalApprovalWeight,
      lastWitnessPreviousRound,
      lastBlockRound,
      round,
    } = params;

    // check if the sender is part of the round
    let schedule = await api.db.findOne('schedules', { round, witness: api.sender });
    if (round === params.round && schedule !== null) {
      // get the witnesses on schedule
      const schedules = await api.db.find('schedules', { round });

      // check the signatures
      let signaturesChecked = 0;
      for (let index = 0; index < schedules.length; index += 1) {
        const scheduledWitness = schedules[index];
        const witness = await api.db.findOne('witnesses', { account: scheduledWitness.witness });
        if (witness !== null) {
          const signature = signatures.find(s => s[0] === witness.account);
          if (signature) {
            if (api.checkSignature(`${currentWitness}:${round}`, signature[1], witness.signingKey)) {
              api.debug(`witness ${witness.account} signed witness change ${round}`);
              signaturesChecked += 1;
            }
          }
        }
      }

      if (signaturesChecked >= NB_WITNESSES_SIGNATURES_REQUIRED) {
        // update the witness
        const scheduledWitness = await api.db.findOne('witnesses', { account: currentWitness });
        scheduledWitness.missedRounds += 1;
        scheduledWitness.missedRoundsInARow += 1;

        // disable the witness if missed MAX_ROUNDS_MISSED_IN_A_ROW
        if (scheduledWitness.missedRoundsInARow >= MAX_ROUNDS_MISSED_IN_A_ROW) {
          scheduledWitness.missedRoundsInARow = 0;
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

        // get the current schedule
        schedule = await api.db
          .findOne('schedules', { round, witness: currentWitness, blockNumber: lastBlockRound });

        do {
          for (let index = 0; index < witnesses.length; index += 1) {
            const witness = witnesses[index];

            accWeight = api.BigNumber(accWeight)
              .plus(witness.approvalWeight.$numberDecimal)
              // eslint-disable-next-line no-template-curly-in-string
              .toFixed('${CONSTANTS.UTILITY_TOKEN_PRECISION}$');

            // if the witness is enabled
            // and different from the scheduled one
            // and different from the scheduled one from the previous round
            if (witness.enabled === true
              && witness.account !== schedule.witness
              && witness.account !== lastWitnessPreviousRound
              && api.BigNumber(randomWeight).lte(accWeight)) {
              schedule.witness = witness.account;
              await api.db.update('schedules', schedule);
              params.currentWitness = witness.account;
              await api.db.update('params', params);
              witnessFound = true;
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
      }
    }
  }
};

actions.checkBlockVerificationStatus = async () => {
  if (api.sender !== 'null') return;

  await manageWitnessesSchedule();
};
