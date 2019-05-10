actions.createSSC = async (payload) => {
  await api.db.createTable('params');
  await api.db.createTable('comments', ['commentID']);
  await api.db.createTable('commentVotes', ['commentID']);
  await api.db.createTable('activeComments', ['commentID']);

  // const params = {};

  // await api.db.insert('params', params);
};

const approxSqrt = (num) => {
  if (num === 0 || num === '0') return 0;

  // Create an initial guess by simply dividing by 3.
  let lastGuess;
  let guess = num / 3;

  // Loop until a good enough approximation is found.
  do {
    lastGuess = guess; // store the previous guess

    // find a new guess by averaging the old one with
    // the original number divided by the old guess.
    guess = (num / guess + guess) / 2;

  // Loop again if the product isn't close enough to
  // the original number.
  } while (Math.abs(lastGuess - guess) > 5e-15);

  return guess; // return the approximate square root
};

const evaluateRewardCurve = (rshares, curve, contentConstant, precision) => {
  let result = '0';
  switch (curve) {
    case 'quadratic': {
      const rsharesPlusS = api.BigNumber(rshares).plus(contentConstant);
      const squareContentConstant = api.BigNumber(contentConstant).multipliedBy(
        contentConstant,
      );

      result = api.BigNumber(rsharesPlusS)
        .minus(squareContentConstant)
        .toFixed(precision);
      break;
    }
    case 'boundedCuration':
      // const twoAlpha = contentConstant * 2;
      // result = uint128_t( rshares.lo, 0 ) / (api.BigNumber(twoAlpha).plus(rshares));
      break;
    case 'linear':
      result = rshares;
      break;
    case 'squareRoot':
      result = approxSqrt(rshares);
      break;
    default:
      result = '0';
  }

  return result;
};

actions.commentOptions = async (payload) => {
  if (api.sender !== 'null') return;

  const {
    author,
    permlink,
    maxAcceptedPayout,
    allowVotes,
    allowCurationRewards,
    beneficiaries,
  } = payload;

  const comment = await api.db.findOne('comments', { commentID: `${author}/${permlink}` });
  if (api.assert(comment !== null, 'comment does not exist')) {
    comment.maxAcceptedPayout = maxAcceptedPayout;
    comment.allowVotes = allowVotes;
    comment.allowCurationRewards = allowCurationRewards;
    comment.beneficiaries = beneficiaries;

    await api.db.update('comments', comment);
  }
};

actions.vote = async (payload) => {
  if (api.sender !== 'null') return;

  const {
    voter,
    author,
    permlink,
    weight,
  } = payload;
  const commentID = `${author}/${permlink}`;
  const comment = await api.db.findOne('comments', { commentID });
  if (api.assert(comment !== null, 'comment does not exist')
    && api.assert(comment.allowVotes === true, 'comment does not allow votes')) {
    // get the balances of the voter
    const balances = await api.db.findInTable('tokens', 'balances', {
      account: voter,
      symbol: {
        $in: comment.votableAssets.map(tkn => tkn.symbol),
      },
    });

    for (let index = 0; index < balances.length; index += 1) {
      const balance = balances[index];
      const { symbol, lastVoteTime, votingPower } = balance;
      const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });

      if (api.assert(token && token.votingEnabled === true, 'voting not enabled')) {
        // check if the voter already voted for the comment
        let vote = await api.db.findOne('commentVotes', { commentID, voter, symbol });

        // update vote?
        if (vote !== null) {
          // TODO
        } else {
          // TODO
        }

        const votableAssetIndex = comment.votableAssets.findIndex(t => t.symbol === symbol);
        const votableAsset = comment.votableAssets[votableAssetIndex];

        const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);
        const nowTimeSec = blockDate.getTime() / 1000;

        const balanceLastVoteTime = lastVoteTime === undefined ? nowTimeSec : lastVoteTime;

        const secondsago = nowTimeSec - balanceLastVoteTime;

        const regeneratedPower = api.BigNumber(100)
          .dividedBy(token.voteRegenerationPeriodSeconds)
          .multipliedBy(secondsago)
          .toFixed(2);

        const balanceVotingPower = votingPower === undefined ? '100.00' : '0.00';

        let currentVotingPower = api.BigNumber(balanceVotingPower)
          .plus(regeneratedPower)
          .toFixed(2);

        if (api.BigNumber(currentVotingPower).gt(100)) {
          currentVotingPower = '100.00';
        }

        if (api.assert(api.BigNumber(currentVotingPower).gt(0), `no voting power available for token ${symbol}`)) {
          const formattedWeight = weight / 100;
          const absWeight = Math.abs(formattedWeight);

          const weightedPower = api.BigNumber(currentVotingPower)
            .multipliedBy(absWeight)
            .dividedBy(100)
            .toFixed(2);

          const usedPower = api.BigNumber(weightedPower)
            .dividedBy(token.votesPerRegenerationPeriod)
            .toFixed(2);

          if (api.assert(api.BigNumber(usedPower).lte(currentVotingPower), `no voting power available for token ${symbol}`)) {
            let absRshares = api.BigNumber(balance.stake)
              .multipliedBy(usedPower)
              .dividedBy(100)
              .minus(token.voteDustThreshold)
              .toFixed(token.precision);

            absRshares = api.BigNumber(absRshares).lt(0) ? '0.00' : absRshares;

            const cashoutDelta = votableAsset.cashoutTime - nowTimeSec;

            if (cashoutDelta < token.reverseAuctionWindowSeconds) {
              absRshares = api.BigNumber(absRshares)
                .multipliedBy(cashoutDelta)
                .dividedBy(token.reverseAuctionWindowSeconds)
                .toFixed(token.precision);
            }

            if (api.assert(weight !== 0, 'weight cannot be 0')) {
              // update voting power
              const newVotingPower = api.BigNumber(currentVotingPower)
                .minus(usedPower)
                .toFixed(2);

              await api.executeSmartContract('tokens', 'updateVotingPower', {
                account: voter,
                symbol,
                votingPower: newVotingPower,
                lastVoteTime: nowTimeSec,
              });

              const rshares = weight < 0 ? `-${absRshares}` : absRshares;
              const oldVoteRshares = votableAsset.voteRshares;

              votableAsset.netRshares = api.BigNumber(votableAsset.netRshares)
                .plus(rshares)
                .toFixed(token.precision);

              votableAsset.absRshares = api.BigNumber(votableAsset.absRshares)
                .plus(absRshares)
                .toFixed(token.precision);

              if (api.BigNumber(rshares).gt(0)) {
                votableAsset.voteRshares = api.BigNumber(votableAsset.voteRshares)
                  .plus(rshares)
                  .toFixed(token.precision);
              }

              if (api.BigNumber(rshares).gt(0)) {
                votableAsset.netVotes += 1;
              } else {
                votableAsset.netVotes -= 1;
              }

              let maxVoteWeight = 0;

              const commentVote = {
                voter,
                commentID,
                symbol,
                rshares,
                votePercent: weight,
                lastUpdate: nowTimeSec,
              };

              let curationRewardEligible = api.BigNumber(rshares).gt(0)
                && votableAsset.lastPayout === null
                && token.allowCurationRewards === true;


              if (curationRewardEligible === true) {
                curationRewardEligible = token.percentCurationRewards > 0;
              }

              if (curationRewardEligible === true) {
                const oldWeight = evaluateRewardCurve(oldVoteRshares, token.curationRewardCurve, token.contentConstant, token.precision);
                const newWeight = evaluateRewardCurve(votableAsset.voteRshares, token.curationRewardCurve, token.contentConstant, token.precision);
                commentVote.weight = api.BigNumber(newWeight).minus(oldWeight).toFixed(token.precision);
                maxVoteWeight = commentVote.weight;

                api.debug('oldWeight: ' + oldWeight)
                api.debug('newWeight: ' + newWeight)

                // discount weight by time
                let w = maxVoteWeight;
                const deltaT = Math.min(
                  commentVote.lastUpdate - comment.created,
                  token.reverseAuctionWindowSeconds,
                );

                w = api.BigNumber(w).multipliedBy(deltaT).toFixed(token.precision);
                w = api.BigNumber(w).dividedBy(token.reverseAuctionWindowSeconds).toFixed(token.precision);
                commentVote.weight = w;
              } else {
                commentVote.weight = 0;
              }

              if (api.BigNumber(maxVoteWeight).gt(0)) {
                votableAsset.totalVoteWeight = api.BigNumber(votableAsset.totalVoteWeight)
                  .plus(maxVoteWeight)
                  .toFixed(token.precision);
              }

              await api.db.update('comments', comment);
              await api.db.insert('commentVotes', commentVote);
            }
          }
        }
      }
    }
  }
};

actions.comment = async (payload) => {
  if (api.sender !== 'null') return;

  const { author, permlink, votableAssets } = payload;

  if (api.assert(votableAssets && Array.isArray(votableAssets)
    && votableAssets.length > 0 && votableAssets.length <= 5
    && votableAssets.every(el => typeof el === 'string' && el.length <= 10), 'votableAssets invalid')) {
    // check if the tokens exist
    let tokens = await api.db.findInTable('tokens', 'tokens', {
      symbol: {
        $in: votableAssets,
      },
    });

    if (api.assert(votableAssets.length === tokens.length, 'invalid tokens')) {
      // check if the tokens have staking and voting enabled
      tokens = tokens.filter(
        tkn => tkn.stakingEnabled === true && tkn.votingEnabled === true,
      );

      const commentID = `${author}/${permlink}`;

      if (api.assert(tokens.length > 0, 'none of the tokens have staking enabled and voting enabled')) {
        let comment = await api.db.findOne('comments', { commentID });
        if (api.assert(comment === null, 'comment already exists')) {
          const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);
          const timestampSec = blockDate.getTime() / 1000;

          const finalVotableAssets = tokens.map(tkn => ({
            symbol: tkn.symbol,
            cashoutTime: timestampSec + tkn.cashoutWindowSeconds,
            lastPayout: null,
            netRshares: '0',
            absRshares: '0',
            voteRshares: '0',
            netVotes: 0,
            totalVoteWeight: '0',
            rewardWeight: '0',
          }));

          comment = {
            commentID,
            created: timestampSec,
            votableAssets: finalVotableAssets,
            allowVotes: true,
          };

          await api.db.insert('comments', comment);

          const nbVotableAssets = finalVotableAssets.length;

          for (let index = 0; index < nbVotableAssets; index += 1) {
            const token = finalVotableAssets[index];

            const activeComment = Object.assign({ commentID }, token);

            await api.db.insert('activeComments', activeComment);
          }
        }
      }
    }
  }
};
