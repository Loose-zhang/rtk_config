// 环境配置文件
const path = require('path');

// 判断运行环境
const isLinux = process.platform === 'linux';
const isWindows = process.platform === 'win32';

// 配置项
// 注意：所有路径均可通过环境变量覆盖（见 .env.example 与 README）。
// Linux 下的默认路径保留为当前生产部署路径，请勿随意修改默认值。
const config = {
  // 项目根目录（用于解析相对路径的 txtPath 等）
  projectRoot: __dirname,

  // 服务器端口
  port: process.env.PORT || 3000,

  // TCP 数据接收端口（rtkrcv outstr 输出目标）
  tcpPort: parseInt(process.env.TCP_PORT || '60000', 10),

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
  stabilityRequiredSeconds: parseFloat(process.env.STABILITY_REQUIRED_SECONDS || '10'),
  // 稳定性判定方式：'seconds'（按累计秒数）|'samples'（按样本）|'both'（两者都满足）
  stabilityCriteria: (process.env.STABILITY_CRITERIA || 'both').toLowerCase(),
  // 连续固定解样本个数阈值
  stabilityRequiredSamples: parseInt(process.env.STABILITY_REQUIRED_SAMPLES || '40', 10),
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

  // 单个 rtkrcv 日志文件大小上限（MB），进程启动时超限则轮转为 .log.1
  maxLogSizeMB: parseInt(process.env.MAX_LOG_SIZE_MB || '20', 10),

  // 停止进程时 SIGTERM 宽限时间（毫秒），超时未退出则 SIGKILL 强杀
  killGraceMs: parseInt(process.env.KILL_GRACE_MS || '10000', 10),

  // 缓存清扫器：清扫间隔与站点最大空闲时间（毫秒），防止长期运行内存增长
  cacheSweepIntervalMs: parseInt(process.env.CACHE_SWEEP_INTERVAL_MS || String(10 * 60 * 1000), 10),
  cacheMaxIdleMs: parseInt(process.env.CACHE_MAX_IDLE_MS || String(60 * 60 * 1000), 10),

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

