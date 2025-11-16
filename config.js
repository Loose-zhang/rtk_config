// 环境配置文件
const path = require('path');

// 判断运行环境
const isLinux = process.platform === 'linux';
const isWindows = process.platform === 'win32';

// 配置项
const config = {
  // 服务器端口
  port: process.env.PORT || 3000,
  
  // 模板配置文件路径
  templatePath: process.env.TEMPLATE_PATH || (
    isLinux 
      ? '/root/ppp_station_monitor/auto_config/bbb.conf'
      : path.join(__dirname, 'bbb.conf')
  ),
  
  // 生成的配置文件存储目录
  generatedDir: process.env.GENERATED_DIR || (
    isLinux
      ? '/root/ppp_station_monitor/auto_config/generated'
      : path.join(__dirname, 'generated')
  ),
  
  // 静态文件目录
  publicDir: process.env.PUBLIC_DIR || path.join(__dirname, 'public'),
  
  // RTKRCV 可执行文件路径
  rtkcrvPath: process.env.RTKRCV_PATH || (
    isLinux
      ? '/root/ppp_station_monitor/auto_config/generated/rtkrcv'  // Linux 默认路径
      : 'rtkrcv.exe'  // Windows 从 PATH 或当前目录查找
  ),
  
  // RTKRCV 工作目录（启动时的当前目录）
  rtkcrvWorkDir: process.env.RTKRCV_WORKDIR || (
    isLinux
      ? '/root/ppp_station_monitor/auto_config/generated'
      : path.join(__dirname, 'generated')
  ),
  
  // CORS 配置
  corsOrigin: process.env.CORS_ORIGIN || '*',
  
  // 日志级别 (debug, info, warn, error)
  logLevel: process.env.LOG_LEVEL || 'debug',  // 默认 debug 以便排查问题

  // 稳定性判定参数
  // 连续固定解累积秒数阈值（允许短暂掉固定不清零）
  stabilityRequiredSeconds: parseFloat(process.env.STABILITY_REQUIRED_SECONDS || '40'),
  // 允许的非固定连续秒数，超过则重置收集
  nonFixedToleranceSeconds: parseFloat(process.env.NON_FIXED_TOLERANCE_SECONDS || '5'),
  // 为避免时间戳异常导致跳变，限制单次样本计入的最大间隔（秒）
  maxSampleIntervalSeconds: parseFloat(process.env.MAX_SAMPLE_INTERVAL_SECONDS || '2')
};

module.exports = config;

