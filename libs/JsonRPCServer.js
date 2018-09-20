const jayson = require('jayson');
const https = require('https');
const http = require('http');
const cors = require('cors');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const {
  rpcNodePort,
  keyCertificate,
  certificate,
  chainCertificate,
} = require('../config');

class JsonRPCServer {
  constructor(steemSmartContracts) {
    this.steemSmartContracts = steemSmartContracts;
  }

  blockchainRPC() {
    return {
      getLatestBlockInfo: (args, callback) => {
        const res = this.steemSmartContracts.getLatestBlockInfo();
        callback(null, res);
      },

      getBlockInfo: (args, callback) => {
        const { blockNumber } = args;

        if (Number.isInteger(blockNumber)) {
          const res = this.steemSmartContracts.getBlockInfo(blockNumber);
          callback(null, res);
        } else {
          callback({
            code: 400,
            message: 'missing or wrong parameters: blockNumber is required',
          }, null);
        }
      },
    };
  }

  contractsRPC() {
    return {
      getContract: (args, callback) => {
        const { contract } = args;

        if (contract && typeof contract === 'string') {
          const res = this.steemSmartContracts.getContract(contract);
          callback(null, res);
        } else {
          callback({
            code: 400,
            message: 'missing or wrong parameters: contract is required',
          }, null);
        }
      },

      findOneInTable: (args, callback) => {
        const { contract, table, query } = args;

        if (contract && typeof contract === 'string'
          && table && typeof table === 'string'
          && query && typeof query === 'object') {
          const res = this.steemSmartContracts.findOneInTable(contract, table, query);
          callback(null, res);
        } else {
          callback({
            code: 400,
            message: 'missing or wrong parameters: contract and tableName are required',
          }, null);
        }
      },

      findInTable: (args, callback) => {
        const {
          contract,
          table,
          query,
          limit,
          offset,
          index,
          descending,
        } = args;

        if (contract && typeof contract === 'string'
          && table && typeof table === 'string'
          && query && typeof query === 'object') {
          const lim = limit || 1000;
          const off = offset || 0;
          const ind = index || '';
          const desc = descending || false;
          const res = this.steemSmartContracts.findInTable(
            contract, table, query, lim, off, ind, desc,
          );
          callback(null, res);
        } else {
          callback({
            code: 400,
            message: 'missing or wrong parameters: contract and tableName are required',
          }, null);
        }
      },
    };
  }

  StartServer() {
    const app = express();
    app.use(cors({ methods: ['POST'] }));
    app.use(bodyParser.urlencoded({ extended: true }));
    app.use(bodyParser.json());
    app.post('/blockchain', jayson.server(this.blockchainRPC()).middleware());
    app.post('/contracts', jayson.server(this.contractsRPC()).middleware());

    if (keyCertificate === '' || certificate === '' || chainCertificate === '') {
      http.createServer(app)
        .listen(rpcNodePort, () => {
          console.log(`RPC Node now listening on port ${rpcNodePort}`); // eslint-disable-line
        });
    } else {
      https.createServer({
        key: fs.readFileSync(keyCertificate),
        cert: fs.readFileSync(certificate),
        ca: fs.readFileSync(chainCertificate),
      }, app)
        .listen(rpcNodePort, () => {
          console.log(`RPC Node now listening on port ${rpcNodePort}`); // eslint-disable-line
        });
    }
  }
}

module.exports.JsonRPCServer = JsonRPCServer;
