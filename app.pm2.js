module.exports = {
  apps: [{
    name: 'Steem Smart Contracts',
    script: 'app.js',
    kill_timeout: 60000,
    treekill: false,
    env: {
      NODE_ENV: 'development',
    },
    env_production: {
      NODE_ENV: 'production',
    },
  }],
};
