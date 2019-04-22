class Queue {
  constructor(maxSize = 0) {
    this.data = [];
    this.maxSize = maxSize; // max size of 0 equals unlimited
  }

  push(record) {
    if (this.maxSize !== 0 && this.size() + 1 > this.maxSize) {
      this.pop();
    }

    this.data.push(record);
  }

  pop() {
    const size = this.size();

    if (size > 0) {
      const item = this.data[0];

      if (size > 1) {
        this.data = this.data.slice(1);
      } else {
        this.data = [];
      }
      return item;
    }

    return null;
  }

  first() {
    return this.size() > 0 ? this.data[this.data.length - 1] : null;
  }

  last() {
    return this.size() > 0 ? this.data[0] : null;
  }

  clear() {
    this.data.length = 0;
  }

  size() {
    return this.data.length;
  }
}

module.exports.Queue = Queue;
