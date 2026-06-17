module.exports = {
  apps: [{
    name: 'organicwar-io',
    script: 'server/server.js',
    instances: 1,       // one process — WASM rooms are multi-threaded internally
    autorestart: true,
    watch: false,
    restart_delay: 5000,          // wait 5s before restarting after a crash
    max_memory_restart: '512M',   // restart if RSS exceeds 512 MB
    kill_timeout: 5000,           // give gracefulShutdown 5s before SIGKILL

    // Log files (PM2 log rotation: pm2 install pm2-logrotate)
    error_file: 'logs/pm2-error.log',
    out_file:   'logs/pm2-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

    env: {
      NODE_ENV: 'development',
      PORT: 3000,
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000,
      MAX_CONCURRENT_ROOMS: 10,
      MAX_CONNECTIONS_PER_IP: 5,
      LOG_LEVEL: 'info',
    },
  }],
};
