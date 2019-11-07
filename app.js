require('dotenv').config();
const nodeCleanup = require('node-cleanup');
const fs = require('fs-extra');
const program = require('commander');
const { fork } = require('child_process');
const { createLogger, format, transports } = require('winston');
const packagejson = require('./package.json');
const database = require('./plugins/Database');
const blockchain = require('./plugins/Blockchain');
const jsonRPCServer = require('./plugins/JsonRPCServer');
const streamer = require('./plugins/Streamer');
const replay = require('./plugins/Replay');
const p2p = require('./plugins/P2P');

const conf = require('./config');

const logger = createLogger({
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(
          info => `${info.timestamp} ${info.level}: ${info.message}`,
        ),
      ),
    }),
    new transports.File({
      filename: 'node_app.log',
      format: format.combine(
        format.printf(
          info => `${info.timestamp} ${info.level}: ${info.message}`,
        ),
      ),
    }),
  ],
});

const plugins = {};

const jobs = new Map();
let currentJobId = 0;

// send an IPC message to a plugin with a promise in return
const send = (plugin, message) => {
  const newMessage = {
    ...message,
    to: plugin.name,
    from: 'MASTER',
    type: 'request',
  };
  currentJobId += 1;
  if (currentJobId > Number.MAX_SAFE_INTEGER) {
    currentJobId = 1;
  }
  newMessage.jobId = currentJobId;
  plugin.cp.send(newMessage);
  return new Promise((resolve) => {
    jobs.set(currentJobId, {
      message: newMessage,
      resolve,
    });
  });
};

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
      logger.error(`ROUTING ERROR: ${message}`);
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
  plugin.cp.on('error', err => logger.error(`[${newPlugin.PLUGIN_NAME}]`, err));
  plugin.cp.stdout.on('data', (data) => {
    logger.info(`[${newPlugin.PLUGIN_NAME}] ${data.toString()}`);
  });
  plugin.cp.stderr.on('data', (data) => {
    logger.error(`[${newPlugin.PLUGIN_NAME}] ${data.toString()}`);
  });

  plugins[newPlugin.PLUGIN_NAME] = plugin;

  return send(plugin, { action: 'init', payload: conf });
};

const unloadPlugin = async (plugin, signal) => {
  let res = null;
  let plg = getPlugin(plugin);
  if (plg) {
    res = await send(plg, { action: 'stop' });
    plg.cp.kill(signal);
    plg = null;
  }

  return res;
};

// start streaming the Steem blockchain and produce the sidechain blocks accordingly
const start = async () => {
  let res = await loadPlugin(database);
  if (res && res.payload === null) {
    res = await loadPlugin(blockchain);
    await send(getPlugin(database),
      { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });
    if (res && res.payload === null) {
      res = await loadPlugin(streamer);
      if (res && res.payload === null) {
        res = await loadPlugin(p2p);
        if (res && res.payload === null) {
          res = await loadPlugin(jsonRPCServer);
        }
      }
    }
  }
};

const stop = async (signal) => {
  await unloadPlugin(jsonRPCServer, signal);
  await unloadPlugin(p2p, signal);
  // get the last Steem block parsed
  let res = null;
  const streamerPlugin = getPlugin(streamer);
  if (streamerPlugin) {
    res = await unloadPlugin(streamer, signal);
  } else {
    res = await unloadPlugin(replay, signal);
  }

  await unloadPlugin(blockchain, signal);
  await unloadPlugin(database, signal);

  return res.payload;
};

const saveConfig = (lastBlockParsed) => {
  logger.info('Saving config');
  const config = fs.readJSONSync('./config.json');
  config.startSteemBlock = lastBlockParsed;
  fs.writeJSONSync('./config.json', config, { spaces: 4 });
};

const stopApp = async (signal = 0) => {
  const lastBlockParsed = await stop(signal);
  saveConfig(lastBlockParsed);
  // calling process.exit() won't inform parent process of signal
  process.kill(process.pid, signal);
};

// replay the sidechain from a blocks log file
const replayBlocksLog = async () => {
  let res = await loadPlugin(database);
  if (res && res.payload === null) {
    res = await loadPlugin(blockchain);
    await send(getPlugin(database),
      { action: database.PLUGIN_ACTIONS.GENERATE_GENESIS_BLOCK, payload: conf });
    if (res && res.payload === null) {
      await loadPlugin(replay);
      res = await send(getPlugin(replay),
        { action: replay.PLUGIN_ACTIONS.REPLAY_FILE });
      stopApp();
    }
  }
};

// manage the console args
program
  .version(packagejson.version)
  .option('-r, --replay [type]', 'replay the blockchain from [file]', /^(file)$/i)
  .parse(process.argv);

if (program.replay !== undefined) {
  replayBlocksLog();
} else {
  start();
}

// graceful app closing
nodeCleanup((exitCode, signal) => {
  if (signal) {
    logger.info(`Closing App...  exitCode: ${exitCode} signal: ${signal}`);

    stopApp(signal);

    nodeCleanup.uninstall(); // don't call cleanup handler again
    return false;
  }

  return true;
});
