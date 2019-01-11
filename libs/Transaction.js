const SHA256 = require('crypto-js/sha256');
const enchex = require('crypto-js/enc-hex');

class Transaction {
  constructor(refSteemBlockNumber, transactionId, sender, contract, action, payload) {
    this.refSteemBlockNumber = refSteemBlockNumber;
    this.transactionId = transactionId;
    this.sender = sender;
    this.contract = typeof contract === 'string' ? contract : null;
    this.action = typeof action === 'string' ? action : null;
    this.payload = typeof payload === 'string' ? payload : null;
    this.executedCodeHash = '';
    this.hash = '';
    this.logs = {};
  }

  // add logs to the transaction
  // useful to get the result of the execution of a smart contract (events and errors)
  addLogs(logs) {
    const finalLogs = logs;
    if (finalLogs && finalLogs.errors && finalLogs.errors.length === 0) {
      delete finalLogs.errors;
    }

    if (finalLogs && finalLogs.events && finalLogs.events.length === 0) {
      delete finalLogs.events;
    }

    // TODO: add storage cost on logs
    // the logs can only store a total of 255 characters
    this.logs = JSON.stringify(finalLogs); // .substring(0, 255);
  }

  // calculate the hash of the transaction
  calculateHash() {
    this.hash = SHA256(
      this.refSteemBlockNumber
      + this.transactionId
      + this.sender
      + this.contract
      + this.action
      + this.payload
      + this.executedCodeHash
      + this.logs,
    )
      .toString(enchex);
  }
}

module.exports.Transaction = Transaction;
