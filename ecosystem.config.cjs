module.exports = {
  apps: [
    {
      name: 'btc-scalping-bot',
      script: 'src/main.js',
      node_args: '--env-file-if-exists=.env',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      restart_delay: 5000,
      max_restarts: 10,
      autorestart: true,
      watch: false,
    },
  ],
};
