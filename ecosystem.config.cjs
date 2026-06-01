module.exports = {
  apps: [{
    name: 'wechat-server',
    script: 'dist/index.js',
    cwd: '/www/wwwroot/0223wechat-server',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      PORT: 8199,
    },
    // 日志配置
    error_file: '/root/.pm2/logs/wechat-server-error.log',
    out_file: '/root/.pm2/logs/wechat-server-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    // 自动重启策略
    min_uptime: '10s',
    max_restarts: 10,
    restart_delay: 3000,
  }]
};
