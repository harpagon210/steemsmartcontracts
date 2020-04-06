#!/usr/bin/python3

import operator
import argparse
import requests
import json

from decimal import *


apiUrl = 'https://api.steem-engine.com/rpc2/contracts/'

excludedAccounts = { 'null': 1, 'steemsc': 1, 'steem-tokens': 1, 'steem-peg': 1, 'deepcrypto8': 1 }

# start parsing command line arguments
parser = argparse.ArgumentParser()
parser.add_argument('-s', '--symbol', help='Steem Engine token symbol to snapshot', default='', nargs=1)
parser.add_argument('-o', '--order',  help='Order accounts by balance (largest first), instead of alphabetically', default=False, action='store_true')
args = parser.parse_args()

def fetchData(contract, table, offset, limit, query):
    data = []

    try:
        params = {
            'jsonrpc': '2.0',
            'method': 'find',
            'params': {
                'contract': contract,
                'table': table,
                'query': query,
                'limit': limit,
                'offset': offset,
                'indexes': [{ 'index': '_id', 'descending': False }]
                },
            'id': 1
            }

        r = requests.post(apiUrl, json = params)
        data = r.json()['result']
    except Exception as e:
        print('got exception fetching data with contract[%s], table[%s], offset[%s], limit[%s], query[%s]' % (contract, table, offset, limit, query))
    
    return data

def getTokenInfo(symbol):
    r = fetchData('tokens', 'tokens', 0, 1, {'symbol': symbol})
    if len(r) != 1:
        return None
    return r[0]

def getBalances(symbol, unitAmount):
    index = 0
    limit = 1000
    balanceData = {}

    while True:
        r = fetchData('tokens', 'balances', index, limit, {'symbol': symbol})
        index = index + limit
        for data in r:
            balance = Decimal(data['balance'])
            if 'stake' in data:
                balance = balance + Decimal(data['stake'])
            if 'pendingUnstake' in data:
                balance = balance + Decimal(data['pendingUnstake'])
            if 'delegationsOut' in data:
                balance = balance + Decimal(data['delegationsOut'])
            if 'pendingUndelegations' in data:
                balance = balance + Decimal(data['pendingUndelegations'])
            if 'delegatedStake' in data:
                balance = balance + Decimal(data['delegatedStake'])   # old style of recording delegations
            quantizedBalance = balance.quantize(unitAmount, rounding=ROUND_HALF_DOWN)
            balanceData[data['account']] = quantizedBalance

        if len(r) < limit:
            break

    return balanceData

def addMarketBalances(accountData, symbol, unitAmount):
    index = 0
    limit = 1000

    while True:
        r = fetchData('market', 'sellBook', index, limit, {'symbol': symbol})
        index = index + limit
        for data in r:
            balance = Decimal(data['quantity'])
            quantizedBalance = balance.quantize(unitAmount, rounding=ROUND_HALF_DOWN)
            if data['account'] in accountData:
                accountData[data['account']] = accountData[data['account']] + quantizedBalance
            else:
                accountData[data['account']] = quantizedBalance

        if len(r) < limit:
            break

if __name__ == '__main__':
    if len(args.symbol) != 1:
        print('must specify a token symbol to snapshot')
        quit()

    symbol = args.symbol[0]
    token = getTokenInfo(symbol)
    if token is None:
        print(symbol, 'is not a valid symbol')
        quit()

    unitAmount = Decimal(10) ** (-token['precision'])

    # exclude token's issuing account from the snapshot (this is most likely the account that
    # will distribute the airdrop)
    excludedAccounts[token['issuer']] = 1

    print(symbol, 'snapshot')
    print('')

    accountData = getBalances(symbol, unitAmount)
    addMarketBalances(accountData, symbol, unitAmount)
    
    # output final results
    count = 0
    balanceTotal = Decimal('0')
    if args.order:
        # sort in descending order of account balances
        sortedAccountData = sorted(accountData.items(), key=operator.itemgetter(1), reverse=True)
        for data in sortedAccountData:
            account = data[0]
            balance = data[1]
            if balance > Decimal(0) and account not in excludedAccounts:
                finalBalance = balance.quantize(unitAmount, rounding=ROUND_HALF_DOWN)
                print(account, '{0:f}'.format(finalBalance))
                balanceTotal = balanceTotal + finalBalance
                count += 1
    else:
        # sort alphabetically (default option)
        for account in sorted(accountData):
            if accountData[account] > Decimal(0) and account not in excludedAccounts:
                finalBalance = accountData[account].quantize(unitAmount, rounding=ROUND_HALF_DOWN)
                print(account, '{0:f}'.format(finalBalance))
                balanceTotal = balanceTotal + finalBalance
                count += 1

    print('')
    print(count, 'accounts total')
    balanceTotal = balanceTotal.quantize(unitAmount, rounding=ROUND_HALF_DOWN)
    print('{0:f}'.format(balanceTotal), symbol, 'total\n')
