class Queue {
  constructor(maxSize = 0) {
    this.data = [];
    this.maxSize = maxSize; // max size of 0 equals unlimited
  }

  push(record) {
    if (this.maxSize !== 0 && this.size() + 1 > this.maxSize) {
      this.pop();
    }

    this.data.unshift(record);
  }

  pop() {
    return this.size() > 0 ? this.data.pop() : null;
  }

  first() {
    return this.size() > 0 ? this.data[0] : null;
  }

  last() {
    return this.size() > 0 ? this.data[this.data.length - 1] : null;
  }

  clear() {
    this.data.length = 0;
  }

  size() {
    return this.data.length;
  }
}

module.exports.Queue = Queue;
