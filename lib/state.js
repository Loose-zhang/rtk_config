// 共享运行时状态（内存）
// 集中存放所有跨模块共享的 Map/对象，避免模块间循环依赖。

// 运行中的 RTKRCV 进程
// Map<configFileName, { process, pid, startTime, configFile, logFile, logStream }>
const runningProcesses = new Map();

// TCP 服务器与连接
const tcp = { server: null };
const tcpClients = new Map();

// SSE 客户端与限频记录
const sseClients = new Map();
const sseLastSent = new Map();

// 最新的 RTKRCV 数据缓存 Map<stationId, parsedData>
const latestData = new Map();

// ECEF 行缓存（等待配对 LLH 行） Map<stationId, { line, timestamp }>
const ecefCache = new Map();

// 站点稳定性跟踪 Map<stationId, { status, startTime, samples, average, ... }>
const stationStability = new Map();

// 批量调度器（限制并发）
const batchScheduler = {
  active: false,
  concurrency: 5,
  pending: [],
  // 运行中的站点：Map<stationId, { startMs:number, timeoutTimer:NodeJS.Timeout }>
  running: new Map(),
  options: null, // { inpstr1Base, inpstr2, inpstr3 }
  successCount: 0,
  failCount: 0,
  completedCount: 0,
  failures: [],
  successes: [],
  originalList: [],
  cooldownUntil: 0
};

// 轮次管理（多轮计算与持久化恢复）
const roundManager = {
  enabled: false,
  totalRounds: 0,
  currentRound: 0,
  intervalMs: 0,
  nextRoundTimer: null,
  nextRoundAt: 0,
  seedOriginalList: [],
  lastRoundSuccesses: [],
  options: null,
  currentList: []
};

// 清理指定站点的所有内存缓存
function clearStationCaches(stationId) {
  try { latestData.delete(stationId); } catch (e) {}
  try { stationStability.delete(stationId); } catch (e) {}
  try { ecefCache.delete(stationId); } catch (e) {}
  try { sseLastSent.delete(stationId); } catch (e) {}
}

// 周期性清理长期无活动的站点缓存，防止长跑内存增长（A6）
// 规则：站点无对应运行进程，且最近活动时间超过 maxIdleMs，则清除其缓存条目。
let sweeperTimer = null;
function startCacheSweeper({ intervalMs = 10 * 60 * 1000, maxIdleMs = 60 * 60 * 1000, log = () => {} } = {}) {
  if (sweeperTimer) return;
  sweeperTimer = setInterval(() => {
    try {
      const now = Date.now();
      const idleIds = new Set();

      latestData.forEach((data, stationId) => {
        const t = data && data.timestamp ? new Date(data.timestamp).getTime() : 0;
        if (now - t > maxIdleMs) idleIds.add(stationId);
      });
      stationStability.forEach((st, stationId) => {
        const t = st && st.lastSampleTimeMs ? st.lastSampleTimeMs : 0;
        if (now - t > maxIdleMs) idleIds.add(stationId);
      });
      sseLastSent.forEach((t, stationId) => {
        if (now - t > maxIdleMs) idleIds.add(stationId);
      });

      let cleared = 0;
      idleIds.forEach((stationId) => {
        // 有进程在跑的站点不清理
        if (runningProcesses.has(`${stationId}.conf`)) return;
        clearStationCaches(stationId);
        cleared += 1;
      });
      if (cleared > 0) {
        log('info', `Cache sweeper: cleared ${cleared} idle station cache entries`);
      }
    } catch (e) {
      log('warn', `Cache sweeper error: ${e.message}`);
    }
  }, intervalMs);
  // 不阻止进程退出
  if (sweeperTimer.unref) sweeperTimer.unref();
}

module.exports = {
  runningProcesses,
  tcp,
  tcpClients,
  sseClients,
  sseLastSent,
  latestData,
  ecefCache,
  stationStability,
  batchScheduler,
  roundManager,
  clearStationCaches,
  startCacheSweeper
};
