#!/usr/bin/python3

import requests
import json

from decimal import *


apiUrl = 'https://api.steem-engine.com/rpc2/contracts/'

excludedAccounts = { 'steem-peg': 1 }

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

def getBalances():
    index = 0
    limit = 1000
    balanceData = {}

    while True:
        r = fetchData('tokens', 'balances', index, limit, {'symbol': 'STEEMP'})
        index = index + limit
        for data in r:
            balance = Decimal(data['balance'])
            quantizedBalance = balance.quantize(Decimal('0.00000001'), rounding=ROUND_HALF_DOWN)
            balanceData[data['account']] = quantizedBalance

        if len(r) < limit:
            break

    return balanceData

def addMarketBalances(accountData):
    index = 0
    limit = 1000

    while True:
        r = fetchData('market', 'buyBook', index, limit, {})
        index = index + limit
        for data in r:
            balance = Decimal(data['tokensLocked'])
            quantizedBalance = balance.quantize(Decimal('0.00000001'), rounding=ROUND_HALF_DOWN)
            if data['account'] in accountData:
                accountData[data['account']] = accountData[data['account']] + quantizedBalance
            else:
                accountData[data['account']] = quantizedBalance

        if len(r) < limit:
            break

def addPendingWithdrawBalances(accountData):
    index = 0
    limit = 1000

    while True:
        r = fetchData('steempegged', 'withdrawals', index, limit, {'type': 'STEEM'})
        index = index + limit
        for data in r:
            balance = Decimal(data['quantity'])
            quantizedBalance = balance.quantize(Decimal('0.00000001'), rounding=ROUND_HALF_DOWN)
            if data['recipient'] in accountData:
                accountData[data['recipient']] = accountData[data['recipient']] + quantizedBalance
            else:
                accountData[data['recipient']] = quantizedBalance

        if len(r) < limit:
            break

if __name__ == '__main__':
    accountData = getBalances()
    addMarketBalances(accountData)
    addPendingWithdrawBalances(accountData)
    
    # output final results
    count = 0
    balanceTotal = Decimal('0.00000000')
    for account in sorted(accountData):
        if accountData[account] > Decimal(0) and account not in excludedAccounts:
            finalBalance = accountData[account].quantize(Decimal('0.00000001'), rounding=ROUND_HALF_DOWN)
            print(account, '{0:f}'.format(finalBalance))
            balanceTotal = balanceTotal + finalBalance
            count += 1

    print('')
    print(count, 'accounts total')
    print('{0:f}'.format(balanceTotal), 'STEEMP total\n')
