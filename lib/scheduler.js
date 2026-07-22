// 批量调度器与多轮管理
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { log } = require('./logger');
const state = require('./state');
const { batchScheduler, roundManager, runningProcesses, clearStationCaches } = state;
const store = require('./store');
const { ensureDirectories, ensureTrailingSlash, generateConfigFile, readFailedResults, writeFailedResults } = store;
const { broadcastToSSE } = require('./sse');
const rtkrcv = require('./rtkrcv');

// ---------- 轮次状态持久化 ----------

function roundStateFilePath() {
  return path.join(config.generatedDir, 'round_state.json');
}

function writeRoundState() {
  try {
    ensureDirectories();
    const file = roundStateFilePath();
    const stateObj = {
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
    store.writeJsonAtomic(file, stateObj);
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
  roundManager.currentList = [];
  writeRoundState();
  log('info', 'Round manager disabled.');
}

function listFromSuccesses(successIds, originalList) {
  const originalMap = new Map(originalList.map(x => [String(x.stationId), x]));
  return (successIds || []).map(id => originalMap.get(String(id))).filter(Boolean);
}

// ---------- 批量调度 ----------

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
    store.writeJsonAtomic(lastBatchMetaFile, meta);
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
  log('info', `Scheduled next round ${roundManager.currentRound + 1} in ${Math.round(delay / 60000)} minutes.`);
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
        stationIds.forEach((sid) => clearStationCaches(sid));
      } catch (_) {}

      broadcastToSSE({
        type: 'round_completed',
        data: {
          round,
          totalRounds,
          stationIds,
          successIds,
          failIds,
          stableResultsCleared: false,
          finishedAt: new Date().toISOString()
        }
      });
    } catch (e) {
      log('warn', `Broadcast round_completed failed: ${e.message}`);
    }

    // stable_results.json 是数据库写入失败时的持久兜底副本，不得在轮次完成后清空。
    // 数据库恢复后由启动同步与读取接口将缺失记录补写回库。

    // 更新轮次管理状态
    if (roundManager.enabled) {
      roundManager.lastRoundSuccesses = Array.isArray(batchScheduler.successes) ? batchScheduler.successes.slice() : [];
      // 本轮已完成：清空 currentList，否则服务重启恢复时会把已完成的这一轮重新执行一遍
      roundManager.currentList = [];
      writeRoundState();
      scheduleNextRoundIfNeeded();
    }
  } catch (e) {
    log('warn', `onBatchCompleted error: ${e.message}`);
  }
}

function resumeRoundsIfNeeded() {
  try {
    const savedState = readRoundState();
    if (!savedState || !savedState.enabled) return;
    // 恢复内存状态
    roundManager.enabled = !!savedState.enabled;
    roundManager.totalRounds = savedState.totalRounds || 0;
    roundManager.currentRound = savedState.currentRound || 0;
    roundManager.intervalMs = savedState.intervalMs || 20 * 60 * 1000;
    roundManager.nextRoundAt = savedState.nextRoundAt || 0;
    roundManager.options = savedState.options || null;
    roundManager.seedOriginalList = Array.isArray(savedState.seedOriginalList) ? savedState.seedOriginalList : [];
    roundManager.lastRoundSuccesses = Array.isArray(savedState.lastRoundSuccesses) ? savedState.lastRoundSuccesses : [];
    roundManager.currentList = Array.isArray(savedState.currentList) ? savedState.currentList : [];

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
        log('info', `Resuming scheduled next round in ${Math.round(delay / 60000)} minutes...`);
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
    // B3修复：若该站点已被标记成功，后续的失败标记（超时/进程退出回调）一律忽略，
    // 避免"已成功却被误记失败"的情况
    if (!success && batchScheduler.successes.includes(stationId)) {
      log('info', `Batch scheduler: ignore late failure mark for already-succeeded station ${stationId}`);
      return;
    }
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

// B3修复：站点达到稳定时直接标记成功（不再依赖 stop 时进程仍然存活）。
// 注意：这里只标记成功、不立即补位——补位统一由进程真实 exit 事件驱动
//（见 batchSchedulerOnProcessExit），否则旧进程未退出时新站已启动，会突破并发上限。
function markStationSuccess(stationId) {
  try {
    if (batchScheduler.active && batchScheduler.running && batchScheduler.running.has(stationId)) {
      batchMarkComplete(stationId, true);
      log('info', `Batch scheduler: success completed ${stationId} (slot fill deferred until process stop)`);
    }
  } catch (e) {
    log('warn', `markStationSuccess failed for ${stationId}: ${e.message}`);
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
      const startInfo = rtkrcv.startRtkrcvInternal(fileName);
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
              clearStationCaches(stationId);
              // 发送停止信号（超时未退出会被 SIGKILL），补位由 exit 事件驱动
              rtkrcv.killProcessWithTimeout(configFile);
            }
            // 统计失败；若进程已不存在（无 exit 事件），立即补位
            batchMarkComplete(stationId, false);
            if (!proc) {
              batchSchedulerFillSlots(null);
            }
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
    // 未明确标记成功/失败时，按失败处理（通常 stable 时会先标记成功）
    batchMarkComplete(stationId, false);
  }
  // 补位统一由真实 exit 事件驱动（含已标记成功的站点——其槽位此时才真正空出），
  // 保证任何时刻实际进程数不超过并发上限
  batchSchedulerFillSlots(null);
}

// 根据站点 ID 停止 RTKRCV 进程（站点达到稳定后自动调用）
function stopRtkcrvByStationId(stationId) {
  // B3修复：无论进程是否仍然存活，先标记批量成功，
  // 避免进程已退出时成功标记丢失、30分钟超时后被误记失败
  markStationSuccess(stationId);

  // 查找包含该站点 ID 的配置文件
  const configFile = `${stationId}.conf`;
  const processInfo = runningProcesses.get(configFile);
  let stopped = false;

  if (processInfo) {
    try {
      // 发送停止信号（超时未退出会被 SIGKILL），此处不补位——
      // kill() 只是发信号，进程可能尚未退出；补位由 exit 事件回调驱动
      rtkrcv.killProcessWithTimeout(configFile);
      log('info', `🛑 Station ${stationId}: 已达到稳定，自动关闭 RTKRCV (PID: ${processInfo.pid})`);

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
      clearStationCaches(stationId);
      stopped = true;
    } catch (error) {
      log('error', `Error stopping RTKRCV for station ${stationId}: ${error.message}`);
    }
  } else {
    log('warn', `Cannot stop RTKRCV for station ${stationId}: process not found (config: ${configFile})`);
    // 进程已不在，同样清理缓存；不会有 exit 事件，需在此立即补位
    clearStationCaches(stationId);
    try {
      batchSchedulerFillSlots(null);
    } catch (e) {
      log('warn', `Fill slots after stop failed: ${e.message}`);
    }
  }

  return stopped;
}

// 初始化：注册进程退出回调（B3修复）
function init() {
  rtkrcv.onProcessExit(batchSchedulerOnProcessExit);
}

module.exports = {
  roundStateFilePath,
  writeRoundState,
  readRoundState,
  clearRoundTimer,
  disableRounds,
  listFromSuccesses,
  startBatchFromList,
  scheduleNextRoundIfNeeded,
  onBatchCompleted,
  resumeRoundsIfNeeded,
  isInCooldown,
  scheduleCooldownIfNeeded,
  batchMarkComplete,
  markStationSuccess,
  batchSchedulerFillSlots,
  batchSchedulerOnProcessExit,
  stopRtkcrvByStationId,
  init
};
