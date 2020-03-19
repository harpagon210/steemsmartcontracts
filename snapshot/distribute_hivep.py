#!/usr/bin/python3

import argparse
import time

from beem import Steem
from beem.instance import set_shared_steem_instance
from steemengine.api import Api
from steemengine.wallet import Wallet

from decimal import *


seRpcUrl = 'https://api.steem-engine.com/rpc2/'

# start parsing command line arguments
parser = argparse.ArgumentParser()

# command line arguments
parser.add_argument('-m', '--mock',    help='Turn on mock mode (for doing a dry run)', default=False, action='store_true')
parser.add_argument('-i', '--input',   help='Snapshot filename to process', default='', nargs=1)
parser.add_argument('-a', '--account', help='Steem account to send HIVEP from', default='', nargs=1)
args = parser.parse_args()

def log(text, fp):
    print(str(text))
    fp.write(str(text) + '\n')

def getSeWalletTokenBalance(seWallet):
    balance = Decimal(0)
    hivep_token = seWallet.get_token('HIVEP')
    if hivep_token is not None:
        balance = Decimal(hivep_token['balance'])
        balance = balance.quantize(Decimal('0.00000001'), rounding=ROUND_HALF_DOWN)
    return balance

# amount should be a Decimal
def seSend(seGwWallet, steemAccount, amount, memo, isMock, fp):
    isSuccess = False

    counter = 0
    while counter < 3 and not isSuccess:
        counter = counter + 1
        if counter > 1:
            time.sleep(5)

        try:
            seGwWallet.refresh()
            if not isMock:
                result = seGwWallet.transfer(steemAccount, amount, 'HIVEP', memo)
                log(result, fp)

            isSuccess = True
        except Exception as e:
            log('got exception on transfer attempt %s : %s' % (counter, e), fp)

    return isSuccess

if __name__ == '__main__':
    if len(args.input) != 1:
        print('must specify an input filename')
        quit()

    if len(args.account) != 1:
        print('must specify a source Steem account')
        quit()

    inputFilename = args.input[0]
    srcAccount = args.account[0]

    fp = open('airdrop_output.log', 'w')

    log('Will send HIVEP from @%s' % (srcAccount,), fp)
    log('Reading snapshot data from %s' % (inputFilename,), fp)

    with open(inputFilename, 'r') as inputContents:
        contents = inputContents.readlines()
    
    # parse input data from snapshot
    accountData = {}
    hiveTotal = Decimal('0.00000000')
    for line in contents:
        data = line.strip().split(' ')
        if len(data) == 2:
            accountData[data[0]] = Decimal(data[1])
        elif len(data) == 3 and data[1] == 'STEEMP':
            hiveTotal = Decimal(data[0])

    log('Counted %s accounts with %s HIVEP total' % (len(accountData), '{0:f}'.format(hiveTotal)), fp)

    # connect to Steem Engine
    try:
        stm = Steem()
        set_shared_steem_instance(stm)

        stm.wallet.unlock('password')   # TODO: put your wallet password here

        seApi = Api(rpcurl=seRpcUrl)
        seWallet = Wallet(srcAccount, api=seApi, steem_instance=stm)
        seBalance = getSeWalletTokenBalance(seWallet)
    except Exception as e:
        log('Got exception connecting to Steem network: %s' % (e,), fp)
        fp.close()
        quit()

    # make sure source account has enough HIVEP
    log('HIVEP balance of Steem Engine %s account = %s' % (srcAccount, '{0:f}'.format(seBalance)), fp)
    if not args.mock and hiveTotal > seBalance:
        log('FAILED!! %s does not have enough HIVEP to cover the airdrop. Please issue more HIVEP and then try again. Quitting...' % (srcAccount,), fp)
        fp.close()
        quit()

    # send out the HIVEP
    countSuccess = 0
    countFailed = 0
    for account in sorted(accountData):
        hivepToSend = accountData[account]
        if hivepToSend > Decimal(0):
            log('sending %s HIVEP to %s' % ('{0:f}'.format(hivepToSend), account), fp)
            isTransferSuccess = seSend(seWallet, account, hivepToSend, 'airdrop based on STEEMP holdings', args.mock, fp)
            if isTransferSuccess:
                countSuccess += 1
                log('Steem Engine transfer SUCCESS', fp)
            else:
                countFailed += 1
                log('Steem Engine transfer FAILED!!', fp)
            if not args.mock:
                time.sleep(5)    # don't want to spam transactions too quickly or they might fail

    if countFailed == 0:
        log('all transfers SUCCESS', fp)
    else:
        log('at least one transfer FAILED!! please review log', fp)
    log('success count: %s' % (countSuccess,), fp)
    log('failure count: %s' % (countFailed,), fp)

    fp.close()
