// pm2 部署示例：pm2 start deploy/ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'rtk-config',
      cwd: '/root/ppp_station_monitor/rtk_config',
      script: 'server.js',
      instances: 1,          // 有内存状态（调度器/进程表），必须单实例
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 5000,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info'
        // MYSQL_PASSWORD: 'xxxx'
      },
      out_file: '/var/log/rtk-config.out.log',
      error_file: '/var/log/rtk-config.err.log',
      merge_logs: true
    }
  ]
};
