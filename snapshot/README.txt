To do snapshot:

./steemp_snapshot.py > snapshot.log

sample cron job definition for snapshot:

0 14 20 3 * ~/steemsmartcontracts/snapshot/steemp_snapshot.py > ~/logs/steemp_snapshot/snapshot_$(date +"\%FT\%H-\%M-\%S").log 2>&1

---------------------------------------------
To do HIVEP airdrop:

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
