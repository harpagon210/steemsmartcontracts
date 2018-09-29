const fs = require('fs');
const readline = require('readline');
const stream = require('stream');

class Replay {
  constructor(type) {
    this.type = type;
    this.stop = false;
  }

  start(callback) {
    if (this.type === 'file') {
      Replay.replayFile(callback);
    }
  }

  stop() {
    this.stop = true;
  }

  static replayFile(callback) {
    let instream;
    let outstream;
    let rl;

    // make sure file exists
    const fileName = './blocks.log';
    fs.stat(fileName, (err, stats) => {
      if (!err && stats.isFile()) {
        instream = fs.createReadStream(fileName);
        outstream = new stream(); // eslint-disable-line new-cap
        rl = readline.createInterface(instream, outstream);

        rl.on('line', (line) => {
          if (line !== '') {
            const block = JSON.parse(line);
            if (block.blockNumber !== 0) {
              callback({
                blockNumber: block.blockNumber,
                // we timestamp the block with the Steem block timestamp
                timestamp: block.timestamp,
                transactions: block.transactions,
              });
            }
          }
        });

        rl.on('close', () => {
          callback(null);
        });
      } else {
        // file does not exist, so callback with null
        callback(null);
      }
    });
  }
}

module.exports.Replay = Replay;
