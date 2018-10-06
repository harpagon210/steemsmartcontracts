class IPC {
  constructor(ipcId) {
    this.ipcId = ipcId;
    this.jobs = new Map();
    this.currentJobId = 0;
  }

  send(message) {
    const newMessage = { ...message, from: this.ipcId, type: 'request' };
    this.currentJobId += 1;
    newMessage.jobId = this.currentJobId;
    // console.log(newMessage.jobId, newMessage.to, newMessage.from, newMessage.type )
    process.send(newMessage);
    return new Promise((resolve) => {
      this.jobs.set(this.currentJobId, {
        message: newMessage,
        resolve,
      });
    });
  }

  reply(message, payload = null) {
    const { from, to } = message;
    const newMessage = {
      ...message,
      from: to,
      to: from,
      type: 'response',
      payload,
    };
    // console.log(newMessage.jobId, newMessage.to, newMessage.from, newMessage.type )

    this.sendWithoutResponse(newMessage);
  }

  broadcast(message) {
    this.sendWithoutResponse({ ...message, type: 'broadcast' });
  }

  sendWithoutResponse(message) {
    const newMessage = { ...message, from: this.ipcId };
    process.send(newMessage);
  }

  onReceiveMessage(callback) {
    process.on('message', (message) => {
      const { to, jobId, type } = message;

      if (to === this.ipcId) {
        if (type === 'request') {
          callback(message);
        } else if (type === 'response' && jobId) {
          const job = this.jobs.get(jobId);
          if (job && job.resolve) {
            const { resolve } = job;
            this.jobs.delete(jobId);
            // console.log(message)
            resolve(message);
          }
        }
      }
    });
  }
}

module.exports.IPC = IPC;
