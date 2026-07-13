// 站点稳定性判定与稳定结果自动保存
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { log } = require('./logger');
const { stationStability } = require('./state');
const { calculateAverage } = require('./stats');
const { readStableResults, writeStableResults, ensureDirectories } = require('./store');
const { dbInsertStableResult } = require('./db');
const { broadcastToSSE } = require('./sse');
const scheduler = require('./scheduler');

// 检查并更新站点稳定性（容错版）
function checkStationStability(stationId, data) {
  const isFixed = data.quality.status === 1; // 1 = 固定解

  let stability = stationStability.get(stationId);

  // B3修复：已稳定的站点直接返回，不再继续累计/重置，
  // 防止稳定后 2 秒停止窗口内浮点样本触发重置并产生重复结果记录
  if (stability && stability.status === 'stable') {
    return { stable: true, average: stability.average };
  }

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
    const requiredSamples = Number.isFinite(config.stabilityRequiredSamples) ? Number(config.stabilityRequiredSamples) : 40;

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
          originalSampleCount: Number(average.originalSampleCount || average.sampleCount || 0),
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

      // B3修复：达到稳定即标记批量成功（不再等待 stop 时进程仍存活）
      try { scheduler.markStationSuccess(stationId); } catch (e) {}

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
        scheduler.stopRtkcrvByStationId(stationId);
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

module.exports = { checkStationStability };
