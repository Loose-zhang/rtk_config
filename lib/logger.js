// 日志模块
const config = require('../config');

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level, message) {
  const timestamp = new Date().toISOString();
  // 注意：debug 的级别值为 0，不能用 || 兜底（会被错误提升为 info）
  const currentLevel = LOG_LEVELS[config.logLevel] ?? 1;
  const messageLevel = LOG_LEVELS[level] ?? 1;
  if (messageLevel >= currentLevel) {
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
  }
}

module.exports = { log };
