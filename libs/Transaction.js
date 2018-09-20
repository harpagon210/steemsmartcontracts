const SHA256 = require('crypto-js/sha256');

class Transaction {
  constructor(refSteemBlockNumber, transactionId, sender, contract, action, payload) {
    this.refSteemBlockNumber = refSteemBlockNumber;
    this.transactionId = transactionId;
    this.sender = sender;
    this.contract = typeof contract === 'string' ? contract : null;
    this.action = typeof action === 'string' ? action : null;
    this.payload = typeof payload === 'string' ? payload : null;
    this.hash = this.calculateHash();
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

    this.logs = JSON.stringify(finalLogs);
  }

  // calculate the hash of the transaction
  calculateHash() {
    return SHA256(
      this.refSteemBlockNumber
      + this.transactionId
      + this.sender
      + this.contract
      + this.action
      + this.payload,
    )
      .toString();
  }
}

module.exports.Transaction = Transaction;
