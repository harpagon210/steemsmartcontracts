const dsteem = require('dsteem');
const { Queue } = require('./Queue');

class ForkException {
  constructor(message) {
    this.error = 'ForkException';
    this.message = message;
  }
}

class Streamer {
  constructor(nodeUrl, currentBlock, antiForkBufferMaxSize = 2, pollingTime = 500) {
    this.antiForkBufferMaxSize = antiForkBufferMaxSize;
    this.buffer = new Queue(antiForkBufferMaxSize);
    this.blocks = new Queue();
    this.currentBlock = currentBlock;
    this.pollingTime = pollingTime;
    this.headBlockNumber = 0;
    this.client = new dsteem.Client(nodeUrl);

    this.updaterGlobalProps = null;
    this.poller = null;
  }

  async init() {
    await this.updateGlobalProps();
    this.updaterGlobalProps = setInterval(() => this.updateGlobalProps(), 3000);
  }

  stop() {
    if (this.poller) clearTimeout(this.poller);
    if (this.updaterGlobalProps) clearInterval(this.updaterGlobalProps);
  }

  async updateGlobalProps() {
    try {
      const globProps = await this.client.database.getDynamicGlobalProperties();
      this.headBlockNumber = globProps.head_block_number;
    } catch (ex) {
      console.error('An error occured while trying to fetch the Steem blockchain global properties'); // eslint-disable-line no-console
    }
  }

  addBlock(block) {
    const finalBlock = block;
    finalBlock.blockNumber = this.currentBlock;

    if (this.buffer.size() + 1 > this.antiForkBufferMaxSize) {
      const lastBlock = this.buffer.last();

      if (lastBlock) {
        this.blocks.push(lastBlock);
        // console.log(lastBlock.blockNumber); // eslint-disable-line no-console
      }
    }
    this.buffer.push(finalBlock);
    this.currentBlock += 1;
  }

  getNextBlock() {
    return this.blocks.pop();
  }

  async stream(reject) {
    try {
      console.log('head_block_number', this.headBlockNumber); // eslint-disable-line no-console
      console.log('currentBlock', this.currentBlock); // eslint-disable-line no-console
      const delta = this.headBlockNumber - this.currentBlock;
      console.log(`Steem blockchain is ${delta > 0 ? delta : 0} block(s) ahead`); // eslint-disable-line no-console
      const block = await this.client.database.getBlock(this.currentBlock);
      let addBlockToBuffer = false;

      if (block) {
        // check if there are data in the buffer
        if (this.buffer.size() > 0) {
          const lastBlock = this.buffer.first();
          console.log('block_id', lastBlock.block_id); // eslint-disable-line no-console
          console.log('previous block_id', block.previous); // eslint-disable-line no-console
          if (lastBlock.block_id === block.previous) {
            addBlockToBuffer = true;
          } else {
            this.buffer.clear();
            throw new ForkException(`a fork happened between block ${this.currentBlock - 1} and block ${this.currentBlock}`);
          }
        } else {
          // get the previous block
          const prevBlock = await this.client.database.getBlock(this.currentBlock - 1);

          if (prevBlock && prevBlock.block_id === block.previous) {
            addBlockToBuffer = true;
          } else {
            throw new ForkException(`a fork happened between block ${this.currentBlock - 1} and block ${this.currentBlock}`);
          }
        }

        // add the block to the buffer
        if (addBlockToBuffer === true) {
          this.addBlock(block);
        }
      }

      this.poller = setTimeout(() => {
        this.stream(reject);
      }, this.pollingTime);

      console.log('-----------------------------------------------------------------------'); // eslint-disable-line no-console
    } catch (err) {
      reject(err);
    }
  }
}

module.exports.Streamer = Streamer;
