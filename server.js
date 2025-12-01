const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const config = require('./config');
let mysql = null;
let dbPool = null;
try {
  // 可选依赖：MySQL（建议安装 mysql2）
  mysql = require('mysql2/promise');
} catch (e) {
  // 未安装 mysql2 时，仅记录日志
}

const app = express();

// 进程管理对象 - 存储运行中的 RTKRCV 进程
// 格式: { 'configFileName': { process: childProcess, pid: number, startTime: Date, configFile: string, logStream: WriteStream } }
const runningProcesses = new Map();

// TCP 服务器和连接管理
let tcpServer = null;
const tcpClients = new Map();

// SSE 客户端管理 - 用于推送实时数据到网页
const sseClients = new Map();
// SSE 限频：记录各站点上次推送时间（用于降压前端刷新与网络IO）
const sseLastSent = new Map();

// 子进程优先级设置（尽力而为，平台相关）
function applyChildPriority(childProcess) {
  try {
    const level = String(config.childProcessPriority || '').toLowerCase();
    if (!childProcess || !childProcess.pid) return;
    if (typeof process.setPriority !== 'function') return;
    if (level === 'low') {
      // nice 值越大优先级越低；在Windows上，由Node映射到 BELOW_NORMAL
      process.setPriority(childProcess.pid, 10);
    } else if (level === 'high') {
      process.setPriority(childProcess.pid, -5);
    } // normal: 不处理
  } catch (e) {
    log('warn', `applyChildPriority failed: ${e.message}`);
  }
}

// 最新的 RTKRCV 数据缓存
const latestData = new Map();

// ECEF 行缓存 - 等待对应的 LLH 行（因为数据可能分包到达）
const ecefCache = new Map();

// 站点稳定性跟踪
// 格式: { stationId: { status: 'collecting'|'stable', startTime: Date, samples: [], average: {} } }
const stationStability = new Map();

// 批量调度器（限制并发）
const batchScheduler = {
  active: false,
  concurrency: 5,
  pending: [],
  // 运行中的站点：Map<stationId, { startMs:number, timeoutTimer:NodeJS.Timeout }>
  running: new Map(),
  options: null, // { inpstr1Base, inpstr2, inpstr3 }
  // 统计
  successCount: 0,
  failCount: 0,
  completedCount: 0,
  failures: [], // 记录失败的站点编号（按完成顺序附加）
  successes: [], // 记录本轮成功的站点编号
  originalList: [], // 记录本轮输入的完整列表（含 stationId 与 outHeight）
  // 冷却控制：完成每 15 个之后休眠 5 分钟
  cooldownUntil: 0  // timestamp ms，> now 表示冷却中
};

// 轮次管理（多轮计算与持久化恢复）
const roundManager = {
  enabled: false,
  totalRounds: 0,
  currentRound: 0,
  intervalMs: 0,
  nextRoundTimer: null,
  nextRoundAt: 0, // timestamp ms
  // 保存第一轮的原始完整列表（包含 outHeight），后续轮继续使用同一列表（失败站点不会被剔除）
  seedOriginalList: [], // [{ stationId, outHeight }]
  // 上一轮成功的站点ID数组
  lastRoundSuccesses: [],
  // 运行参数（从第一轮继承）
  options: null, // { inpstr1Base, inpstr2, inpstr3, concurrency }
  // 当前轮正在运行的列表（用于中断恢复）
  currentList: []
};

function roundStateFilePath() {
  return path.join(config.generatedDir, 'round_state.json');
}

function writeRoundState() {
  try {
    ensureDirectories();
    const file = roundStateFilePath();
    const state = {
      enabled: !!roundManager.enabled,
      totalRounds: roundManager.totalRounds,
      currentRound: roundManager.currentRound,
      intervalMs: roundManager.intervalMs,
      nextRoundAt: roundManager.nextRoundAt,
      options: roundManager.options,
      seedOriginalList: roundManager.seedOriginalList,
      lastRoundSuccesses: roundManager.lastRoundSuccesses,
      currentList: roundManager.currentList
    };
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    log('warn', `Write round state failed: ${e.message}`);
  }
}

function readRoundState() {
  try {
    const file = roundStateFilePath();
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    log('warn', `Read round state failed: ${e.message}`);
    return null;
  }
}

function clearRoundTimer() {
  try {
    if (roundManager.nextRoundTimer) {
      clearTimeout(roundManager.nextRoundTimer);
    }
  } catch (_) {}
  roundManager.nextRoundTimer = null;
}

function disableRounds() {
  roundManager.enabled = false;
  clearRoundTimer();
  roundManager.nextRoundAt = 0;
  writeRoundState();
  log('info', 'Round manager disabled.');
}

function listFromSuccesses(successIds, originalList) {
  const originalMap = new Map(originalList.map(x => [String(x.stationId), x]));
  return (successIds || []).map(id => originalMap.get(String(id))).filter(Boolean);
}

function startBatchFromList(list, options, concurrency) {
  // 初始化调度器，尽量与 /api/batch/run-txt 主路径保持一致
  batchScheduler.active = true;
  batchScheduler.concurrency = concurrency > 0 ? concurrency : 5;
  batchScheduler.pending = list.slice(); // 按顺序排队
  batchScheduler.running = new Map();
  batchScheduler.successCount = 0;
  batchScheduler.failCount = 0;
  batchScheduler.completedCount = 0;
  batchScheduler.cooldownUntil = 0;
  batchScheduler.failures = [];
  batchScheduler.successes = [];
  batchScheduler.originalList = list.slice();
  batchScheduler.options = {
    inpstr1Base: ensureTrailingSlash(options.inpstr1Base),
    inpstr2: options.inpstr2,
    inpstr3: options.inpstr3
  };
  // 记录 last_batch 元信息，便于观察与恢复
  try {
    ensureDirectories();
    const lastBatchMetaFile = path.join(config.generatedDir, 'last_batch.json');
    const meta = {
      startedAt: new Date().toISOString(),
      options: { ...batchScheduler.options },
      concurrency: batchScheduler.concurrency,
      list: list.map(it => ({ stationId: it.stationId, outHeight: it.outHeight }))
    };
    fs.writeFileSync(lastBatchMetaFile, JSON.stringify(meta, null, 2), 'utf-8');
  } catch (e) {
    log('warn', `Failed to write last batch meta (round): ${e.message}`);
  }
  // 保存当前轮列表到 roundState，便于中断恢复
  roundManager.currentList = list.map(it => ({ stationId: it.stationId, outHeight: it.outHeight }));
  writeRoundState();
  // 广播轮次开始
  try {
    const round = roundManager.enabled ? (roundManager.currentRound || 1) : 1;
    const totalRounds = roundManager.enabled ? (roundManager.totalRounds || 1) : 1;
    broadcastToSSE({
      type: 'round_started',
      data: {
        round,
        totalRounds,
        count: list.length,
        startedAt: new Date().toISOString()
      }
    });
  } catch (e) {
    log('warn', `Broadcast round_started failed: ${e.message}`);
  }
  // 填充并启动
  batchSchedulerFillSlots(null);
}

function scheduleNextRoundIfNeeded() {
  if (!roundManager.enabled) return;
  if (roundManager.currentRound >= roundManager.totalRounds) {
    disableRounds();
    return;
  }
  // 计算下一轮列表：始终使用最初的完整列表（失败站点不会被剔除）
  const nextList = Array.isArray(roundManager.seedOriginalList)
    ? roundManager.seedOriginalList.map(it => ({ stationId: it.stationId, outHeight: it.outHeight }))
    : [];
  if (!nextList.length) {
    log('warn', 'Next round has no stations (empty seed list). Rounds will be disabled.');
    disableRounds();
    return;
  }
  const delay = roundManager.intervalMs > 0 ? roundManager.intervalMs : (20 * 60 * 1000);
  roundManager.nextRoundAt = Date.now() + delay;
  writeRoundState();
  clearRoundTimer();
  roundManager.nextRoundTimer = setTimeout(() => {
    try {
      roundManager.currentRound += 1;
      const { options } = roundManager;
      const conc = (options && options.concurrency) ? options.concurrency : 5;
      log('info', `Starting round ${roundManager.currentRound}/${roundManager.totalRounds} with ${nextList.length} stations after wait.`);
      startBatchFromList(nextList, options, conc);
      writeRoundState();
    } catch (e) {
      log('error', `Failed to start next round: ${e.message}`);
    }
  }, delay);
  log('info', `Scheduled next round ${roundManager.currentRound + 1} in ${Math.round(delay/60000)} minutes.`);
}

function onBatchCompleted() {
  try {
    // 广播当前轮完成，通知前端清理本轮站点
    try {
      const stationIds = (Array.isArray(roundManager.currentList) && roundManager.currentList.length > 0
        ? roundManager.currentList
        : (Array.isArray(batchScheduler.originalList) ? batchScheduler.originalList : []))
        .map(x => (typeof x === 'string' ? x : x && x.stationId))
        .filter(Boolean);
      const successIds = Array.isArray(batchScheduler.successes) ? batchScheduler.successes.slice() : [];
      const failIds = Array.isArray(batchScheduler.failures) ? batchScheduler.failures.slice() : [];
      const round = roundManager.enabled ? (roundManager.currentRound || 1) : 1;
      const totalRounds = roundManager.enabled ? (roundManager.totalRounds || 1) : 1;

      // 服务器端也清理缓存，避免残留数据导致前端再次显示
      try {
        stationIds.forEach((sid) => {
          try { latestData.delete(sid); } catch (_) {}
          try { stationStability.delete(sid); } catch (_) {}
          try { ecefCache.delete(sid); } catch (_) {}
          try { sseLastSent.delete(sid); } catch (_) {}
        });
      } catch (_) {}

      broadcastToSSE({
        type: 'round_completed',
        data: {
          round,
          totalRounds,
          stationIds,
          successIds,
          failIds,
          stableResultsCleared: true,
          finishedAt: new Date().toISOString()
        }
      });
    } catch (e) {
      log('warn', `Broadcast round_completed failed: ${e.message}`);
    }

    // 清空稳定结果历史文件，为新一轮释放空间（数据库已保存）
    try {
      writeStableResults([]);
      log('info', 'Cleared stable_results.json after round completion');
    } catch (e) {
      log('warn', `Clear stable_results.json failed: ${e.message}`);
    }

    // 更新轮次管理状态
    if (roundManager.enabled) {
      roundManager.lastRoundSuccesses = Array.isArray(batchScheduler.successes) ? batchScheduler.successes.slice() : [];
      writeRoundState();
      scheduleNextRoundIfNeeded();
    }
  } catch (e) {
    log('warn', `onBatchCompleted error: ${e.message}`);
  }
}

function resumeRoundsIfNeeded() {
  try {
    const state = readRoundState();
    if (!state || !state.enabled) return;
    // 恢复内存状态
    roundManager.enabled = !!state.enabled;
    roundManager.totalRounds = state.totalRounds || 0;
    roundManager.currentRound = state.currentRound || 0;
    roundManager.intervalMs = state.intervalMs || 20 * 60 * 1000;
    roundManager.nextRoundAt = state.nextRoundAt || 0;
    roundManager.options = state.options || null;
    roundManager.seedOriginalList = Array.isArray(state.seedOriginalList) ? state.seedOriginalList : [];
    roundManager.lastRoundSuccesses = Array.isArray(state.lastRoundSuccesses) ? state.lastRoundSuccesses : [];
    roundManager.currentList = Array.isArray(state.currentList) ? state.currentList : [];

    if (!roundManager.enabled) return;

    // 若存在当前轮列表且未运行，则恢复当前轮
    if (roundManager.currentList.length > 0 && !batchScheduler.active) {
      const conc = (roundManager.options && roundManager.options.concurrency) ? roundManager.options.concurrency : 5;
      log('info', `Resuming running round ${roundManager.currentRound}/${roundManager.totalRounds} with ${roundManager.currentList.length} stations...`);
      startBatchFromList(roundManager.currentList, roundManager.options, conc);
      return;
    }

    // 若等待下一轮
    if (roundManager.currentRound < roundManager.totalRounds) {
      const now = Date.now();
      if (roundManager.nextRoundAt && roundManager.nextRoundAt > now) {
        const delay = roundManager.nextRoundAt - now;
        log('info', `Resuming scheduled next round in ${Math.round(delay/60000)} minutes...`);
        clearRoundTimer();
        roundManager.nextRoundTimer = setTimeout(() => {
          try {
            roundManager.currentRound += 1;
            const nextList = Array.isArray(roundManager.seedOriginalList)
              ? roundManager.seedOriginalList.map(it => ({ stationId: it.stationId, outHeight: it.outHeight }))
              : [];
            const conc = (roundManager.options && roundManager.options.concurrency) ? roundManager.options.concurrency : 5;
            log('info', `Starting resumed round ${roundManager.currentRound}/${roundManager.totalRounds} with ${nextList.length} stations.`);
            startBatchFromList(nextList, roundManager.options, conc);
            writeRoundState();
          } catch (e) {
            log('error', `Failed to start resumed next round: ${e.message}`);
          }
        }, delay);
      } else {
        // 已到时间，立即开始下一轮
        roundManager.currentRound += 1;
          const nextList = Array.isArray(roundManager.seedOriginalList)
            ? roundManager.seedOriginalList.map(it => ({ stationId: it.stationId, outHeight: it.outHeight }))
            : [];
        const conc = (roundManager.options && roundManager.options.concurrency) ? roundManager.options.concurrency : 5;
        log('info', `Starting overdue next round ${roundManager.currentRound}/${roundManager.totalRounds} with ${nextList.length} stations.`);
        startBatchFromList(nextList, roundManager.options, conc);
        writeRoundState();
      }
    } else {
      // 已完成所有轮次
      disableRounds();
    }
  } catch (e) {
    log('warn', `resumeRoundsIfNeeded failed: ${e.message}`);
  }
}

function isInCooldown() {
  return batchScheduler.cooldownUntil && Date.now() < batchScheduler.cooldownUntil;
}

function scheduleCooldownIfNeeded() {
  if (batchScheduler.completedCount > 0 && batchScheduler.completedCount % 15 === 0) {
    const pauseMs = 5 * 60 * 1000;
    batchScheduler.cooldownUntil = Date.now() + pauseMs;
    log('info', `Batch scheduler: completed ${batchScheduler.completedCount}, entering cooldown for 5 minutes`);
    setTimeout(() => {
      log('info', 'Batch scheduler: cooldown finished, resuming');
      // 结束冷却后尝试补位
      batchSchedulerFillSlots(null);
    }, pauseMs);
  }
}

function batchMarkComplete(stationId, success) {
  try {
    const meta = batchScheduler.running.get(stationId);
    if (meta && meta.timeoutTimer) {
      clearTimeout(meta.timeoutTimer);
    }
    batchScheduler.running.delete(stationId);
    if (success) {
      batchScheduler.successCount += 1;
      try {
        if (!batchScheduler.successes.includes(stationId)) {
          batchScheduler.successes.push(stationId);
        }
      } catch (e) {}
    } else {
      batchScheduler.failCount += 1;
      try {
        batchScheduler.failures.push(stationId);
        // 同步持久化失败站点列表，记录轮次与失败序号
        const existing = readFailedResults(); // [{ stationId, round, index, at }]
        const round = roundManager.enabled ? (roundManager.currentRound || 1) : 1;
        const roundFails = existing.filter(item => item && item.round === round);
        const nextIndex = roundFails.length + 1;
        existing.push({
          stationId,
          round,
          index: nextIndex,
          at: new Date().toISOString()
        });
        writeFailedResults(existing);
      } catch (e) {}
    }
    batchScheduler.completedCount += 1;
    scheduleCooldownIfNeeded();
  } catch (e) {
    log('warn', `batchMarkComplete error: ${e.message}`);
  }
}

function batchSchedulerFillSlots(startedNowCollector) {
  if (!batchScheduler.active) return;
  if (isInCooldown()) {
    // 冷却中不启动新任务
    return;
  }
  while (batchScheduler.running.size < batchScheduler.concurrency && batchScheduler.pending.length > 0) {
    const item = batchScheduler.pending.shift();
    const stationId = item.stationId;
    try {
      const inp1 = `${ensureTrailingSlash(batchScheduler.options.inpstr1Base)}${stationId}`;
      const { fileName } = generateConfigFile({
        inpstr1: inp1,
        inpstr2: batchScheduler.options.inpstr2,
        inpstr3: batchScheduler.options.inpstr3,
        outHeight: item.outHeight
      });
      const startInfo = startRtkrcvInternal(fileName);
      // 设置30分钟未固定超时逻辑
      const timeoutTimer = setTimeout(() => {
        try {
          // 若还在运行，则标记失败并杀进程
          if (batchScheduler.running.has(stationId)) {
            log('warn', `Batch scheduler: station ${stationId} timeout (30min) without fixed, marking as failed`);
            // 推送通知与清理
            const configFile = `${stationId}.conf`;
            const proc = runningProcesses.get(configFile);
            if (proc) {
              broadcastToSSE({
                type: 'rtkrcv_manual_stopped',
                data: {
                  stationId,
                  configFile,
                  reason: 'timeout',
                  message: `站点 ${stationId} 超过30分钟未固定，已标记失败并停止`
                }
              });
              try { latestData.delete(stationId); } catch (e) {}
              try { stationStability.delete(stationId); } catch (e) {}
              try { ecefCache.delete(stationId); } catch (e) {}
              try { sseLastSent.delete(stationId); } catch (e) {}
              proc.process.kill();
            }
            // 统计失败并尝试补位（exit 回调也会执行，再次补位不会重复，因为running已在 batchMarkComplete 中删除）
            batchMarkComplete(stationId, false);
            batchSchedulerFillSlots(null);
          }
        } catch (e) {
          log('error', `Timeout handling error for ${stationId}: ${e.message}`);
        }
      }, 30 * 60 * 1000);
      batchScheduler.running.set(stationId, { startMs: Date.now(), timeoutTimer });
      if (startedNowCollector) {
        startedNowCollector.push({
          stationId,
          configFile: fileName,
          pid: startInfo.pid,
          logFile: startInfo.logFileName,
          success: true
        });
      }
    } catch (e) {
      if (startedNowCollector) {
        startedNowCollector.push({
          stationId,
          error: e.message || String(e),
          success: false
        });
      }
      // 启动失败也算完成一个，进入失败统计
      batchMarkComplete(stationId, false);
    }
  }
  if (batchScheduler.pending.length === 0 && batchScheduler.running.size === 0) {
    batchScheduler.active = false;
    batchScheduler.options = null;
    // 批量全部完成时触发钩子（用于多轮调度）
    onBatchCompleted();
  }
}

function batchSchedulerOnProcessExit(stationId) {
  if (!batchScheduler.active) return;
  if (batchScheduler.running.has(stationId)) {
    // 未明确标记成功/失败时，按失败处理（通常 stable 时会先在 stop 回调中标记成功）
    batchMarkComplete(stationId, false);
    batchSchedulerFillSlots(null);
  }
}

// Middleware
app.use(cors({ origin: config.corsOrigin }));
app.use(bodyParser.json());
app.use(express.static(config.publicDir));

// 日志函数
function log(level, message) {
  const timestamp = new Date().toISOString();
  
  // 根据配置的日志级别过滤
  const logLevels = { debug: 0, info: 1, warn: 2, error: 3 };
  const currentLevel = logLevels[config.logLevel] || 1;
  const messageLevel = logLevels[level] || 1;
  
  if (messageLevel >= currentLevel) {
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
  }
}

// MySQL 初始化与访问封装
async function dbInitMySql() {
  try {
    if (!mysql || !config.mysql || !config.mysql.host) {
      log('warn', 'MySQL not configured. Database features are disabled. Configure config.mysql and install mysql2.');
      return;
    }
    const { host, user, password, database, port } = config.mysql;
    // 若目标数据库不存在，先以“无数据库”连接创建之
    try {
      const bootstrap = await mysql.createConnection({
        host,
        user,
        password,
        port: port || 3306
      });
      await bootstrap.execute(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4`);
      await bootstrap.end();
      log('info', `Ensured database exists: ${database}`);
    } catch (e) {
      log('warn', `Ensure database failed (may already exist or no privilege): ${e.message}`);
    }
    dbPool = await mysql.createPool({
      host,
      user,
      password,
      database,
      port: port || 3306,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: 'utf8mb4'
    });
    // 创建仅用于平均后稳定结果的表
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS stable_results (
        id VARCHAR(128) PRIMARY KEY,
        station_id VARCHAR(128) NOT NULL,
        timestamp VARCHAR(32) NOT NULL,
        ecef_x DOUBLE NOT NULL,
        ecef_y DOUBLE NOT NULL,
        ecef_z DOUBLE NOT NULL,
        lat DOUBLE NOT NULL,
        lon DOUBLE NOT NULL,
        height DOUBLE NOT NULL
      )
    `);
    // 创建索引（老版本 MySQL 不支持 IF NOT EXISTS，这里忽略重复索引错误）
    try {
      await dbPool.execute(`CREATE INDEX idx_results_station ON stable_results(station_id)`);
    } catch (e) {
      if (e && e.code === 'ER_DUP_KEYNAME') {
        // 索引已存在，忽略
      } else {
        log('warn', `Create index on stable_results failed: ${e.message}`);
      }
    }
    log('info', `MySQL initialized: ${user}@${host}/${database}`);
  } catch (e) {
    log('error', `dbInitMySql failed: ${e.message}`);
  }
}

function dbInsertStableResult(record) {
  try {
    if (!dbPool || !record || !record.id) return;
    const sql = `
      INSERT INTO stable_results (id, station_id, timestamp, ecef_x, ecef_y, ecef_z, lat, lon, height)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        station_id = VALUES(station_id),
        timestamp = VALUES(timestamp),
        ecef_x = VALUES(ecef_x),
        ecef_y = VALUES(ecef_y),
        ecef_z = VALUES(ecef_z),
        lat = VALUES(lat),
        lon = VALUES(lon),
        height = VALUES(height)
    `;
    const params = [
      record.id,
      record.stationId,
      record.timestamp,
      parseFloat(record.ecef_x),
      parseFloat(record.ecef_y),
      parseFloat(record.ecef_z),
      parseFloat(record.lat),
      parseFloat(record.lon),
      parseFloat(record.height)
    ];
    dbPool.execute(sql, params).catch(err => log('warn', `dbInsertStableResult error: ${err.message}`));
  } catch (e) {
    log('warn', `dbInsertStableResult failed: ${e.message}`);
  }
}

// 启动时初始化 MySQL（异步）
setImmediate(() => {
  try {
    const p = dbInitMySql();
    if (p && typeof p.then === 'function') {
      p.then(() => {}).catch(e => log('error', `dbInitMySql init error: ${e.message}`));
    }
  } catch (e) {
    log('error', `dbInitMySql schedule error: ${e.message}`);
  }
});

// 确保必要的目录存在
function ensureDirectories() {
  if (!fs.existsSync(config.generatedDir)) {
    fs.mkdirSync(config.generatedDir, { recursive: true });
    log('info', `Created directory: ${config.generatedDir}`);
  }
}

// 稳定结果数据文件路径
const stableResultsFile = path.join(config.generatedDir, 'stable_results.json');
// 失败结果数据文件路径（记录每次失败的站点、轮次和失败序号）
const failedResultsFile = path.join(config.generatedDir, 'failed_results.json');

// 读取稳定结果
function readStableResults() {
  try {
    if (fs.existsSync(stableResultsFile)) {
      const data = fs.readFileSync(stableResultsFile, 'utf-8');
      return JSON.parse(data);
    }
    return [];
  } catch (error) {
    log('error', `Error reading stable results: ${error.message}`);
    return [];
  }
}

// 写入稳定结果
function writeStableResults(results) {
  try {
    ensureDirectories();
    fs.writeFileSync(stableResultsFile, JSON.stringify(results, null, 2), 'utf-8');
    log('info', `Saved ${results.length} stable results`);
    return true;
  } catch (error) {
    log('error', `Error writing stable results: ${error.message}`);
    return false;
  }
}

// 读取失败结果（数组：{ stationId, round, index, at }）
function readFailedResults() {
  try {
    if (fs.existsSync(failedResultsFile)) {
      const data = fs.readFileSync(failedResultsFile, 'utf-8');
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) return [];
      // 兼容旧格式：纯 stationId 列表
      return parsed.map((item, idx) => {
        if (item && typeof item === 'object') {
          return item;
        }
        return {
          stationId: String(item),
          round: 0,
          index: idx + 1
        };
      });
    }
    return [];
  } catch (error) {
    log('error', `Error reading failed results: ${error.message}`);
    return [];
  }
}

// 写入失败结果（数组：{ stationId, round, index, at }）
function writeFailedResults(list) {
  try {
    ensureDirectories();
    const arr = Array.isArray(list) ? list : [];
    fs.writeFileSync(failedResultsFile, JSON.stringify(arr, null, 2), 'utf-8');
    log('info', `Saved ${arr.length} failed results`);
    return true;
  } catch (error) {
    log('error', `Error writing failed results: ${error.message}`);
    return false;
  }
}

// 读取模板配置文件
function readTemplate() {
  try {
    if (!fs.existsSync(config.templatePath)) {
      throw new Error(`Template file not found: ${config.templatePath}`);
    }
    return fs.readFileSync(config.templatePath, 'utf-8');
  } catch (error) {
    log('error', `Error reading template: ${error.message}`);
    throw error;
  }
}

// 生成配置文件（可复用）
function generateConfigFile({ inpstr1, inpstr2, inpstr3, outHeight }) {
  // 读取模板
  let configContent = readTemplate();
  
  // 替换配置项
  configContent = configContent.replace(/^inpstr1-path\s*=.*$/m, `inpstr1-path       =${inpstr1}`);
  configContent = configContent.replace(/^inpstr2-path\s*=.*$/m, `inpstr2-path       =${inpstr2}`);
  configContent = configContent.replace(/^inpstr3-path\s*=.*$/m, `inpstr3-path       =${inpstr3}`);
  configContent = configContent.replace(/^out-height\s*=.*$/m, `out-height         =${outHeight}   # (0:ellipsoidal,1:geodetic)`);
  
  // 同时更新输出文件路径，使用固定 TCP 输出至本服务
  const mountPoint = extractMountPoint(inpstr1);
  configContent = configContent.replace(/^outstr1-path\s*=.*$/m, `outstr1-path       =127.0.0.1:60000`);
  configContent = configContent.replace(/^outstr2-path\s*=.*$/m, `outstr2-path       =127.0.0.1:60000`);
  
  // 生成文件名
  const fileName = `${mountPoint}.conf`;
  const filePath = path.join(config.generatedDir, fileName);
  
  // 确保 generated 目录存在
  ensureDirectories();
  
  // 写入文件
  fs.writeFileSync(filePath, configContent, 'utf-8');
  log('info', `Generated config file: ${fileName}`);
  
  return { fileName, filePath, content: configContent };
}

// 保证 base 以单个斜杠结尾
function ensureTrailingSlash(base) {
  if (!base.endsWith('/')) return `${base}/`;
  return base;
}

// 解析站点TXT：每行格式 "stationId outHeight"
function parseStationsTxt(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`TXT 文件不存在: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const items = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const stationId = parts[0];
    const outHeight = parseInt(parts[1], 10);
    if (!stationId) continue;
    if (Number.isNaN(outHeight)) continue;
    items.push({ stationId, outHeight });
  }
  return items;
}

// 启动 RTKRCV（内部复用版本）
function startRtkrcvInternal(configFile) {
  // 检查配置文件是否存在
  const configPath = path.join(config.generatedDir, configFile);
  if (!fs.existsSync(configPath)) {
    throw new Error('配置文件不存在');
  }
  // 检查是否已经在运行
  if (runningProcesses.has(configFile)) {
    throw new Error('该配置的 RTKRCV 已在运行中');
  }
  const rtkcrvPath = config.rtkcrvPath;
  const rtkcrvExePath = fs.existsSync(rtkcrvPath) ? rtkcrvPath : (
    process.platform === 'win32' ? 'rtkrcv.exe' : 'rtkrcv'
  );
  log('info', `Using RTKRCV executable: ${rtkcrvExePath}`);
  log('info', `Working directory: ${config.rtkcrvWorkDir}`);
  const childProcess = spawn(rtkcrvExePath, ['-nc', '-o', configFile], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: config.rtkcrvWorkDir,
    windowsHide: true
  });
  // 降低子进程优先级，减少CPU争用
  applyChildPriority(childProcess);
  const pid = childProcess.pid;
  const startTime = new Date();
  const logFileName = configFile.replace('.conf', '.log');
  const logPath = path.join(config.generatedDir, logFileName);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n========== RTKRCV 启动 ==========\n`);
  logStream.write(`时间: ${startTime.toISOString()}\n`);
  logStream.write(`配置文件: ${configFile}\n`);
  logStream.write(`进程 PID: ${pid}\n`);
  logStream.write(`================================\n\n`);
  childProcess.stdout.on('data', (data) => {
    logStream.write(data);
  });
  childProcess.stderr.on('data', (data) => {
    logStream.write(`[ERROR] ${data}`);
  });
  childProcess.on('exit', (code, signal) => {
    const exitTime = new Date();
    logStream.write(`\n========== RTKRCV 退出 ==========\n`);
    logStream.write(`时间: ${exitTime.toISOString()}\n`);
    logStream.write(`退出码: ${code}\n`);
    logStream.write(`信号: ${signal}\n`);
    logStream.write(`================================\n\n`);
    logStream.end();
    runningProcesses.delete(configFile);
    log('info', `RTKRCV process exited: ${configFile} (PID: ${pid}, Code: ${code})`);
  });
  childProcess.on('error', (error) => {
    logStream.write(`\n[FATAL ERROR] ${error.message}\n`);
    logStream.end();
    runningProcesses.delete(configFile);
    log('error', `RTKRCV process error: ${configFile} - ${error.message}`);
  });
  runningProcesses.set(configFile, {
    process: childProcess,
    pid: pid,
    startTime: startTime,
    configFile: configFile,
    logFile: logFileName,
    logStream: logStream
  });
  log('info', `Started RTKRCV: ${configFile} (PID: ${pid})`);
  return { pid, logFileName };
}

// 从路径中提取挂载点
function extractMountPoint(path) {
  // 格式: user:pass@host:port/mountpoint
  const match = path.match(/\/([^\/]+)$/);
  return match ? match[1] : 'default';
}

// GPS 时间转换为 UTC 时间
function gpsToUtc(week, secondsOfWeek) {
  // GPS 时间起始点: 1980年1月6日 00:00:00 UTC
  const gpsEpoch = new Date(Date.UTC(1980, 0, 6, 0, 0, 0));
  
  // 计算总秒数
  const totalSeconds = week * 604800 + secondsOfWeek;
  
  // GPS 时间与 UTC 的偏差（闰秒）- 当前为 18 秒
  const leapSeconds = 18;
  
  // 计算 UTC 时间
  const utcTime = new Date(gpsEpoch.getTime() + (totalSeconds - leapSeconds) * 1000);
  
  return utcTime;
}

// 将 "YYYY/MM/DD" 和 "HH:MM:SS.sss"（GPST）转换为 UTC Date
function gpstDateTimeToUtc(dateStr, timeStr) {
  try {
    const [y, m, d] = dateStr.split('/').map(n => parseInt(n, 10));
    const [hh, mm, ssms] = timeStr.split(':');
    const h = parseInt(hh, 10);
    const mi = parseInt(mm, 10);
    const s = parseFloat(ssms);
    const sec = Math.floor(s);
    const ms = Math.round((s - sec) * 1000);
    const gpst = new Date(Date.UTC(y, (m || 1) - 1, d || 1, h || 0, mi || 0, sec || 0, ms || 0));
    const leapSeconds = 18;
    return new Date(gpst.getTime() - leapSeconds * 1000);
  } catch (e) {
    return new Date();
  }
}

// 从 LLH 计算 ECEF（WGS84）
function llhToEcef(latDeg, lonDeg, heightMeters) {
  const a = 6378137.0; // 半长轴
  const f = 1 / 298.257223563; // 扁率
  const e2 = f * (2 - f); // 第一偏心率平方
  
  const lat = latDeg * Math.PI / 180.0;
  const lon = lonDeg * Math.PI / 180.0;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  
  const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  
  const x = (N + heightMeters) * cosLat * cosLon;
  const y = (N + heightMeters) * cosLat * sinLon;
  const z = (N * (1 - e2) + heightMeters) * sinLat;
  
  return { x, y, z };
}

// 解析 RTKRCV 输出数据
function parseRtkcrvOutput(data) {
  const lines = data.trim().split('\n').filter(Boolean);
  
  try {
    // 支持仅 LLH 单行：从 LLH 反算 ECEF 并完成解算
    if (lines.length === 1) {
      const p = lines[0].trim().split(/\s+/);
      log('debug', `LLH-only parts count: ${p.length}, data: ${lines[0].substring(0, 150)}`);
      
      if (p.length < 6) {
        log('warn', `Parse failed: LLH-only line has only ${p.length} fields (need >= 6)`);
        return null;
      }
      
      let lat, lon, height, q, ns, stationId, utcTime;
      
      // 两种格式：
      // A) gpsWeek gpsSeconds lat lon height q ns ... stationId
      // B) YYYY/MM/DD HH:MM:SS.sss lat lon height q ns ... stationId  （GPST）
      if (p[0].includes('/')) {
        // 格式B：日期+时间开头
        const dateStr = p[0];
        const timeStr = p[1];
        lat = parseFloat(p[2]);
        lon = parseFloat(p[3]);
        height = parseFloat(p[4]);
        q = parseInt(p[5]);
        ns = parseInt(p[6]);
        stationId = p[p.length - 1];
        if ([lat, lon, height].some(v => Number.isNaN(v))) {
          log('error', `Parse failed: invalid LLH-only (date-time) values`);
          return null;
        }
        utcTime = gpstDateTimeToUtc(dateStr, timeStr);
      } else {
        // 格式A：周+周内秒开头
        const gpsWeek = parseInt(p[0]);
        const gpsSecondsOfWeek = parseFloat(p[1]);
        lat = parseFloat(p[2]);
        lon = parseFloat(p[3]);
        height = parseFloat(p[4]);
        q = parseInt(p[5]);
        ns = parseInt(p[6]);
        stationId = p[p.length - 1];
        if ([gpsWeek, gpsSecondsOfWeek, lat, lon, height].some(v => Number.isNaN(v))) {
          log('error', `Parse failed: invalid LLH-only (week+sec) values`);
          return null;
        }
        utcTime = gpsToUtc(gpsWeek, gpsSecondsOfWeek);
      }
      
      const ecef = llhToEcef(lat, lon, height);
      const statusText = q === 1 ? '固定解' : q === 2 ? '浮点解' : q === 4 ? 'DGPS' : q === 5 ? '单点' : '未知';
      // 尝试从倒数第二个字段提取“模糊度”，例如样例中的 1.1
      let ambiguityVal = null;
      const maybeAmb = parseFloat(p[p.length - 2]);
      if (!Number.isNaN(maybeAmb)) {
        ambiguityVal = parseFloat(maybeAmb.toFixed(1));
      }
      
      return {
        stationId: stationId,
        timestamp: utcTime.toISOString(),
        dateTime: utcTime.toLocaleString('zh-CN', { 
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }),
        ecef: {
          x: ecef.x.toFixed(4),
          y: ecef.y.toFixed(4),
          z: ecef.z.toFixed(4),
          dateTime: `${utcTime.getUTCFullYear()}/${String(utcTime.getUTCMonth()+1).padStart(2,'0')}/${String(utcTime.getUTCDate()).padStart(2,'0')} ` +
                    `${String(utcTime.getUTCHours()).padStart(2,'0')}:${String(utcTime.getUTCMinutes()).padStart(2,'0')}:${String(utcTime.getUTCSeconds()).padStart(2,'0')}`
        },
        llh: {
          lat: lat.toFixed(9),
          lon: lon.toFixed(9),
          height: height.toFixed(4)
        },
        quality: {
          status: q,
          statusText: statusText,
          satellites: ns,
          ambiguity: ambiguityVal
        }
      };
    }
    
    // 解析 ECEF 行
    const ecefParts = lines[0].trim().split(/\s+/);
    log('debug', `ECEF parts count: ${ecefParts.length}, data: ${lines[0].substring(0, 150)}`);
    
    if (ecefParts.length < 10) {
      log('warn', `Parse failed: ECEF line has only ${ecefParts.length} fields (need >= 10)`);
      return null;
    }
    
    const ecefDate = ecefParts[0];
    const ecefTime = ecefParts[1];
    const x = parseFloat(ecefParts[2]);
    const y = parseFloat(ecefParts[3]);
    const z = parseFloat(ecefParts[4]);
    const q = parseInt(ecefParts[5]); // 解算状态: 1=固定解, 2=浮点解
    const ns = parseInt(ecefParts[6]); // 卫星数
    const stationId = ecefParts[ecefParts.length - 1]; // 站点编号
    // 从 ECEF 行提取模糊度（倒数第二个字段）
    const ambiguityRaw = ecefParts[ecefParts.length - 2];
    const ambiguityVal = parseFloat(ambiguityRaw);
    
    // 解析 LLH 行
    const llhParts = lines[1].trim().split(/\s+/);
    log('debug', `LLH parts count: ${llhParts.length}, data: ${lines[1].substring(0, 150)}`);
    
    if (llhParts.length < 10) {
      log('warn', `Parse failed: LLH line has only ${llhParts.length} fields (need >= 10)`);
      return null;
    }
    
    const gpsWeek = parseInt(llhParts[0]);
    const gpsSecondsOfWeek = parseFloat(llhParts[1]);
    const lat = parseFloat(llhParts[2]); // 纬度
    const lon = parseFloat(llhParts[3]); // 经度
    const height = parseFloat(llhParts[4]); // 高度
    
    // 验证解析的数据
    if (isNaN(x) || isNaN(y) || isNaN(z) || isNaN(lat) || isNaN(lon)) {
      log('error', `Parse failed: invalid coordinate values`);
      return null;
    }
    
    // 转换 GPS 时间为 UTC 时间
    const utcTime = gpsToUtc(gpsWeek, gpsSecondsOfWeek);
    
    // 解算状态文本
    const statusText = q === 1 ? '固定解' : q === 2 ? '浮点解' : q === 4 ? 'DGPS' : q === 5 ? '单点' : '未知';
    
    log('debug', `Parse success: Station ${stationId}, Status: ${statusText}, Sats: ${ns}`);
    
    return {
      stationId: stationId,
      timestamp: utcTime.toISOString(),
      dateTime: utcTime.toLocaleString('zh-CN', { 
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }),
      ecef: {
        x: x.toFixed(4),
        y: y.toFixed(4),
        z: z.toFixed(4),
        dateTime: `${ecefDate} ${ecefTime}`
      },
      llh: {
        lat: lat.toFixed(9),
        lon: lon.toFixed(9),
        height: height.toFixed(4),
        gpsWeek: gpsWeek,
        gpsSeconds: gpsSecondsOfWeek.toFixed(3)
      },
      quality: {
        status: q,
        statusText: statusText,
        satellites: ns,
        ambiguity: isNaN(ambiguityVal) ? null : parseFloat(ambiguityVal.toFixed(1))
      }
    };
  } catch (error) {
    log('error', `Error parsing RTKRCV output: ${error.message}, Stack: ${error.stack}`);
    log('debug', `Failed data: ${data}`);
    return null;
  }
}

// 启动 TCP 服务器监听 60000 端口
function startTcpServer() {
  if (tcpServer) {
    log('warn', 'TCP server already running');
    return;
  }
  
  tcpServer = net.createServer((socket) => {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    log('info', `TCP client connected: ${clientId}`);
    
    tcpClients.set(clientId, socket);
    
    let buffer = '';
    
    socket.on('data', (data) => {
      const rawData = data.toString();
      buffer += rawData;
      
      // 记录接收到的原始数据（用于调试）
      log('debug', `Received TCP data (${rawData.length} bytes): ${rawData.substring(0, 200)}...`);
      
      // 处理完整的数据包
      const lines = buffer.split('\n');
      
      // 保留最后可能不完整的数据
      buffer = lines.pop() || '';
      
      // 处理所有完整的行
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        if (!line) continue; // 跳过空行
        
        const parts = line.split(/\s+/);
        
        if (parts.length < 7) {
          log('warn', `Skipping invalid line (too few fields): ${line}`);
          continue;
        }
        
        // 提取站点 ID（最后一个字段）
        const stationId = parts[parts.length - 1];
        
        // 判断是否为日期时间开头的行（可能是 ECEF 也可能是 LLH）
        if (parts[0].includes('/')) {
          // 判断第三、四、五列是否像经纬高
          const v2 = parseFloat(parts[2]);
          const v3 = parseFloat(parts[3]);
          const v4 = parseFloat(parts[4]);
          const looksLikeLLH = ![v2, v3, v4].some(Number.isNaN) && Math.abs(v2) <= 90 && Math.abs(v3) <= 180 && Math.abs(v4) < 20000;
          
          if (looksLikeLLH) {
            // 直接按 LLH-only 解析
            const parsedData = parseRtkcrvOutput(line);
            if (parsedData) {
              writeDataLog(parsedData, line);
              const stabilityCheck = checkStationStability(parsedData.stationId, parsedData);
              parsedData.stability = {
                stable: stabilityCheck.stable,
                collecting: stabilityCheck.collecting || false,
                elapsed: stabilityCheck.elapsed || 0,
                sampleCount: stabilityCheck.sampleCount || 0
              };
              if (stabilityCheck.stable && stabilityCheck.average) {
                parsedData.average = stabilityCheck.average;
              }
              latestData.set(parsedData.stationId, parsedData);
              if (!stabilityCheck.stable || stabilityCheck.elapsed === undefined) {
                broadcastToSSE({ type: 'rtkrcv_data', data: parsedData });
              }
              log('info', `✅(LLH-only) Station ${parsedData.stationId}: ${parsedData.quality.statusText}, Sats: ${parsedData.quality.satellites}, Lat: ${parsedData.llh.lat}, Lon: ${parsedData.llh.lon}`);
            } else {
              log('error', `❌ Failed to parse LLH-only (date-time) for station ${stationId}`);
            }
          } else {
            // 视为 ECEF 行 - 缓存等待 LLH
            ecefCache.set(stationId, {
              line: line,
              timestamp: Date.now()
            });
            log('debug', `📐 Cached ECEF line for station ${stationId}: ${line.substring(0, 100)}`);
          }
        }
        // 判断是否是 LLH 行（纯数字开头：gpsWeek gpsSeconds ...）
        else if (!isNaN(parseInt(parts[0])) && !isNaN(parseFloat(parts[1]))) {
          // LLH 行 - 查找对应的 ECEF 行
          const cachedEcef = ecefCache.get(stationId);
          
          if (cachedEcef) {
            // 找到配对的 ECEF 行，组合解析
            const dataPacket = cachedEcef.line + '\n' + line;
            log('debug', `🔗 Pairing ECEF+LLH for station ${stationId}`);
            
            const parsedData = parseRtkcrvOutput(dataPacket);
            
            if (parsedData) {
              // 写入数据流日志
              writeDataLog(parsedData, dataPacket);
              
              // 检查站点稳定性
              const stabilityCheck = checkStationStability(parsedData.stationId, parsedData);
              
              // 添加稳定性信息到数据中
              parsedData.stability = {
                stable: stabilityCheck.stable,
                collecting: stabilityCheck.collecting || false,
                elapsed: stabilityCheck.elapsed || 0,
                sampleCount: stabilityCheck.sampleCount || 0,
                required: config.stabilityRequiredSeconds
              };
              
              // 如果已稳定，添加平均值
      if (stabilityCheck.stable && stabilityCheck.average) {
                parsedData.average = stabilityCheck.average;
              }
              
              // 缓存最新数据（包含稳定性信息）
              latestData.set(parsedData.stationId, parsedData);
              
              // 只有在未稳定或刚稳定时才推送实时数据
              if (!stabilityCheck.stable || stabilityCheck.elapsed === undefined) {
                broadcastToSSE({
                  type: 'rtkrcv_data',
                  data: parsedData
                });
              }
              
              log('info', `✅ Station ${parsedData.stationId}: ${parsedData.quality.statusText}, Sats: ${parsedData.quality.satellites}, Lat: ${parsedData.llh.lat}, Lon: ${parsedData.llh.lon}`);
              
              // 清除已使用的 ECEF 缓存
              ecefCache.delete(stationId);
            } else {
              log('error', `❌ Failed to parse data packet for station ${stationId}`);
            }
          } else {
            // 无 ECEF，仅 LLH 单行模式：直接解析并解算
            log('info', `ℹ️ LLH-only received for station ${stationId}, proceeding without ECEF`);
            const parsedData = parseRtkcrvOutput(line);
            if (parsedData) {
              // 写入数据流日志（仅原始一行）
              writeDataLog(parsedData, line);
              
              // 稳定性检测
              const stabilityCheck = checkStationStability(parsedData.stationId, parsedData);
              
              parsedData.stability = {
                stable: stabilityCheck.stable,
                collecting: stabilityCheck.collecting || false,
                elapsed: stabilityCheck.elapsed || 0,
                sampleCount: stabilityCheck.sampleCount || 0,
                required: config.stabilityRequiredSeconds
              };
              
              if (stabilityCheck.stable && stabilityCheck.average) {
                parsedData.average = stabilityCheck.average;
              }
              
              latestData.set(parsedData.stationId, parsedData);
              
              if (!stabilityCheck.stable || stabilityCheck.elapsed === undefined) {
                broadcastToSSE({
                  type: 'rtkrcv_data',
                  data: parsedData
                });
              }
              
              log('info', `✅(LLH-only) Station ${parsedData.stationId}: ${parsedData.quality.statusText}, Sats: ${parsedData.quality.satellites}, Lat: ${parsedData.llh.lat}, Lon: ${parsedData.llh.lon}`);
            } else {
              log('error', `❌ Failed to parse LLH-only line for station ${stationId}`);
            }
          }
        } else {
          log('debug', `Skipping unknown line format: ${line.substring(0, 50)}`);
        }
      }
      
      // 清理超过 10 秒的旧 ECEF 缓存
      const now = Date.now();
      ecefCache.forEach((value, key) => {
        if (now - value.timestamp > 10000) {
          log('debug', `Clearing stale ECEF cache for station ${key}`);
          ecefCache.delete(key);
        }
      });
    });
    
    socket.on('end', () => {
      log('info', `TCP client disconnected: ${clientId}`);
      tcpClients.delete(clientId);
    });
    
    socket.on('error', (err) => {
      log('error', `TCP client error ${clientId}: ${err.message}`);
      tcpClients.delete(clientId);
    });
  });
  
  tcpServer.listen(60000, '0.0.0.0', () => {
    log('info', '📡 TCP server listening on port 60000 for RTKRCV output');
  });
  
  tcpServer.on('error', (err) => {
    log('error', `TCP server error: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      log('warn', 'Port 60000 is already in use, waiting 5 seconds to retry...');
      setTimeout(startTcpServer, 5000);
    }
  });
}

// 广播消息到所有 SSE 客户端
function broadcastToSSE(message) {
  // 对 rtkrcv_data 做按站点的最小间隔限频
  if (message && message.type === 'rtkrcv_data' && message.data && message.data.stationId) {
    try {
      const stationId = message.data.stationId;
      const now = Date.now();
      const last = sseLastSent.get(stationId) || 0;
      const minGap = Number.isFinite(config.sseMinIntervalMs) ? config.sseMinIntervalMs : 0;
      if (now - last < minGap) {
        return;
      }
      sseLastSent.set(stationId, now);
    } catch (e) {
      // 忽略限频异常，保证功能不受影响
    }
  }
  const data = `data: ${JSON.stringify(message)}\n\n`;
  sseClients.forEach((client, id) => {
    try {
      client.write(data);
    } catch (error) {
      log('error', `Error sending to SSE client ${id}: ${error.message}`);
      sseClients.delete(id);
    }
  });
}

// 根据站点 ID 停止 RTKRCV 进程
function stopRtkcrvByStationId(stationId) {
  // 查找包含该站点 ID 的配置文件
  const configFile = `${stationId}.conf`;
  const processInfo = runningProcesses.get(configFile);
  
  if (processInfo) {
    try {
      processInfo.process.kill();
      log('info', `🛑 Station ${stationId}: 已达到稳定，自动关闭 RTKRCV (PID: ${processInfo.pid})`);
      
      // 若存在批量调度，标记成功并释放并发槽，随后立即补位
      try {
        if (batchScheduler && batchScheduler.active && batchScheduler.running && batchScheduler.running.has(stationId)) {
          batchMarkComplete(stationId, true);
          batchSchedulerFillSlots(null);
          log('info', `Batch scheduler: success completed ${stationId}, filling next from queue`);
        }
      } catch (e) {
        log('warn', `Batch scheduler update on auto stop failed: ${e.message}`);
      }
      
      // 推送关闭通知到前端
      broadcastToSSE({
        type: 'rtkrcv_auto_stopped',
        data: {
          stationId: stationId,
          configFile: configFile,
          reason: 'stable',
          message: `站点 ${stationId} 已达到稳定状态，RTKRCV 已自动关闭`
        }
      });
      
      // 清理后端缓存，防止数据监控页面保留已完成的站点
      try { latestData.delete(stationId); } catch (e) {}
      try { stationStability.delete(stationId); } catch (e) {}
      try { ecefCache.delete(stationId); } catch (e) {}
      try { sseLastSent.delete(stationId); } catch (e) {}
      
      return true;
    } catch (error) {
      log('error', `Error stopping RTKRCV for station ${stationId}: ${error.message}`);
      return false;
    }
  } else {
    log('warn', `Cannot stop RTKRCV for station ${stationId}: process not found (config: ${configFile})`);
    return false;
  }
}

// 检查并更新站点稳定性（容错版）
function checkStationStability(stationId, data) {
  const isFixed = data.quality.status === 1; // 1 = 固定解

  let stability = stationStability.get(stationId);

  // 仅在首次出现固定解时开始收集；若当前为浮点且尚未开始，则不创建状态
  if (!stability) {
    if (!isFixed) {
      return { stable: false, collecting: false };
    }
    stability = {
      status: 'collecting',
      startTime: new Date(),
      samples: [],
      average: null,
      // 容错累计
      lastSampleTimeMs: null,
      accumulatedFixedSeconds: 0,
      nonFixedStreakSeconds: 0
    };
    stationStability.set(stationId, stability);
    log('info', `🎯 Station ${stationId}: 检测到固定解，开始收集（容错模式）`);
  }

  // 计算本次样本与上次样本的时间间隔（秒），限制最大间隔，避免时间戳异常
  const currentTimeMs = Date.now();
  let deltaSeconds = 0;
  if (stability.lastSampleTimeMs) {
    deltaSeconds = (currentTimeMs - stability.lastSampleTimeMs) / 1000;
    if (deltaSeconds < 0) deltaSeconds = 0; // 防护
    if (deltaSeconds > config.maxSampleIntervalSeconds) {
      deltaSeconds = config.maxSampleIntervalSeconds;
    }
  }
  stability.lastSampleTimeMs = currentTimeMs;

  // 收集样本（仅在固定时计入）
  if (isFixed) {
    stability.samples.push({
      ecef: {
        x: parseFloat(data.ecef.x),
        y: parseFloat(data.ecef.y),
        z: parseFloat(data.ecef.z)
      },
      llh: {
        lat: parseFloat(data.llh.lat),
        lon: parseFloat(data.llh.lon),
        height: parseFloat(data.llh.height)
      },
      timestamp: new Date(data.timestamp),
      satellites: data.quality.satellites
    });
    // 内存上限：超过最大样本数则丢弃最早样本
    if (Array.isArray(stability.samples) && stability.samples.length > (config.maxSamplesPerStation || 120)) {
      stability.samples.shift();
    }
    stability.accumulatedFixedSeconds += deltaSeconds || 1; // 首个样本按1秒计
    stability.nonFixedStreakSeconds = 0;
  } else {
    // 非固定，若已开始收集则增加非固定连续秒数；未开始的情况在前面已返回
    stability.nonFixedStreakSeconds += deltaSeconds || 1;
    // 若超过容忍阈值，则重置收集
    if (stability.nonFixedStreakSeconds > config.nonFixedToleranceSeconds) {
      log('warn', `⚠️  Station ${stationId}: 非固定超过容忍(${config.nonFixedToleranceSeconds}s)，重置收集。已累计固定 ${stability.accumulatedFixedSeconds.toFixed(1)}s，样本 ${stability.samples.length}`);
      stationStability.delete(stationId);
      return { stable: false, collecting: false };
    }
  }

  // 判定是否达到稳定
  if (stability.status === 'collecting') {
    const criteria = String(config.stabilityCriteria || 'seconds').toLowerCase();
    const requiredSeconds = Number.isFinite(config.stabilityRequiredSeconds) ? Number(config.stabilityRequiredSeconds) : 10;
    const requiredSamples = Number.isFinite(config.stabilityRequiredSamples) ? Number(config.stabilityRequiredSamples) : 70;

    let reached = false;
    if (criteria === 'samples') {
      reached = stability.samples.length >= requiredSamples;
    } else if (criteria === 'both') {
      reached = (stability.accumulatedFixedSeconds >= requiredSeconds) && (stability.samples.length >= requiredSamples);
    } else {
      // 默认按秒
      reached = stability.accumulatedFixedSeconds >= requiredSeconds;
    }

    if (reached) {
      const average = calculateAverage(stability.samples);
      stability.average = average;
      stability.status = 'stable';
      stability.endTime = new Date();

      if (criteria === 'samples') {
        log('info', `✅ Station ${stationId}: 达到稳定（样本）。样本 ${stability.samples.length}/${requiredSamples}，累计 ${stability.accumulatedFixedSeconds.toFixed(1)}s`);
      } else if (criteria === 'both') {
        log('info', `✅ Station ${stationId}: 达到稳定（秒+样本）。${stability.accumulatedFixedSeconds.toFixed(1)}s/${requiredSeconds}s，样本 ${stability.samples.length}/${requiredSamples}`);
      } else {
        log('info', `✅ Station ${stationId}: 达到稳定（秒）。累计 ${stability.accumulatedFixedSeconds.toFixed(1)}s/${requiredSeconds}s，样本数 ${stability.samples.length}`);
      }

      // 自动保存稳定结果（防止中断后丢失）
      try {
        const results = readStableResults();
        const nowIso = new Date().toISOString();
        const record = {
          id: `${stationId}_${Date.now()}`,
          stationId: stationId,
          timestamp: nowIso,
          ecef_x: String(average.ecef.x),
          ecef_y: String(average.ecef.y),
          ecef_z: String(average.ecef.z),
          lat: String(average.llh.lat),
          lon: String(average.llh.lon),
          height: String(average.llh.height),
          // 扩展字段：用于前端展示样本数与是否过滤
          sampleCount: Number(average.sampleCount || 0),
          filtered: !!average.filtered,
          removedSampleCount: Number(average.removedSampleCount || 0)
        };
        // 简单去重：若最近已有同站点且时间差<60秒，则跳过
        const nowMs = Date.now();
        const duplicate = results.some(r => r.stationId === stationId && Math.abs(nowMs - new Date(r.timestamp || nowIso).getTime()) < 60000);
        if (!duplicate) {
          results.unshift(record);
          writeStableResults(results);
          // 数据库：写入稳定结果
          try { dbInsertStableResult(record); } catch (e3) {}
          // 追加至成功列表文本（便于下一次计算使用）
          try {
            ensureDirectories();
            const successTxtPath = path.join(config.generatedDir, 'last_success.txt');
            fs.appendFileSync(successTxtPath, `${stationId}\n`);
          } catch (e2) {}
        }
      } catch (e) {
        log('warn', `Auto-save stable result failed for ${stationId}: ${e.message}`);
      }

      broadcastToSSE({
        type: 'station_stable',
        data: {
          stationId: stationId,
          average: average,
          sampleCount: stability.samples.length,
          duration: stability.accumulatedFixedSeconds.toFixed(1),
          startTime: stability.startTime.toISOString(),
          endTime: stability.endTime.toISOString()
        }
      });

      // 达到稳定后，根据配置释放样本以降低内存
      if (!config.keepSamplesAfterStable) {
        stability.samples = [];
      }

      setTimeout(() => {
        stopRtkcrvByStationId(stationId);
      }, 2000);

      return { stable: true, average: average };
    } else {
      if (criteria === 'samples') {
        log('debug', `📊 Station ${stationId}: 收集中 样本 ${stability.samples.length}/${requiredSamples}，累计 ${stability.accumulatedFixedSeconds.toFixed(1)}s，非固定连续 ${stability.nonFixedStreakSeconds.toFixed(1)}s`);
      } else if (criteria === 'both') {
        log('debug', `📊 Station ${stationId}: 收集中 ${stability.accumulatedFixedSeconds.toFixed(1)}s/${requiredSeconds}s & 样本 ${stability.samples.length}/${requiredSamples}，非固定连续 ${stability.nonFixedStreakSeconds.toFixed(1)}s`);
      } else {
        log('debug', `📊 Station ${stationId}: 收集中 ${stability.accumulatedFixedSeconds.toFixed(1)}s/${requiredSeconds}s，样本数 ${stability.samples.length}，非固定连续 ${stability.nonFixedStreakSeconds.toFixed(1)}s`);
      }
      return { stable: false, collecting: true, elapsed: stability.accumulatedFixedSeconds, sampleCount: stability.samples.length };
    }
  }

  // 已稳定
  return { stable: true, average: stability.average };
}

// 计算样本均值（优化版：去除误差最大的2个样本）
function calculateAverage(samples) {
  if (samples.length === 0) return null;
  
  // 如果样本数量少于等于3个，不去除任何样本（至少保留1个样本）
  if (samples.length <= 3) {
    log('warn', `样本数量不足 (${samples.length}个)，不进行异常值过滤`);
    return calculateAverageInternal(samples);
  }
  
  // 步骤1：计算初步平均值（使用所有样本）
  const preliminaryMean = calculateAverageInternal(samples);
  
  // 步骤2：计算每个样本到平均值的距离
  const samplesWithDistance = samples.map((sample, index) => {
    // 计算ECEF坐标的欧氏距离
    const dx = sample.ecef.x - parseFloat(preliminaryMean.ecef.x);
    const dy = sample.ecef.y - parseFloat(preliminaryMean.ecef.y);
    const dz = sample.ecef.z - parseFloat(preliminaryMean.ecef.z);
    const ecefDistance = Math.sqrt(dx*dx + dy*dy + dz*dz);
    
    // 计算LLH坐标的距离（归一化后的距离）
    const dlat = (sample.llh.lat - parseFloat(preliminaryMean.llh.lat)) * 111320; // 1度纬度约111km
    const dlon = (sample.llh.lon - parseFloat(preliminaryMean.llh.lon)) * 111320 * Math.cos(sample.llh.lat * Math.PI / 180);
    const dheight = sample.llh.height - parseFloat(preliminaryMean.llh.height);
    const llhDistance = Math.sqrt(dlat*dlat + dlon*dlon + dheight*dheight);
    
    // 使用ECEF距离作为主要依据（更准确）
    return {
      sample: sample,
      distance: ecefDistance,
      llhDistance: llhDistance,
      index: index
    };
  });
  
  // 步骤3：按距离排序，找出最大的2个
  samplesWithDistance.sort((a, b) => b.distance - a.distance);
  
  // 记录被移除的样本
  const removed1 = samplesWithDistance[0];
  const removed2 = samplesWithDistance[1];
  
  log('info', `🔍 异常值检测: 移除误差最大的2个样本`);
  log('info', `  ❌ 样本#${removed1.index + 1}: ECEF距离=${removed1.distance.toFixed(4)}m, LLH距离=${removed1.llhDistance.toFixed(4)}m`);
  log('info', `  ❌ 样本#${removed2.index + 1}: ECEF距离=${removed2.distance.toFixed(4)}m, LLH距离=${removed2.llhDistance.toFixed(4)}m`);
  
  // 步骤4：去除最大的2个样本
  const filteredSamples = samplesWithDistance.slice(2).map(item => item.sample);
  
  log('info', `✅ 保留样本数: ${filteredSamples.length} / ${samples.length}`);
  
  // 步骤5：使用过滤后的样本计算最终平均值
  const finalAverage = calculateAverageInternal(filteredSamples);
  
  // 添加过滤信息
  finalAverage.filtered = true;
  finalAverage.originalSampleCount = samples.length;
  finalAverage.removedSampleCount = 2;
  finalAverage.removedSamples = [
    {
      index: removed1.index + 1,
      ecefDistance: removed1.distance.toFixed(4),
      llhDistance: removed1.llhDistance.toFixed(4)
    },
    {
      index: removed2.index + 1,
      ecefDistance: removed2.distance.toFixed(4),
      llhDistance: removed2.llhDistance.toFixed(4)
    }
  ];
  
  return finalAverage;
}

// 内部函数：直接计算平均值（不过滤异常值）
function calculateAverageInternal(samples) {
  if (samples.length === 0) return null;
  
  const sum = samples.reduce((acc, sample) => {
    return {
      ecef: {
        x: acc.ecef.x + sample.ecef.x,
        y: acc.ecef.y + sample.ecef.y,
        z: acc.ecef.z + sample.ecef.z
      },
      llh: {
        lat: acc.llh.lat + sample.llh.lat,
        lon: acc.llh.lon + sample.llh.lon,
        height: acc.llh.height + sample.llh.height
      },
      satellites: acc.satellites + sample.satellites
    };
  }, {
    ecef: { x: 0, y: 0, z: 0 },
    llh: { lat: 0, lon: 0, height: 0 },
    satellites: 0
  });
  
  const count = samples.length;
  
  // 计算平均值
  const mean = {
    ecef: {
      x: sum.ecef.x / count,
      y: sum.ecef.y / count,
      z: sum.ecef.z / count
    },
    llh: {
      lat: sum.llh.lat / count,
      lon: sum.llh.lon / count,
      height: sum.llh.height / count
    }
  };
  
  // 计算标准差
  const stdDev = calculateStdDev(samples, mean);
  
  return {
    ecef: {
      x: mean.ecef.x.toFixed(4),
      y: mean.ecef.y.toFixed(4),
      z: mean.ecef.z.toFixed(4)
    },
    llh: {
      lat: mean.llh.lat.toFixed(9),
      lon: mean.llh.lon.toFixed(9),
      height: mean.llh.height.toFixed(4)
    },
    satellites: Math.round(sum.satellites / count),
    sampleCount: count,
    stdDev: stdDev
  };
}

// 计算标准差
function calculateStdDev(samples, mean) {
  if (samples.length < 2) return null;
  
  const variance = samples.reduce((acc, sample) => {
    return {
      ecef: {
        x: acc.ecef.x + Math.pow(sample.ecef.x - mean.ecef.x, 2),
        y: acc.ecef.y + Math.pow(sample.ecef.y - mean.ecef.y, 2),
        z: acc.ecef.z + Math.pow(sample.ecef.z - mean.ecef.z, 2)
      },
      llh: {
        lat: acc.llh.lat + Math.pow(sample.llh.lat - mean.llh.lat, 2),
        lon: acc.llh.lon + Math.pow(sample.llh.lon - mean.llh.lon, 2),
        height: acc.llh.height + Math.pow(sample.llh.height - mean.llh.height, 2)
      }
    };
  }, {
    ecef: { x: 0, y: 0, z: 0 },
    llh: { lat: 0, lon: 0, height: 0 }
  });
  
  const count = samples.length;
  
  return {
    ecef: {
      x: Math.sqrt(variance.ecef.x / count).toFixed(4),
      y: Math.sqrt(variance.ecef.y / count).toFixed(4),
      z: Math.sqrt(variance.ecef.z / count).toFixed(4)
    },
    llh: {
      lat: Math.sqrt(variance.llh.lat / count).toFixed(9),
      lon: Math.sqrt(variance.llh.lon / count).toFixed(9),
      height: Math.sqrt(variance.llh.height / count).toFixed(4)
    }
  };
}

// 写入数据流日志（合并到进程日志）
function writeDataLog(parsedData, rawData) {
  try {
    // 仅在固定解(q === 1)时写入TCP数据流日志
    if (!parsedData || !parsedData.quality || parsedData.quality.status !== 1) {
      return;
    }
    const stationId = parsedData.stationId;
    const configFile = `${stationId}.conf`;
    
    // 查找对应的RTKRCV进程
    const processInfo = runningProcesses.get(configFile);
    
    if (processInfo && processInfo.logStream) {
      // 格式化日志内容
      let logEntry = `\n[TCP数据流] ${parsedData.dateTime} - ${parsedData.quality.statusText} (${parsedData.quality.satellites}颗卫星)\n` +
                     `  ECEF: X=${parsedData.ecef.x} Y=${parsedData.ecef.y} Z=${parsedData.ecef.z}\n` +
                     `  LLH:  Lat=${parsedData.llh.lat}° Lon=${parsedData.llh.lon}° H=${parsedData.llh.height}m\n`;
      if (config.enableRawDataLog) {
        logEntry += `  原始数据:\n${rawData}\n`;
      }
      
      processInfo.logStream.write(logEntry);
    } else {
      // 如果进程不存在，直接追加到日志文件
      const logFileName = `${stationId}.log`;
      const logPath = path.join(config.generatedDir, logFileName);
      
      if (fs.existsSync(logPath)) {
        let logEntry = `\n[TCP数据流] ${parsedData.dateTime} - ${parsedData.quality.statusText} (${parsedData.quality.satellites}颗卫星)\n` +
                       `  ECEF: X=${parsedData.ecef.x} Y=${parsedData.ecef.y} Z=${parsedData.ecef.z}\n` +
                       `  LLH:  Lat=${parsedData.llh.lat}° Lon=${parsedData.llh.lon}° H=${parsedData.llh.height}m\n`;
        if (config.enableRawDataLog) {
          logEntry += `  原始数据:\n${rawData}\n`;
        }
        
        fs.appendFileSync(logPath, logEntry);
      }
    }
  } catch (error) {
    log('error', `Error writing data log: ${error.message}`);
  }
}

// 生成配置文件
app.post('/api/generate-config', (req, res) => {
  try {
    const { inpstr1, inpstr2, inpstr3, outHeight } = req.body;
    
    // 验证输入
    if (!inpstr1 || !inpstr2 || !inpstr3 || outHeight === undefined) {
      log('warn', 'Missing required fields in request');
      return res.status(400).json({ 
        success: false, 
        message: '请填写所有必需字段' 
      });
    }

    const { fileName, content } = generateConfigFile({ inpstr1, inpstr2, inpstr3, outHeight });
 
    res.json({ 
      success: true, 
      message: `配置文件已生成: ${fileName}`,
      fileName: fileName,
      content: content
    });
    
  } catch (error) {
    log('error', `Error generating config: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: '生成配置文件时出错: ' + error.message 
    });
  }
});

// 批量摘要：输出成功/失败/剩余列表并返回
app.get('/api/batch/summary', (req, res) => {
  try {
    ensureDirectories();
    const lastBatchMetaFile = path.join(config.generatedDir, 'last_batch.json');
    let original = [];
    if (fs.existsSync(lastBatchMetaFile)) {
      const meta = JSON.parse(fs.readFileSync(lastBatchMetaFile, 'utf-8'));
      original = Array.isArray(meta.list) ? meta.list : [];
    } else {
      original = Array.isArray(batchScheduler.originalList) ? batchScheduler.originalList : [];
    }
    const successes = Array.isArray(batchScheduler.successes) && batchScheduler.successes.length > 0
      ? batchScheduler.successes.slice()
      : Array.from(new Set(readStableResults().map(r => r.stationId))); // 退化：用已保存稳定结果近似成功集
    const failuresDetail = readFailedResults(); // [{ stationId, round, index, at }]
    const successSet = new Set(successes);
    // 下一轮/剩余列表仅按成功站点过滤，失败站点不会被排除
    const remaining = original.filter(x => !successSet.has(x.stationId));
    
    const toStationTxt = (arr) => arr.map(x => typeof x === 'string'
      ? x
      : `${x.stationId}${x.outHeight !== undefined ? ' ' + x.outHeight : ''}`).join('\n');
    const toFailedTxt = (arr) => arr.map((f) => {
      if (!f) return '';
      if (typeof f === 'string') return f;
      const parts = [f.stationId];
      if (typeof f.round === 'number') parts.push(`round:${f.round}`);
      if (typeof f.index === 'number') parts.push(`idx:${f.index}`);
      return parts.filter(Boolean).join(' ');
    }).filter(Boolean).join('\n');

    fs.writeFileSync(path.join(config.generatedDir, 'last_success.txt'), toStationTxt(successes), 'utf-8');
    fs.writeFileSync(path.join(config.generatedDir, 'last_failed.txt'), toFailedTxt(failuresDetail), 'utf-8');
    fs.writeFileSync(path.join(config.generatedDir, 'last_remaining.txt'), toStationTxt(remaining), 'utf-8');
    
    res.json({
      success: true,
      counts: {
        original: original.length,
        successes: Array.isArray(successes) ? successes.length : 0,
        failures: Array.isArray(failuresDetail) ? failuresDetail.length : 0,
        remaining: remaining.length
      },
      files: {
        successTxt: 'last_success.txt',
        failedTxt: 'last_failed.txt',
        remainingTxt: 'last_remaining.txt'
      }
    });
  } catch (error) {
    log('error', `Batch summary error: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '获取批量摘要失败: ' + error.message
    });
  }
});

// 继续上次未完成的批量：使用 last_batch.json 生成“剩余列表”并重新启动调度
app.post('/api/batch/resume', (req, res) => {
  try {
    const { concurrency } = req.body || {};
    if (batchScheduler.active) {
      return res.status(400).json({ success: false, message: '批量已在运行，无法继续' });
    }
    ensureDirectories();
    const lastBatchMetaFile = path.join(config.generatedDir, 'last_batch.json');
    if (!fs.existsSync(lastBatchMetaFile)) {
      return res.status(404).json({ success: false, message: '未找到上次批量的元数据' });
    }
    const meta = JSON.parse(fs.readFileSync(lastBatchMetaFile, 'utf-8'));
    const original = Array.isArray(meta.list) ? meta.list : [];
    const successes = new Set(readStableResults().map(r => r.stationId));
    // 失败站点仅用于记录，不再作为过滤条件，下一轮继续处理它们
    const remaining = original.filter(x => !successes.has(x.stationId));
    if (remaining.length === 0) {
      return res.json({ success: true, message: '没有待处理的站点', remaining: 0 });
    }
    // 初始化调度器
    const conc = parseInt(concurrency, 10);
    const realConc = (!Number.isNaN(conc) && conc > 0) ? conc : (Number.isInteger(meta.concurrency) && meta.concurrency > 0 ? meta.concurrency : 5);
    batchScheduler.active = true;
    batchScheduler.concurrency = realConc;
    batchScheduler.pending = remaining.slice();
    batchScheduler.running = new Map();
    batchScheduler.successCount = 0;
    batchScheduler.failCount = 0;
    batchScheduler.completedCount = 0;
    batchScheduler.cooldownUntil = 0;
    batchScheduler.failures = [];
    batchScheduler.successes = [];
    batchScheduler.originalList = remaining.slice();
    writeFailedResults([]); // 新一轮失败列表重新计
    batchScheduler.options = {
      inpstr1Base: meta.options.inpstr1Base,
      inpstr2: meta.options.inpstr2,
      inpstr3: meta.options.inpstr3
    };
    const startedNow = [];
    batchSchedulerFillSlots(startedNow);
    res.json({
      success: true,
      total: remaining.length,
      started: startedNow.filter(r => r.success).length,
      failed: startedNow.filter(r => !r.success).length,
      queued: batchScheduler.pending.length,
      concurrency: batchScheduler.concurrency,
      running: batchScheduler.running.size,
      results: startedNow
    });
  } catch (error) {
    log('error', `Batch resume error: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '继续批量失败: ' + error.message
    });
  }
});

// 批量调度状态
app.get('/api/batch/status', (req, res) => {
  try {
    res.json({
      success: true,
      active: batchScheduler.active,
      concurrency: batchScheduler.concurrency,
      pending: batchScheduler.pending ? batchScheduler.pending.length : 0,
      running: batchScheduler.running ? Array.from(batchScheduler.running.keys()) : [],
      hasOptions: !!batchScheduler.options,
      successCount: batchScheduler.successCount || 0,
      failCount: batchScheduler.failCount || 0,
      completedCount: batchScheduler.completedCount || 0,
      cooldownRemainingSeconds: Math.max(0, Math.ceil((batchScheduler.cooldownUntil - Date.now()) / 1000))
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取失败的站点编号列表
app.get('/api/batch/failures', (req, res) => {
  try {
    // 以文件为准，若文件不可用则回退到内存
    let failures = readFailedResults();
    if (!Array.isArray(failures) || failures.length === 0) {
      failures = Array.isArray(batchScheduler.failures) ? batchScheduler.failures.slice() : [];
    }
    res.json({
      success: true,
      count: failures.length,
      failures: failures
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// 取消批量调度：清空队列，可选停止正在运行
app.post('/api/batch/cancel', (req, res) => {
  try {
    const { stopRunning } = req.body || {};
    const wasActive = batchScheduler.active;
    const queued = batchScheduler.pending ? batchScheduler.pending.length : 0;
    const runningCount = batchScheduler.running ? batchScheduler.running.size : 0;
    const stopped = [];
    const stopErrors = [];
    
    // 同时关闭多轮调度
    disableRounds();
    
    // 关闭调度器并清空队列
    batchScheduler.active = false;
    batchScheduler.pending = [];
    batchScheduler.options = null;
    batchScheduler.cooldownUntil = 0;
    // 不清空历史失败：保留给用户查询
    
    // 可选：停止所有正在运行的进程
    if (stopRunning && runningCount > 0) {
      batchScheduler.running.forEach((meta, stationId) => {
        try {
          const configFile = `${stationId}.conf`;
          const info = runningProcesses.get(configFile);
          if (info) {
            // 推送手动停止通知到前端，便于前端立即清理卡片
            broadcastToSSE({
              type: 'rtkrcv_manual_stopped',
              data: {
                stationId: stationId,
                configFile: configFile,
                reason: 'batch_cancel',
                message: `站点 ${stationId} 因批量中断被停止`
              }
            });
            // 清理后端缓存，防止卡片重新出现
            try { latestData.delete(stationId); } catch (e) {}
            try { stationStability.delete(stationId); } catch (e) {}
            try { ecefCache.delete(stationId); } catch (e) {}
            try { sseLastSent.delete(stationId); } catch (e) {}
            info.process.kill();
            stopped.push(stationId);
          }
        } catch (e) {
          stopErrors.push({ stationId, error: e.message || String(e) });
        }
      });
    }
    
    // 生成本轮运行摘要列表文件（成功/失败/剩余），便于下一次计算
    try {
      ensureDirectories();
      const lastBatchMetaFile = path.join(config.generatedDir, 'last_batch.json');
      let original = [];
      if (fs.existsSync(lastBatchMetaFile)) {
        const meta = JSON.parse(fs.readFileSync(lastBatchMetaFile, 'utf-8'));
        original = Array.isArray(meta.list) ? meta.list : [];
      } else {
        original = Array.isArray(batchScheduler.originalList) ? batchScheduler.originalList : [];
      }
      const successes = Array.isArray(batchScheduler.successes) ? batchScheduler.successes : [];
      const failures = readFailedResults();
      const successSet = new Set(successes);
      const failSet = new Set(failures);
      const remaining = original.filter(x => !successSet.has(x.stationId) && !failSet.has(x.stationId));
      // 写文本列表
      const mkTxt = (arr) => arr.map(x => typeof x === 'string' ? x : `${x.stationId}${x.outHeight !== undefined ? ' ' + x.outHeight : ''}`).join('\n');
      fs.writeFileSync(path.join(config.generatedDir, 'last_success.txt'), mkTxt(successes), 'utf-8');
      fs.writeFileSync(path.join(config.generatedDir, 'last_failed.txt'), mkTxt(failures), 'utf-8');
      fs.writeFileSync(path.join(config.generatedDir, 'last_remaining.txt'), mkTxt(remaining), 'utf-8');
    } catch (e) {
      log('warn', `Write batch summary files failed: ${e.message}`);
    }
    
    res.json({
      success: true,
      wasActive,
      clearedQueued: queued,
      runningBefore: runningCount,
      stoppedRunning: stopped.length,
      stopErrors,
      successCount: batchScheduler.successCount,
      failCount: batchScheduler.failCount,
      completedCount: batchScheduler.completedCount
    });
  } catch (error) {
    log('error', `Batch cancel error: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '取消批量失败: ' + error.message
    });
  }
});

// 批量：从TXT读取并并行（或限流并发）启动多个站点
app.post('/api/batch/run-txt', (req, res) => {
  try {
    const { txtPath, txtContent, inpstr1Base, inpstr2, inpstr3, concurrency, skipFailed = true, skipSucceeded = true, rounds, roundIntervalMinutes } = req.body || {};
    
    if ((!txtPath && !txtContent) || !inpstr1Base) {
      return res.status(400).json({
        success: false,
        message: '请提供 txtPath 或 txtContent，以及 inpstr1Base'
      });
    }
    
    // 若未提供 inpstr2/3，则从模板读取默认值
    let tplInp2 = inpstr2;
    let tplInp3 = inpstr3;
    if (!tplInp2 || !tplInp3) {
      const tpl = readTemplate();
      if (!tplInp2) {
        const m2 = tpl.match(/^inpstr2-path\s*=\s*(.+)$/m);
        if (m2 && m2[1]) tplInp2 = m2[1].trim();
      }
      if (!tplInp3) {
        const m3 = tpl.match(/^inpstr3-path\s*=\s*(.+)$/m);
        if (m3 && m3[1]) tplInp3 = m3[1].trim();
      }
    }
    
    if (!tplInp2 || !tplInp3) {
      return res.status(400).json({
        success: false,
        message: '无法确定 inpstr2 或 inpstr3，请在请求体中提供或在模板中配置'
      });
    }
    
    // 确定TXT来源：路径或内容
    let list = [];
    if (txtContent && typeof txtContent === 'string') {
      // 将内容保存为临时文件，便于统一处理
      ensureDirectories();
      const tmpName = `stations_${Date.now()}.txt`;
      const tmpPath = path.join(config.generatedDir, tmpName);
      fs.writeFileSync(tmpPath, txtContent, 'utf-8');
      log('info', `Saved uploaded TXT content to: ${tmpPath}`);
      list = parseStationsTxt(tmpPath);
    } else {
      const resolved = path.isAbsolute(txtPath) ? txtPath : path.join(__dirname, txtPath);
      list = parseStationsTxt(resolved);
    }
    if (list.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'TXT 中没有有效的站点数据（格式：stationId outHeight）'
      });
    }
    
    const base = ensureTrailingSlash(inpstr1Base);
    
    // 可选：根据历史结果过滤输入列表（剔除失败/已成功）
    try {
      const failed = skipFailed ? new Set(readFailedResults()) : new Set();
      const succeeded = skipSucceeded ? new Set(readStableResults().map(r => r.stationId)) : new Set();
      const before = list.length;
      list = list.filter(it => !failed.has(it.stationId) && !succeeded.has(it.stationId));
      const removed = before - list.length;
      if (removed > 0) {
        log('info', `Filtered ${removed} stations by skipFailed=${!!skipFailed}, skipSucceeded=${!!skipSucceeded}`);
      }
      // 保存“本次要处理的剩余列表”到文件，便于下次计算
      try {
        ensureDirectories();
        const remainingTxt = list.map(x => `${x.stationId} ${x.outHeight}`).join('\n');
        fs.writeFileSync(path.join(config.generatedDir, 'last_remaining.txt'), remainingTxt, 'utf-8');
      } catch (e2) {}
    } catch (e) {
      log('warn', `Filtering by history failed: ${e.message}`);
    }
    
    // 记录本轮原始列表与元数据（便于中断后恢复与生成新列表，同时支持多轮调度）
    try {
      ensureDirectories();
      const lastBatchMetaFile = path.join(config.generatedDir, 'last_batch.json');
      const originalList = list.map(it => ({ stationId: it.stationId, outHeight: it.outHeight }));
      const meta = {
        startedAt: new Date().toISOString(),
        options: { inpstr1Base: base, inpstr2: tplInp2, inpstr3: tplInp3 },
        concurrency: Number.isNaN(parseInt(concurrency, 10)) ? null : parseInt(concurrency, 10),
        list: originalList
      };
      fs.writeFileSync(lastBatchMetaFile, JSON.stringify(meta, null, 2), 'utf-8');
      log('info', `Saved last batch meta: ${lastBatchMetaFile} (${originalList.length} stations)`);
      // 同时将本轮原始列表保存为文本（stationId outHeight）
      const originalTxt = originalList.map(x => `${x.stationId} ${x.outHeight}`).join('\n');
      fs.writeFileSync(path.join(config.generatedDir, 'last_batch_original.txt'), originalTxt, 'utf-8');

      // 初始化轮次管理（若请求指定 rounds >= 2 则启用）
      const roundsInt = parseInt(rounds, 10);
      const intervalMinInt = parseInt(roundIntervalMinutes, 10);
      if (!Number.isNaN(roundsInt) && roundsInt >= 2) {
        clearRoundTimer();
        roundManager.enabled = true;
        roundManager.totalRounds = roundsInt;
        roundManager.currentRound = 1;
        roundManager.intervalMs = (!Number.isNaN(intervalMinInt) && intervalMinInt > 0 ? intervalMinInt : 20) * 60 * 1000;
        roundManager.seedOriginalList = originalList.slice();
        roundManager.lastRoundSuccesses = [];
        roundManager.options = {
          inpstr1Base: base,
          inpstr2: tplInp2,
          inpstr3: tplInp3,
          concurrency: Number.isNaN(parseInt(concurrency, 10)) ? 5 : parseInt(concurrency, 10)
        };
        roundManager.currentList = originalList.slice();
        roundManager.nextRoundAt = 0;
        writeRoundState();
        log('info', `Round manager enabled: rounds=${roundManager.totalRounds}, intervalMinutes=${Math.round(roundManager.intervalMs/60000)}`);
      } else {
        // 未启用多轮时，关闭轮次管理
        disableRounds();
      }
    } catch (e) {
      log('warn', `Failed to write last batch meta: ${e.message}`);
    }

    // 如果提供了并发限制，则使用调度器
    const conc = parseInt(concurrency, 10);
    if (!Number.isNaN(conc) && conc > 0) {
      // 初始化调度器
      batchScheduler.active = true;
      batchScheduler.concurrency = conc;
      batchScheduler.pending = list.slice(); // 按顺序排队
      batchScheduler.running = new Map();
      batchScheduler.successCount = 0;
      batchScheduler.failCount = 0;
      batchScheduler.completedCount = 0;
      batchScheduler.cooldownUntil = 0;
      batchScheduler.failures = [];
      batchScheduler.successes = [];
      batchScheduler.originalList = list.slice();
    // 清空并初始化失败结果文件
    writeFailedResults([]);
      batchScheduler.options = {
        inpstr1Base: base,
        inpstr2: tplInp2,
        inpstr3: tplInp3
      };
      const startedNow = [];
      batchSchedulerFillSlots(startedNow);
      const queuedCount = batchScheduler.pending.length;
      
      // 仅返回“本次立即启动”的结果，同时给出排队数量
      const started = startedNow.filter(r => r.success).length;
      const failed = startedNow.filter(r => !r.success).length;
      return res.json({
        success: true,
        total: list.length,
        started,
        failed,
        queued: queuedCount,
        concurrency: batchScheduler.concurrency,
        running: batchScheduler.running.size,
        results: startedNow
      });
    } else {
      // 原行为：全部立即启动（不做并发限制）
      const results = [];
      for (const item of list) {
        try {
          const stationId = item.stationId;
          const outHeight = item.outHeight;
          const inp1 = `${base}${stationId}`;
          
          const { fileName } = generateConfigFile({
            inpstr1: inp1,
            inpstr2: tplInp2,
            inpstr3: tplInp3,
            outHeight: outHeight
          });
          
          const startInfo = startRtkrcvInternal(fileName);
          
          results.push({
            stationId,
            configFile: fileName,
            pid: startInfo.pid,
            logFile: startInfo.logFileName,
            success: true
          });
        } catch (e) {
          results.push({
            stationId: item.stationId,
            error: e.message || String(e),
            success: false
          });
        }
      }
      const started = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;
      return res.json({
        success: true,
        total: results.length,
        started,
        failed,
        results
      });
    }
  } catch (error) {
    log('error', `Batch run error: ${error.message}`);
    return res.status(500).json({
      success: false,
      message: '批量执行失败: ' + error.message
    });
  }
});

// 下载配置文件
app.get('/api/download/:filename', (req, res) => {
  try {
    const fileName = req.params.filename;
    const filePath = path.join(config.generatedDir, fileName);
    
    if (!fs.existsSync(filePath)) {
      log('warn', `File not found: ${fileName}`);
      return res.status(404).json({ 
        success: false, 
        message: '文件不存在' 
      });
    }
    
    log('info', `Downloading file: ${fileName}`);
    res.download(filePath, fileName);
  } catch (error) {
    log('error', `Error downloading file: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: '下载文件时出错' 
    });
  }
});

// 获取已生成的配置文件列表
app.get('/api/configs', (req, res) => {
  try {
    ensureDirectories();
    
    if (!fs.existsSync(config.generatedDir)) {
      return res.json({ success: true, files: [] });
    }
    
    const files = fs.readdirSync(config.generatedDir)
      .filter(file => file.toLowerCase().endsWith('.conf'))
      .map(file => {
        try {
          const stationId = file.toLowerCase().endsWith('.conf') ? file.slice(0, -5) : file;
          const stats = fs.statSync(path.join(config.generatedDir, file));
          
          // 检查是否存在日志文件
          const logCandidates = [
            `${stationId}.log`,
            `${stationId}.LOG`
          ];
          const logFilePath = logCandidates.map(n => path.join(config.generatedDir, n)).find(p => fs.existsSync(p));
          const logFile = logFilePath ? path.basename(logFilePath) : null;
          
          return {
            name: file,
            created: stats.mtime,
            logFile: logFile
          };
        } catch (e) {
          log('warn', `Skipping file due to error: ${file} - ${e.message}`);
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.created - a.created);
    
    res.json({ success: true, files });
  } catch (error) {
    log('error', `Error listing configs: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: '获取文件列表时出错' 
    });
  }
});

// 删除配置文件
app.delete('/api/config/delete/:filename', (req, res) => {
  try {
    const fileName = req.params.filename;
    const filePath = path.join(config.generatedDir, fileName);
    
    // 验证文件名（防止目录遍历攻击）
    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      return res.status(400).json({
        success: false,
        message: '非法的文件名'
      });
    }
    
    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: '配置文件不存在'
      });
    }
    
    // 检查是否有正在运行的进程使用此配置
    if (runningProcesses.has(fileName)) {
      return res.status(400).json({
        success: false,
        message: '该配置文件正在被使用中，请先停止相关的 RTKRCV 进程'
      });
    }
    
    // 删除配置文件
    fs.unlinkSync(filePath);
    log('info', `Deleted config file: ${fileName}`);

    // 同名日志文件也删除（如果存在）
    const stationId = fileName.replace('.conf', '');
    const logFile = `${stationId}.log`;
    const logPath = path.join(config.generatedDir, logFile);
    if (fs.existsSync(logPath)) {
      // 确保没有相关进程在使用
      if (!runningProcesses.has(fileName)) {
        try {
          fs.unlinkSync(logPath);
          log('info', `Deleted related log file: ${logFile}`);
        } catch (e) {
          log('warn', `Failed to delete related log file ${logFile}: ${e.message}`);
        }
      }
    }
    
    res.json({
      success: true,
      message: `配置文件 ${fileName} 已删除`
    });
    
  } catch (error) {
    log('error', `Error deleting config file: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '删除文件时出错: ' + error.message
    });
  }
});

// 删除日志文件
app.delete('/api/log/delete/:filename', (req, res) => {
  try {
    const fileName = req.params.filename;
    const filePath = path.join(config.generatedDir, fileName);
    
    // 验证文件名（防止目录遍历攻击）
    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      return res.status(400).json({
        success: false,
        message: '非法的文件名'
      });
    }
    
    // 只允许删除.log文件
    if (!fileName.endsWith('.log')) {
      return res.status(400).json({
        success: false,
        message: '只能删除日志文件'
      });
    }
    
    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: '日志文件不存在'
      });
    }
    
    // 检查是否有正在使用此日志的进程
    const stationId = fileName.replace('.log', '');
    const configFile = `${stationId}.conf`;
    if (runningProcesses.has(configFile)) {
      return res.status(400).json({
        success: false,
        message: '该日志文件正在被使用中，请先停止相关的 RTKRCV 进程'
      });
    }
    
    // 删除文件
    fs.unlinkSync(filePath);
    log('info', `Deleted log file: ${fileName}`);
    
    res.json({
      success: true,
      message: `日志文件 ${fileName} 已删除`
    });
    
  } catch (error) {
    log('error', `Error deleting log file: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '删除日志文件时出错: ' + error.message
    });
  }
});

// 获取所有稳定结果
app.get('/api/stable-results', (req, res) => {
  try {
    const results = readStableResults().map(r => {
      // 兼容旧数据：补全可选字段，避免前端显示 undefined
      if (r.sampleCount === undefined && r.sample_count !== undefined) {
        r.sampleCount = r.sample_count;
      }
      if (r.filtered === undefined && r.filter !== undefined) {
        r.filtered = !!r.filter;
      }
      if (r.removedSampleCount === undefined && r.removed_count !== undefined) {
        r.removedSampleCount = r.removed_count;
      }
      if (r.sampleCount === undefined) r.sampleCount = 0;
      if (r.filtered === undefined) r.filtered = false;
      if (r.removedSampleCount === undefined) r.removedSampleCount = 0;
      return r;
    });
    res.json({
      success: true,
      results: results,
      count: results.length
    });
  } catch (error) {
    log('error', `Error getting stable results: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '获取稳定结果失败: ' + error.message
    });
  }
});

// 保存新的稳定结果
app.post('/api/stable-results', (req, res) => {
  try {
    const newResult = req.body;
    
    // 验证必需字段
    const requiredFields = ['stationId', 'ecef_x', 'ecef_y', 'ecef_z', 'lat', 'lon', 'height'];
    const missingFields = requiredFields.filter(field => !newResult[field]);
    
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `缺少必需字段: ${missingFields.join(', ')}`
      });
    }
    
    // 读取现有结果
    const results = readStableResults();
    
    // 去重检查：检查是否已存在相同站点在最近60秒内的记录
    const now = Date.now();
    const duplicateThreshold = 60000; // 60秒内认为是重复
    
    const isDuplicate = results.some(existing => {
      if (existing.stationId !== newResult.stationId) {
        return false;
      }
      
      // 检查时间差
      const existingTime = new Date(existing.timestamp).getTime();
      const timeDiff = Math.abs(now - existingTime);
      
      if (timeDiff < duplicateThreshold) {
        log('warn', `Duplicate stable result detected for station ${newResult.stationId} (time diff: ${(timeDiff/1000).toFixed(1)}s), skipping save`);
        return true;
      }
      return false;
    });
    
    if (isDuplicate) {
      return res.json({
        success: true,
        message: '稳定结果已存在（跳过重复保存）',
        duplicate: true
      });
    }
    
    // 添加ID和时间戳
    newResult.id = `${newResult.stationId}_${Date.now()}`;
    if (!newResult.timestamp) {
      newResult.timestamp = new Date().toISOString();
    }
    
    // 添加到列表
    results.unshift(newResult); // 新记录在最前面
    
    // 保存
    if (writeStableResults(results)) {
      log('info', `Saved stable result for station ${newResult.stationId}`);
      res.json({
        success: true,
        message: '稳定结果已保存',
        id: newResult.id
      });
    } else {
      res.status(500).json({
        success: false,
        message: '保存失败'
      });
    }
  } catch (error) {
    log('error', `Error saving stable result: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '保存稳定结果失败: ' + error.message
    });
  }
});

// 删除稳定结果
app.delete('/api/stable-results/:id', (req, res) => {
  try {
    const id = req.params.id;
    
    // 读取现有结果
    let results = readStableResults();
    
    // 查找并删除
    const initialLength = results.length;
    results = results.filter(r => r.id !== id);
    
    if (results.length === initialLength) {
      return res.status(404).json({
        success: false,
        message: '未找到该记录'
      });
    }
    
    // 保存
    if (writeStableResults(results)) {
      log('info', `Deleted stable result: ${id}`);
      res.json({
        success: true,
        message: '记录已删除'
      });
    } else {
      res.status(500).json({
        success: false,
        message: '删除失败'
      });
    }
  } catch (error) {
    log('error', `Error deleting stable result: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '删除失败: ' + error.message
    });
  }
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    platform: process.platform,
    templatePath: config.templatePath,
    generatedDir: config.generatedDir,
    rtkcrvPath: config.rtkcrvPath,
    rtkcrvWorkDir: config.rtkcrvWorkDir,
    rtkcrvExists: fs.existsSync(config.rtkcrvPath),
    runningProcesses: runningProcesses.size,
    tcpServer: tcpServer ? 'running' : 'stopped',
    tcpClients: tcpClients.size,
    sseClients: sseClients.size,
    activeStations: latestData.size,
    ecefCacheSize: ecefCache.size,
    stableResults: readStableResults().length
  });
});

// SSE 端点 - 实时推送 RTKRCV 数据
app.get('/api/rtkrcv/stream', (req, res) => {
  // 设置 SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  
  // 生成客户端 ID
  const clientId = `sse_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  sseClients.set(clientId, res);
  
  log('info', `SSE client connected: ${clientId}`);
  
  // 发送初始消息
  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);
  
  // 发送最新数据
  latestData.forEach((data, stationId) => {
    res.write(`data: ${JSON.stringify({ type: 'rtkrcv_data', data })}\n\n`);
  });
  
  // 客户端断开连接处理
  req.on('close', () => {
    log('info', `SSE client disconnected: ${clientId}`);
    sseClients.delete(clientId);
  });
});

// 获取所有站点的最新数据
app.get('/api/rtkrcv/latest', (req, res) => {
  try {
    const stations = [];
    latestData.forEach((data, stationId) => {
      stations.push(data);
    });
    
    res.json({
      success: true,
      count: stations.length,
      stations: stations
    });
  } catch (error) {
    log('error', `Error getting latest data: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '获取最新数据失败: ' + error.message
    });
  }
});

// 获取指定站点的最新数据
app.get('/api/rtkrcv/latest/:stationId', (req, res) => {
  try {
    const stationId = req.params.stationId;
    const data = latestData.get(stationId);
    
    if (!data) {
      return res.status(404).json({
        success: false,
        message: '未找到该站点数据'
      });
    }
    
    res.json({
      success: true,
      data: data
    });
  } catch (error) {
    log('error', `Error getting station data: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '获取站点数据失败: ' + error.message
    });
  }
});

// 获取站点稳定性信息
app.get('/api/rtkrcv/stability', (req, res) => {
  try {
    const stabilityInfo = [];
    
    stationStability.forEach((stability, stationId) => {
      const info = {
        stationId: stationId,
        status: stability.status,
        startTime: stability.startTime.toISOString(),
        sampleCount: stability.samples.length
      };
      
      if (stability.status === 'collecting') {
        const elapsed = stability.accumulatedFixedSeconds || ((Date.now() - stability.startTime.getTime()) / 1000);
        const required = config.stabilityRequiredSeconds;
        info.elapsed = elapsed.toFixed(1);
        info.remaining = Math.max(0, required - elapsed).toFixed(1);
        info.progress = Math.min(100, (elapsed / required) * 100).toFixed(1);
      } else if (stability.status === 'stable') {
        info.endTime = stability.endTime.toISOString();
        info.average = stability.average;
      }
      
      stabilityInfo.push(info);
    });
    
    res.json({
      success: true,
      stations: stabilityInfo
    });
  } catch (error) {
    log('error', `Error getting stability info: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '获取稳定性信息失败: ' + error.message
    });
  }
});

// 重置站点稳定性（重新开始收集）
app.post('/api/rtkrcv/stability/reset/:stationId', (req, res) => {
  try {
    const stationId = req.params.stationId;
    
    if (stationStability.has(stationId)) {
      stationStability.delete(stationId);
      log('info', `🔄 Station ${stationId}: 稳定性已重置`);
      
      res.json({
        success: true,
        message: `站点 ${stationId} 稳定性已重置，将重新开始收集`
      });
    } else {
      res.status(404).json({
        success: false,
        message: '该站点没有稳定性数据'
      });
    }
  } catch (error) {
    log('error', `Error resetting stability: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '重置失败: ' + error.message
    });
  }
});

// 清理站点缓存（防止已清除的卡片重新出现）
app.post('/api/rtkrcv/clear-cache/:stationId', (req, res) => {
  try {
    const stationId = req.params.stationId;
    
    // 清理相关缓存
    let cleared = [];
    
    if (latestData.has(stationId)) {
      latestData.delete(stationId);
      cleared.push('latestData');
    }
    
    if (stationStability.has(stationId)) {
      stationStability.delete(stationId);
      cleared.push('stationStability');
    }
    
    if (ecefCache.has(stationId)) {
      ecefCache.delete(stationId);
      cleared.push('ecefCache');
    }
    
    if (cleared.length > 0) {
      log('info', `🗑️ Cleared cache for station ${stationId}: ${cleared.join(', ')}`);
      res.json({
        success: true,
        message: `站点 ${stationId} 缓存已清理`,
        cleared: cleared
      });
    } else {
      res.json({
        success: true,
        message: `站点 ${stationId} 无需清理缓存`
      });
    }
  } catch (error) {
    log('error', `Error clearing cache: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '清理缓存失败: ' + error.message
    });
  }
});

// 调试端点 - 查看 TCP 连接和数据统计
app.get('/api/debug/tcp', (req, res) => {
  try {
    const clients = [];
    tcpClients.forEach((socket, id) => {
      clients.push({
        id: id,
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
        bytesRead: socket.bytesRead,
        bytesWritten: socket.bytesWritten
      });
    });
    
    const ecefCacheInfo = [];
    ecefCache.forEach((value, stationId) => {
      ecefCacheInfo.push({
        stationId: stationId,
        age: Math.floor((Date.now() - value.timestamp) / 1000),
        preview: value.line.substring(0, 80)
      });
    });
    
    const stabilityInfo = [];
    stationStability.forEach((stability, stationId) => {
      stabilityInfo.push({
        stationId: stationId,
        status: stability.status,
        sampleCount: stability.samples.length,
        elapsed: ((Date.now() - stability.startTime.getTime()) / 1000).toFixed(1)
      });
    });
    
    res.json({
      success: true,
      tcpServer: {
        running: tcpServer !== null,
        port: 60000,
        clients: clients.length
      },
      clients: clients,
      sseClients: sseClients.size,
      cachedStations: Array.from(latestData.keys()),
      ecefCache: ecefCacheInfo,
      stability: stabilityInfo,
      statistics: {
        totalStations: latestData.size,
        pendingEcef: ecefCache.size,
        collecting: stabilityInfo.filter(s => s.status === 'collecting').length,
        stable: stabilityInfo.filter(s => s.status === 'stable').length
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 启动 RTKRCV 进程
app.post('/api/rtkrcv/start', (req, res) => {
  try {
    const { configFile } = req.body;
    
    if (!configFile) {
      return res.status(400).json({
        success: false,
        message: '请提供配置文件名'
      });
    }
    
    // 检查配置文件是否存在
    const configPath = path.join(config.generatedDir, configFile);
    if (!fs.existsSync(configPath)) {
      return res.status(404).json({
        success: false,
        message: '配置文件不存在'
      });
    }
    
    // 检查是否已经在运行
    if (runningProcesses.has(configFile)) {
      return res.status(400).json({
        success: false,
        message: '该配置的 RTKRCV 已在运行中'
      });
    }
    
    // 启动 RTKRCV 进程
    const rtkcrvPath = config.rtkcrvPath;
    
    // 如果是 Linux 且 rtkrcv 不在指定路径，尝试从系统 PATH 查找
    const rtkcrvExePath = fs.existsSync(rtkcrvPath) ? rtkcrvPath : (
      process.platform === 'win32' ? 'rtkrcv.exe' : 'rtkrcv'
    );
    
    log('info', `Using RTKRCV executable: ${rtkcrvExePath}`);
    log('info', `Working directory: ${config.rtkcrvWorkDir}`);
    
    // 无控制台方式启动
    // -nc: 无控制台模式启动
    // -o: 指定配置文件路径（使用相对路径，因为已设置工作目录）
    const childProcess = spawn(rtkcrvExePath, ['-nc', '-o', configFile], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'], // 忽略 stdin，捕获 stdout 和 stderr
      cwd: config.rtkcrvWorkDir, // 设置工作目录
      windowsHide: true // Windows 下隐藏控制台窗口
    });
    // 降低子进程优先级，减少CPU争用
    applyChildPriority(childProcess);
    
    const pid = childProcess.pid;
    const startTime = new Date();
    
    // 创建日志文件
    const logFileName = configFile.replace('.conf', '.log');
    const logPath = path.join(config.generatedDir, logFileName);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    
    // 记录启动信息
    logStream.write(`\n========== RTKRCV 启动 ==========\n`);
    logStream.write(`时间: ${startTime.toISOString()}\n`);
    logStream.write(`配置文件: ${configFile}\n`);
    logStream.write(`进程 PID: ${pid}\n`);
    logStream.write(`================================\n\n`);
    
    // 捕获输出到日志文件
    childProcess.stdout.on('data', (data) => {
      logStream.write(data);
    });
    
    childProcess.stderr.on('data', (data) => {
      logStream.write(`[ERROR] ${data}`);
    });
    
    // 进程退出处理
    childProcess.on('exit', (code, signal) => {
      const exitTime = new Date();
      logStream.write(`\n========== RTKRCV 退出 ==========\n`);
      logStream.write(`时间: ${exitTime.toISOString()}\n`);
      logStream.write(`退出码: ${code}\n`);
      logStream.write(`信号: ${signal}\n`);
      logStream.write(`================================\n\n`);
      logStream.end();
      
      runningProcesses.delete(configFile);
      log('info', `RTKRCV process exited: ${configFile} (PID: ${pid}, Code: ${code})`);
    // 调度器回调（根据配置文件名推导 stationId）
    try {
      const stationId = String(configFile).replace(/\.conf$/i, '');
      batchSchedulerOnProcessExit(stationId);
    } catch (e) {}
    });
    
    childProcess.on('error', (error) => {
      logStream.write(`\n[FATAL ERROR] ${error.message}\n`);
      logStream.end();
      
      runningProcesses.delete(configFile);
      log('error', `RTKRCV process error: ${configFile} - ${error.message}`);
    });
    
    // 保存进程信息（包含日志流引用）
    runningProcesses.set(configFile, {
      process: childProcess,
      pid: pid,
      startTime: startTime,
      configFile: configFile,
      logFile: logFileName,
      logStream: logStream  // 保存日志流引用，用于写入TCP数据
    });
    
    log('info', `Started RTKRCV: ${configFile} (PID: ${pid})`);
    
    res.json({
      success: true,
      message: `RTKRCV 已启动 (PID: ${pid})`,
      pid: pid,
      configFile: configFile,
      logFile: logFileName
    });
    
  } catch (error) {
    log('error', `Error starting RTKRCV: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '启动 RTKRCV 失败: ' + error.message
    });
  }
});

// 停止 RTKRCV 进程
app.post('/api/rtkrcv/stop', (req, res) => {
  try {
    const { configFile } = req.body;
    
    if (!configFile) {
      return res.status(400).json({
        success: false,
        message: '请提供配置文件名'
      });
    }
    
    const processInfo = runningProcesses.get(configFile);
    
    if (!processInfo) {
      return res.status(404).json({
        success: false,
        message: '该配置的 RTKRCV 未在运行'
      });
    }
    
    // 提取站点ID（从配置文件名）
    const stationId = configFile.replace('.conf', '');
    
    // 终止进程
    processInfo.process.kill();
    
    log('info', `🛑 Manually stopped RTKRCV: ${configFile} (PID: ${processInfo.pid})`);

    // 若存在批量调度，立即从调度器的running中移除并补位（exit回调也会再次尝试，但不会重复，因为此处已删除）
    try {
      if (batchScheduler && batchScheduler.active && batchScheduler.running && batchScheduler.running.has(stationId)) {
        batchScheduler.running.delete(stationId);
        batchSchedulerFillSlots(null);
        log('info', `Batch scheduler: freed slot by manual stop of station ${stationId}, filling next from queue`);
      }
    } catch (e) {
      log('warn', `Batch scheduler update on manual stop failed: ${e.message}`);
    }
    
    // 推送停止通知到前端（让前端清除卡片和缓存）
    broadcastToSSE({
      type: 'rtkrcv_manual_stopped',
      data: {
        stationId: stationId,
        configFile: configFile,
        reason: 'manual',
        message: `站点 ${stationId} 的 RTKRCV 已手动停止`
      }
    });
    
    // 清理后端缓存，避免已停止站点继续占用监控页面与内存
    try { latestData.delete(stationId); } catch (e) {}
    try { stationStability.delete(stationId); } catch (e) {}
    try { ecefCache.delete(stationId); } catch (e) {}
    try { sseLastSent.delete(stationId); } catch (e) {}
    
    res.json({
      success: true,
      message: 'RTKRCV 已停止',
      pid: processInfo.pid
    });
    
  } catch (error) {
    log('error', `Error stopping RTKRCV: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '停止 RTKRCV 失败: ' + error.message
    });
  }
});

// 获取所有运行中的进程状态
app.get('/api/rtkrcv/status', (req, res) => {
  try {
    const processes = [];
    
    runningProcesses.forEach((info, configFile) => {
      processes.push({
        configFile: configFile,
        pid: info.pid,
        startTime: info.startTime,
        uptime: Math.floor((Date.now() - info.startTime.getTime()) / 1000), // 秒
        logFile: info.logFile
      });
    });
    
    res.json({
      success: true,
      processes: processes,
      count: processes.length
    });
    
  } catch (error) {
    log('error', `Error getting RTKRCV status: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '获取状态失败: ' + error.message
    });
  }
});

// 获取单个进程状态
app.get('/api/rtkrcv/status/:configFile', (req, res) => {
  try {
    const configFile = req.params.configFile;
    const processInfo = runningProcesses.get(configFile);
    
    if (!processInfo) {
      return res.json({
        success: true,
        running: false,
        configFile: configFile
      });
    }
    
    res.json({
      success: true,
      running: true,
      configFile: configFile,
      pid: processInfo.pid,
      startTime: processInfo.startTime,
      uptime: Math.floor((Date.now() - processInfo.startTime.getTime()) / 1000),
      logFile: processInfo.logFile
    });
    
  } catch (error) {
    log('error', `Error getting RTKRCV status: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '获取状态失败: ' + error.message
    });
  }
});

// 轮次状态查询
app.get('/api/round/state', (req, res) => {
  try {
    const now = Date.now();
    const enabled = !!roundManager.enabled;
    const state = {
      enabled,
      currentRound: enabled ? (roundManager.currentRound || 0) : (batchScheduler.active ? 1 : 0),
      totalRounds: enabled ? (roundManager.totalRounds || 0) : (batchScheduler.active ? 1 : 0),
      intervalMs: enabled ? (roundManager.intervalMs || 0) : 0,
      nextRoundAt: enabled ? (roundManager.nextRoundAt || 0) : 0,
      waiting: enabled ? (roundManager.nextRoundAt > now) : false,
      batchActive: !!batchScheduler.active,
      running: batchScheduler.running ? batchScheduler.running.size : 0,
      pending: batchScheduler.pending ? batchScheduler.pending.length : 0
    };
    res.json({ success: true, state });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 查看日志
app.get('/api/rtkrcv/log/:logFile', (req, res) => {
  try {
    const logFile = req.params.logFile;
    const logPath = path.join(config.generatedDir, logFile);
    
    if (!fs.existsSync(logPath)) {
      return res.status(404).json({
        success: false,
        message: '日志文件不存在'
      });
    }
    
    // 读取日志文件（最后 1000 行）
    const logContent = fs.readFileSync(logPath, 'utf-8');
    const lines = logContent.split('\n');
    const lastLines = lines.slice(-1000).join('\n');
    
    res.json({
      success: true,
      logFile: logFile,
      content: lastLines,
      totalLines: lines.length
    });
    
  } catch (error) {
    log('error', `Error reading log: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '读取日志失败: ' + error.message
    });
  }
});

// 预览配置文件内容
app.get('/api/config/content/:filename', (req, res) => {
  try {
    const fileName = req.params.filename;
    const filePath = path.join(config.generatedDir, fileName);

    // 基本校验
    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      return res.status(400).json({
        success: false,
        message: '非法的文件名'
      });
    }
    if (!fileName.toLowerCase().endsWith('.conf')) {
      return res.status(400).json({
        success: false,
        message: '只能预览 .conf 文件'
      });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: '配置文件不存在'
      });
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({
      success: true,
      fileName: fileName,
      content: content
    });
  } catch (error) {
    log('error', `Error reading config content: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '读取配置内容失败: ' + error.message
    });
  }
});

// 初始化并启动服务器
function startServer() {
  try {
    // 确保必要的目录存在
    ensureDirectories();
    
    // 启动时尝试恢复多轮调度状态（若存在）
    resumeRoundsIfNeeded();
    
    // 启动 TCP 服务器监听 RTKRCV 输出
    startTcpServer();
    
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
process.on('SIGTERM', () => {
  log('info', 'SIGTERM received, shutting down gracefully');
  
  // 关闭 TCP 服务器
  if (tcpServer) {
    tcpServer.close(() => {
      log('info', 'TCP server closed');
    });
  }
  
  // 关闭所有 TCP 客户端
  tcpClients.forEach((client) => client.end());
  
  // 关闭所有 SSE 客户端
  sseClients.forEach((client) => client.end());
  
  process.exit(0);
});

process.on('SIGINT', () => {
  log('info', 'SIGINT received, shutting down gracefully');
  
  // 关闭 TCP 服务器
  if (tcpServer) {
    tcpServer.close(() => {
      log('info', 'TCP server closed');
    });
  }
  
  // 关闭所有 TCP 客户端
  tcpClients.forEach((client) => client.end());
  
  // 关闭所有 SSE 客户端
  sseClients.forEach((client) => client.end());
  
  process.exit(0);
});

startServer();

