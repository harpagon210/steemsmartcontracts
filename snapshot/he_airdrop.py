#!/usr/bin/python3

import argparse
import time

from beem import Steem
from beem.instance import set_shared_steem_instance
from steemengine.api import Api
from steemengine.wallet import Wallet
from steemengine.tokenobject import Token

from decimal import *


heRpcUrl = 'https://api.hive-engine.com/rpc/'
hiveNode = 'https://api.hive.blog'
chainId = 'ssc-mainnet-hive'

# start parsing command line arguments
parser = argparse.ArgumentParser()

# command line arguments
parser.add_argument('-m', '--mock',    help='Turn on mock mode (for doing a dry run)', default=False, action='store_true')
parser.add_argument('-i', '--input',   help='Snapshot filename to process', default='', nargs=1)
parser.add_argument('-a', '--account', help='Hive account to send tokens from', default='', nargs=1)
args = parser.parse_args()

def log(text, fp):
    print(str(text))
    fp.write(str(text) + '\n')

def getHeWalletTokenBalance(heWallet, symbol):
    balance = Decimal(0)
    token = heWallet.get_token(symbol)
    if token is not None:
        tokenObj = Token(symbol, api=heWallet.api)
        balance = tokenObj.quantize(token['balance'])
    return balance

# amount should be a Decimal
def heSend(heWallet, destAccount, amount, symbol, memo, isMock, fp):
    isSuccess = False

    counter = 0
    while counter < 3 and not isSuccess:
        counter = counter + 1
        if counter > 1:
            time.sleep(5)

        try:
            heWallet.refresh()
            if not isMock:
                result = heWallet.transfer(destAccount, amount, symbol, memo)
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
        print('must specify a source Hive account')
        quit()

    inputFilename = args.input[0]
    srcAccount = args.account[0]
    symbol = ''

    fp = open('airdrop_output.log', 'w')

    log('Will send tokens from @%s' % (srcAccount,), fp)
    log('Reading snapshot data from %s' % (inputFilename,), fp)

    with open(inputFilename, 'r') as inputContents:
        contents = inputContents.readlines()
    
    # parse input data from snapshot
    accountData = []
    tokenTotal = Decimal('0')
    for line in contents:
        data = line.strip().split(' ')
        if len(data) == 2:
            if(data[1] == 'snapshot'):
                symbol = data[0]
                log('Airdrop is for %s tokens' % (symbol,), fp)
                continue
            accountData.append([data[0], Decimal(data[1])])
        elif len(data) == 3 and data[1] == symbol:
            tokenTotal = Decimal(data[0])

    log('Counted %s accounts with %s %s total' % (len(accountData), '{0:f}'.format(tokenTotal), symbol), fp)

    # connect to Hive Engine
    try:
        stm = Steem(hiveNode)
        set_shared_steem_instance(stm)

        stm.wallet.unlock('password')   # TODO: put your wallet password here

        heApi = Api(rpcurl=heRpcUrl)
        heWallet = Wallet(srcAccount, api=heApi, steem_instance=stm)
        heWallet.set_id(chainId)
        heBalance = getHeWalletTokenBalance(heWallet, symbol)
    except Exception as e:
        log('Got exception connecting to Hive network: %s' % (e,), fp)
        fp.close()
        quit()

    # make sure source account has enough tokens
    log('%s balance of Hive Engine %s account = %s' % (symbol, srcAccount, '{0:f}'.format(heBalance)), fp)
    if not args.mock and tokenTotal > heBalance:
        log('FAILED!! %s does not have enough %s to cover the airdrop. Please issue more %s and then try again. Quitting...' % (srcAccount, symbol, symbol), fp)
        fp.close()
        quit()

    # send out the tokens
    countSuccess = 0
    countFailed = 0
    for data in accountData:
        account = data[0]
        tokensToSend = data[1]
        if tokensToSend > Decimal(0):
            log('sending %s %s to %s' % ('{0:f}'.format(tokensToSend), symbol, account), fp)
            isTransferSuccess = heSend(heWallet, account, tokensToSend, symbol, 'airdrop based on Steem Engine %s holdings' % (symbol,), args.mock, fp)
            if isTransferSuccess:
                countSuccess += 1
                log('Hive Engine transfer SUCCESS', fp)
            else:
                countFailed += 1
                log('Hive Engine transfer FAILED!!', fp)
            if not args.mock:
                time.sleep(5)    # don't want to spam transactions too quickly or they might fail

    if countFailed == 0:
        log('all transfers SUCCESS', fp)
    else:
        log('at least one transfer FAILED!! please review log', fp)
    log('success count: %s' % (countSuccess,), fp)
    log('failure count: %s' % (countFailed,), fp)

    fp.close()
