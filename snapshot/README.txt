To do snapshot of any Steem Engine token (excluding STEEMP):

./se_snapshot.py -s SYMBOL > snapshot.log

By default accounts will be ordered alphabetically in the snapshot file.
You can use the -o option to sort by account balance, with largest balance
first:

./se_snapshot.py -s SYMBOL -o > snapshot.log

Complete command line options:

usage: se_snapshot.py [-h] [-s SYMBOL] [-o]

optional arguments:
  -h, --help            show this help message and exit
  -s SYMBOL, --symbol SYMBOL
                        Steem Engine token symbol to snapshot
  -o, --order           Order accounts by balance (largest first), instead of
                        alphabetically

Snapshots take into account open market orders, stakes, delegations, pending unstakes,
and pending undelegations. The following accounts are excluded from each snapshot:

null, steemsc, steem-tokens, steem-peg, and deepcrypto8

In addition, the issuing account for each token is also excluded, since most likely
that's the account you would want to do an airdrop from on the Hive Engine side

---------------------------------------------
To do Hive Engine airdrop (using snapshot file produced by se_snapshot.py):

1. Install Python 3, beem library, and steemengine library. You'll want to use at
   least version 0.22.12 of beem, which supports Hive.

   https://github.com/holgern/beem
   https://github.com/holgern/steemengine

2. Ensure beem wallet is configured with active key for account to airdrop the tokens from

3. Issue enough tokens to the source account to cover the airdrop (total token amount will be
   listed in the snapshot file).

4. Open he_airdrop.py and find the following line:

   stm.wallet.unlock('password')   # TODO: put your wallet password here

   Replace 'password' with your beempy wallet password.

5. he_airdrop.py has some command line options:

   usage: he_airdrop.py [-h] [-m] [-i INPUT] [-a ACCOUNT]

   optional arguments:
     -h, --help            show this help message and exit
     -m, --mock            Turn on mock mode (for doing a dry run)
     -i INPUT, --input INPUT
                           Snapshot filename to process
     -a ACCOUNT, --account ACCOUNT
                           Hive account to send tokens from

6. To do a mock test run:

   ./he_airdrop.py -m -i snapshot.log -a fromaccount

   This will show the actual expected output, but not execute send transactions.
   Note that all output will also be saved in a file called airdrop_output.log.
   This file can be used to aid in error recovery if the airdrop crashes halfway
   through or something else unexpected happens.

   The snapshot file must have been previously produced by se_snapshot.py

7. To do the airdrop for real:

   ./he_airdrop.py -i snapshot.log -a fromaccount

   There is a 5 second pause between each send transaction, to ensure transactions
   don't fail from being performed too quickly. It may take several hours to complete
   an airdrop for a large snapshot. Do ensure the script can run uninterrupted
   for that time period, and the sending account has enough RCs.

---------------------------------------------
To do snapshot of STEEMP:

./steemp_snapshot.py > snapshot.log

sample cron job definition for snapshot:

0 14 20 3 * ~/steemsmartcontracts/snapshot/steemp_snapshot.py > ~/logs/steemp_snapshot/snapshot_$(date +"\%FT\%H-\%M-\%S").log 2>&1

---------------------------------------------
To do HIVEP airdrop on Steem Engine:

1. Install Python 3, beem library, and steemengine library

2. Ensure beem wallet is configured with active key for account to airdrop the HIVEP from

3. Issue enough HIVEP to the source account to cover the airdrop (total HIVEP amount will be
   listed in the snapshot file).

4. Open distribute_hivep.py and find the following line:

   stm.wallet.unlock('password')   # TODO: put your wallet password here

   Replace 'password' with your beempy wallet password.

5. distribute_hivep.py has some command line options:

   usage: distribute_hivep.py [-h] [-m] [-i INPUT] [-a ACCOUNT]

   optional arguments:
     -h, --help            show this help message and exit
     -m, --mock            Turn on mock mode (for doing a dry run)
     -i INPUT, --input INPUT
                           Snapshot filename to process
     -a ACCOUNT, --account ACCOUNT
                           Steem account to send HIVEP from

6. To do a mock test run:

   ./distribute_hivep.py -i snapshot.log -a steem-tokens -m

   This will show the actual expected output, but not execute send transactions.
   Note that all output will also be saved in a file called airdrop_output.log.
   This file can be used to aid in error recovery if the airdrop crashes halfway
   through or something.

7. To do the airdrop for real:

   ./distribute_hivep.py -i snapshot.log -a steem-tokens

   There is a 5 second pause between each send transaction, to ensure transactions
   don't fail from being performed too quickly. From snapshot trial runs, it is
   expected that the airdrop will take somewhere around 13 hours to complete given
   the number of transactions required. Do ensure the script can run uninterrupted
   for that time period, and the source account has enough RCs.
