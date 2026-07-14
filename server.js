// RTKRCV 配置生成与基站解算监控服务 - 入口
//
// 模块结构（见 lib/）：
//   logger      日志
//   state       共享运行时状态（进程表、缓存、调度器状态）
//   geodesy     GPS时间/坐标转换（纯函数）
//   stats       样本均值/标准差/异常值剔除（纯函数）
//   parser      RTKRCV 输出解析
//   store       文件存取（结果JSON原子写入、模板、站点TXT）
//   db          MySQL（可选）
//   sse         SSE 广播
//   rtkrcv      RTKRCV 子进程管理（含日志轮转）
//   stability   稳定性判定与结果保存
//   scheduler   批量调度与多轮管理
//   tcp-server  TCP 数据接收（60000端口）
//   routes      HTTP API 路由
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const config = require('./config');
const { log } = require('./lib/logger');
const state = require('./lib/state');
const {
  ensureDirectories,
  readStableResults,
  writeStableResults,
  mergeStableResults
} = require('./lib/store');
const db = require('./lib/db');
const scheduler = require('./lib/scheduler');
const { startTcpServer } = require('./lib/tcp-server');
const { registerRoutes } = require('./lib/routes');

const app = express();

// Middleware
app.use(cors({ origin: config.corsOrigin }));
app.use(bodyParser.json());
app.use(express.static(config.publicDir));

// 注册所有 API 路由
registerRoutes(app);

// 将调度器挂接到进程退出事件（B3修复）
scheduler.init();

// 启动时初始化 MySQL（异步）
setImmediate(() => {
  (async () => {
    try {
      await db.dbInitMySql();
      if (db.dbIsReady()) {
        const jsonResults = readStableResults();
        const syncResult = await db.dbInsertStableResults(jsonResults);
        if (syncResult.attempted > 0) {
          log('info', `Stable result startup sync: ${syncResult.saved}/${syncResult.attempted} saved to database`);
        }
        if (syncResult.failed > 0) {
          log('warn', `${syncResult.failed} stable result(s) remain pending in JSON`);
        }
        // 同时把数据库独有的旧记录补回 JSON，使兜底文件保持完整。
        const databaseResults = await db.dbGetStableResults();
        const mergedResults = mergeStableResults(databaseResults, jsonResults);
        if (mergedResults.length !== jsonResults.length) {
          writeStableResults(mergedResults);
          log('info', `Stable result JSON backup updated: ${mergedResults.length} total record(s)`);
        }
      }
    } catch (e) {
      log('error', `dbInitMySql init error: ${e.message}`);
    }
  })();
});

// 初始化并启动服务器
function startServer() {
  try {
    // 确保必要的目录存在
    ensureDirectories();

    // 启动时尝试恢复多轮调度状态（若存在）
    scheduler.resumeRoundsIfNeeded();

    // 启动 TCP 服务器监听 RTKRCV 输出
    startTcpServer();

    // 启动缓存清扫器（A6：防止长跑内存增长）
    state.startCacheSweeper({
      intervalMs: config.cacheSweepIntervalMs,
      maxIdleMs: config.cacheMaxIdleMs,
      log
    });

    // 检查模板文件
    if (!fs.existsSync(config.templatePath)) {
      log('error', `Template file not found: ${config.templatePath}`);
      log('warn', 'Please ensure bbb.conf is in the correct location');
    } else {
      log('info', `Template file found: ${config.templatePath}`);
    }

    app.listen(config.port, '0.0.0.0', () => {
      log('info', `🚀 Server is running on port ${config.port}`);
      log('info', `📝 Platform: ${process.platform}`);
      log('info', `📂 Template: ${config.templatePath}`);
      log('info', `📁 Generated dir: ${config.generatedDir}`);
      log('info', `🔧 RTKRCV path: ${config.rtkcrvPath}`);
      log('info', `📂 RTKRCV work dir: ${config.rtkcrvWorkDir}`);
      log('info', `✅ RTKRCV exists: ${fs.existsSync(config.rtkcrvPath) ? 'Yes' : 'No (will try system PATH)'}`);
      log('info', `🌐 Access at: http://localhost:${config.port}`);
    });
  } catch (error) {
    log('error', `Failed to start server: ${error.message}`);
    process.exit(1);
  }
}

// 优雅关闭
function shutdown(signal) {
  log('info', `${signal} received, shutting down gracefully`);

  // 关闭 TCP 服务器
  if (state.tcp.server) {
    state.tcp.server.close(() => {
      log('info', 'TCP server closed');
    });
  }

  // 关闭所有 TCP 客户端
  state.tcpClients.forEach((client) => client.end());

  // 关闭所有 SSE 客户端
  state.sseClients.forEach((client) => client.end());

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startServer();
