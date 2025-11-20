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
      ? '/root/ppp_station_monitor/rtk_config/bbb.conf'
      : path.join(__dirname, 'bbb.conf')
  ),
  
  // 生成的配置文件存储目录
  generatedDir: process.env.GENERATED_DIR || (
    isLinux
      ? '/root/ppp_station_monitor/rtk_config/generated'
      : path.join(__dirname, 'generated')
  ),
  
  // 静态文件目录
  publicDir: process.env.PUBLIC_DIR || path.join(__dirname, 'public'),
  
  // RTKRCV 可执行文件路径
  rtkcrvPath: process.env.RTKRCV_PATH || (
    isLinux
      ? '/root/ppp_station_monitor/rtk_config/generated/rtkrcv'  // Linux 默认路径
      : 'rtkrcv.exe'  // Windows 从 PATH 或当前目录查找
  ),
  
  // RTKRCV 工作目录（启动时的当前目录）
  rtkcrvWorkDir: process.env.RTKRCV_WORKDIR || (
    isLinux
      ? '/root/ppp_station_monitor/rtk_config/generated'
      : path.join(__dirname, 'generated')
  ),
  
  // CORS 配置
  corsOrigin: process.env.CORS_ORIGIN || '*',
  
  // 日志级别 (debug, info, warn, error)
  logLevel: process.env.LOG_LEVEL || 'info',

  // 稳定性判定参数
  // 连续固定解累积秒数阈值（允许短暂掉固定不清零）
  stabilityRequiredSeconds: parseFloat(process.env.STABILITY_REQUIRED_SECONDS || '40'),
  // 允许的非固定连续秒数，超过则重置收集
  nonFixedToleranceSeconds: parseFloat(process.env.NON_FIXED_TOLERANCE_SECONDS || '5'),
  // 为避免时间戳异常导致跳变，限制单次样本计入的最大间隔（秒）
  maxSampleIntervalSeconds: parseFloat(process.env.MAX_SAMPLE_INTERVAL_SECONDS || '2'),

  // 性能相关
  // 最小SSE推送间隔（同一站点），毫秒；用于限频前端刷新，降低CPU/网络
  sseMinIntervalMs: parseInt(process.env.SSE_MIN_INTERVAL_MS || '500', 10),
  // 是否在日志中写入每次TCP收到的“原始数据”块（体量大，建议关闭以省IO）
  enableRawDataLog: (process.env.ENABLE_RAW_DATA_LOG || 'false').toLowerCase() === 'true',
  // 每个站点最多保留的采样个数（用于内存上限控制）
  maxSamplesPerStation: parseInt(process.env.MAX_SAMPLES_PER_STATION || '120', 10),
  // 站点达到稳定后是否保留采样数组（true保留；false清空释放内存）
  keepSamplesAfterStable: (process.env.KEEP_SAMPLES_AFTER_STABLE || 'false').toLowerCase() === 'true',
  // 子进程优先级：low|normal|high（仅尽力设置，不同平台效果不同）
  childProcessPriority: process.env.CHILD_PROCESS_PRIORITY || 'low',
  
  // MySQL 数据库配置（仅用于写入平均后的稳定结果）
  mysql: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || 'root',
    database: process.env.MYSQL_DATABASE || 'mydb',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10)
  }
};

module.exports = config;

