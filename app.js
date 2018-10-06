const nodeCleanup = require('node-cleanup');
const fs = require('fs-extra');
const { fork } = require('child_process');
const database = require('./plugins/Database');
const blockchain = require('./plugins/Blockchain');
const jsonRPCServer = require('./plugins/JsonRPCServer');
const streamer = require('./plugins/Streamer');

const conf = require('./config');

const plugins = {};

const jobs = new Map();
let currentJobId = 0;

function send(plugin, message) {
  const newMessage = {
    ...message,
    to: plugin.name,
    from: 'MASTER',
    type: 'request',
  };
  currentJobId += 1;
  newMessage.jobId = currentJobId;
  plugin.cp.send(newMessage);
  return new Promise((resolve) => {
    jobs.set(currentJobId, {
      message: newMessage,
      resolve,
    });
  });
}


// function to route the IPC requests
const route = (message) => {
  // console.log(message);
  const { to, type, jobId } = message;
  if (to) {
    if (to === 'MASTER') {
      if (type && type === 'request') {
        // do something
      } else if (type && type === 'response' && jobId) {
        const job = jobs.get(jobId);
        if (job && job.resolve) {
          const { resolve } = job;
          jobs.delete(jobId);
          resolve(message);
        }
      }
    } else if (type && type === 'broadcast') {
      plugins.forEach((plugin) => {
        plugin.cp.send(message);
      });
    } else if (plugins[to]) {
      plugins[to].cp.send(message);
    } else {
      console.error('ROUTING ERROR: ', message);
    }
  }
};

const loadPluging = (newPlugin) => {
  const plugin = {};
  plugin.name = newPlugin.PLUGIN_NAME;
  plugin.cp = fork(newPlugin.PLUGIN_PATH, [], { silent: true, detached: true });
  plugin.cp.on('message', msg => route(msg));
  plugin.cp.stdout.on('data', data => console.log(`[${newPlugin.PLUGIN_NAME}]`, data.toString()));
  plugin.cp.stderr.on('data', data => console.error(`[${newPlugin.PLUGIN_NAME}]`, data.toString()));

  plugins[newPlugin.PLUGIN_NAME] = plugin;

  return send(plugin, { action: 'init', payload: conf });
};

const unloadPlugin = plugin => new Promise(async (resolve) => {
  let res = null;
  if (plugins[plugin.PLUGIN_NAME]) {
    let plg = plugins[plugin.PLUGIN_NAME];

    res = await send(plg, { action: 'stop' });
    plg.cp.kill('SIGINT');
    plg = null;
  }

  resolve(res);
});

// load the plugins
async function start() {
  let res = await loadPluging(database);
  if (res && res.payload === null) {
    res = await loadPluging(blockchain);
    if (res && res.payload === null) {
      res = await loadPluging(streamer);
      if (res && res.payload === null) {
        res = await loadPluging(jsonRPCServer);
      }
    }
  }
}

async function stop(callback) {
  await unloadPlugin(jsonRPCServer);
  // get the last Steem block parsed
  const res = await unloadPlugin(streamer);
  await unloadPlugin(blockchain);
  await unloadPlugin(database);
  callback(res.payload);
}

start();

nodeCleanup((exitCode, signal) => {
  if (signal) {
    console.log('Closing App... ', exitCode, signal); // eslint-disable-line

    stop((lastBlockParsed) => {
      const config = fs.readJSONSync('./config.json');
      config.startSteemBlock = lastBlockParsed;
      fs.writeJSONSync('./config.json', config);

      // calling process.exit() won't inform parent process of signal
      process.kill(process.pid, signal);
    });

    nodeCleanup.uninstall(); // don't call cleanup handler again
    return false;
  }

  return true;
});
