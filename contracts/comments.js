actions.createSSC = async (payload) => {
  await api.db.createTable('params');
  await api.db.createTable('comments', ['commentID']);
  await api.db.createTable('votes', ['commentID']);

  const params = {};

  await api.db.insert('params', params);


  const testComment = {
    commentID: 'test/noxsoma-1546293744753-noxsoma-abstract-living-in-a-turbulent-world'
  }

  await api.db.insert('comments', testComment);

};

actions.commentOptions = async (payload) => {
  if (api.assert(api.sender === 'null', 'not authorized')) {
    const {
      author,
      permlink,
      maxAcceptedPayout,
      allowVotes,
      allowCurationRewards,
      beneficiaries,
    } = payload;

    let comment = await api.db.findOne('comments', { commentID: `${author}/${permlink}` });
    if (api.assert(comment !== null, 'comment does not exist')) {
      comment.maxAcceptedPayout = maxAcceptedPayout;
      comment.allowVotes = allowVotes;
      comment.allowCurationRewards = allowCurationRewards;
      comment.beneficiaries = beneficiaries;

      await api.db.update('comments', comment);
    }
  }
};

actions.vote = async (payload) => {
  if (api.assert(api.sender === 'null', 'not authorized')) {
    const {
      voter,
      author,
      permlink,
      weight,
    } = payload;

    let comment = await api.db.findOne('comments', { commentID: `${author}/${permlink}` });
    if (api.assert(comment !== null, 'comment does not exist')
      && api.assert(comment.allowVotes === true, 'comment does not allow votes')) {
      // get the balances of the voter
      const balances = await api.db.findInTable('tokens', 'balances', {
        account: voter,
        symbol: {
          $in: comment.allowedTokens,
        },
      });

      for (let index = 0; index < balances.length; index += 1) {
        const balance = balances[index];
        const { symbol, lastVoteTime, votingPower } = balance;
        const token = await api.db.findOne('tokens', { symbol });

        // check if the voter already voted for the post
        let vote = await api.db.findOne('votes', { commentID: `${author}/${permlink}`, voter, symbol });

        // update vote
        if (vote !== null) {

        } else {

        }

        const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);
        const nowTimeSec = blockDate.getTime() / 1000;

        const secondsago = nowTimeSec - lastVoteTime;

        const nbDays100PercentRegenerationSecs = token.nbDays100PercentRegeneration * 24 * 60 * 60;
        const regeneratedPower = api.BigNumber(100)
          .dividedBy(nbDays100PercentRegenerationSecs)
          .multipliedBy(secondsago)
          .toFixed(2);

        let currentVotingPower = api.BigNumber(votingPower)
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
            .dividedBy(50)
            .toFixed(2);

          if (api.assert(api.BigNumber(usedPower).lte(currentVotingPower), `no voting power available for token ${symbol}`)) {
            const newVotingPower = api.BigNumber(currentVotingPower)
              .minus(usedPower)
              .toFixed(2);

            let absRshares = api.BigNumber(balance.stake)
              .multipliedBy(usedPower)
              .dividedBy(100)
              .minus(toke.voteDustThreshold)
              .toFixed(token.precision);

            // abs_rshares = std::max( int64_t(0), abs_rshares );

            const cashoutDelta = comment.cashoutTime - nowTimeSec;

            if (cashoutDelta < token.lockoutSeconds) {
              absRshares = api.BigNumber(absRshares)
                .multipliedBy(cashoutDelta)
                .dividedBy(token.lockoutSeconds)
                .toFixed(token.precision);
            }

            const rshares = weight < 0 ? `-${absRshares}` : absRshares;

            
          }
        }
      }
    }
  }
};

actions.comment = async (payload) => {
  if (api.assert(api.sender === 'null', 'not authorized')) {
    const { author, permlink, allowedTokens } = payload;

    if (api.assert(allowedTokens && Array.isArray(allowedTokens)
      && allowedTokens.length > 0 && allowedTokens.length <= 5
      && allowedTokens.every(el => typeof el === 'string' && el.length <= 10), 'allowedTokens invalid')) {
      // check if the tokens exist
      const tokens = await api.db.findInTable('tokens', 'tokens', {
        symbol: {
          $in: allowedTokens,
        },
      });

      if (api.assert(allowedTokens.length === tokens.length, 'invalid tokens')) {
        // check if the tokens have staking enabled
        const finaltAllowedTokens = tokens.filter(tkn => tkn.stakingEnabled === true);

        if (api.assert(finaltAllowedTokens.length > 0, 'none of the tokens have staking enabled')) {
          let comment = await api.db.findOne('comments', { commentID: `${author}/${permlink}` });
          if (api.assert(comment === null, 'comment already exists')) {
            const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);
            const timestampSec = blockDate.getTime() / 1000;

            comment = {
              commentID: `${author}/${permlink}`,
              creationTimestamp: timestampSec,
              allowedTokens: finaltAllowedTokens,
            };

            await api.db.insert('comments', comment);
          }
        }
      }
    }
  }
};
