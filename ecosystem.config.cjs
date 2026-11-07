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
    {
      // Swing bot R3 + Breakout (spot, daily). Reads .env itself — works on any Node >= 20, Linux & macOS.
      // pm2 start ecosystem.config.cjs --only swing-bot
      name: 'swing-bot',
      script: 'swing/src/main.js',
      cwd: __dirname,
      env: { NODE_ENV: 'production' },
      autorestart: true,
      restart_delay: 10000,
      exp_backoff_restart_delay: 2000,
      max_restarts: 50,
      min_uptime: '60s',
      kill_timeout: 15000,
      time: true,
      watch: false,
      max_memory_restart: '300M',
    },
  ],
};
