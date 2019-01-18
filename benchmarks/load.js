require('dotenv').config();
const nodeCleanup = require('node-cleanup');
const fs = require('fs-extra');
const { fork } = require('child_process');
const database = require('../plugins/Database');
const blockchain = require('../plugins/Blockchain');
const jsonRPCServer = require('../plugins/JsonRPCServer');
const streamer = require('../plugins/Streamer.simulator');

const conf = require('./config');

const plugins = {};

const jobs = new Map();
let currentJobId = 0;

// send an IPC message to a plugin with a promise in return
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

const getPlugin = (plugin) => {
  if (plugins[plugin.PLUGIN_NAME]) {
    return plugins[plugin.PLUGIN_NAME];
  }

  return null;
};

const loadPlugin = (newPlugin) => {
  const plugin = {};
  plugin.name = newPlugin.PLUGIN_NAME;
  plugin.cp = fork(newPlugin.PLUGIN_PATH, [], { silent: true, detached: true });
  plugin.cp.on('message', msg => route(msg));
  plugin.cp.stdout.on('data', data => console.log(`[${newPlugin.PLUGIN_NAME}]`, data.toString()));
  plugin.cp.stderr.on('data', data => console.error(`[${newPlugin.PLUGIN_NAME}]`, data.toString()));

  plugins[newPlugin.PLUGIN_NAME] = plugin;

  return send(plugin, { action: 'init', payload: conf });
};

const unloadPlugin = async (plugin) => {
  let res = null;
  let plg = getPlugin(plugin);
  if (plg) {
    res = await send(plg, { action: 'stop' });
    plg.cp.kill('SIGINT');
    plg = null;
  }

  return res;
};

// start streaming the Steem blockchain and produce the sidechain blocks accordingly
async function start() {
  let res = await loadPlugin(database);
  if (res && res.payload === null) {
    res = await loadPlugin(blockchain);
    await send(getPlugin(database),
      { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });
    res = await send(getPlugin(blockchain),
      { action: blockchain.PLUGIN_ACTIONS.START_BLOCK_PRODUCTION });
    if (res && res.payload === null) {
      res = await loadPlugin(streamer);
      if (res && res.payload === null) {
        res = await loadPlugin(jsonRPCServer);
      }
    }
  }
}

async function stop(callback) {
  await unloadPlugin(jsonRPCServer);
  const res = await unloadPlugin(streamer);
  await unloadPlugin(blockchain);
  await unloadPlugin(database);
  callback(res.payload);
}

function saveConfig(lastBlockParsed) {
  const config = fs.readJSONSync('./config.json');
  config.startSteemBlock = lastBlockParsed;
  fs.writeJSONSync('./config.json', config, { spaces: 4 });
}

function stopApp(signal = 0) {
  stop((lastBlockParsed) => {
    saveConfig(lastBlockParsed);
    // calling process.exit() won't inform parent process of signal
    process.kill(process.pid, signal);
  });
}

start();

// graceful app closing
nodeCleanup((exitCode, signal) => {
  if (signal) {
    console.log('Closing App... ', exitCode, signal); // eslint-disable-line

    stopApp();

    nodeCleanup.uninstall(); // don't call cleanup handler again
    return false;
  }

  return true;
});
