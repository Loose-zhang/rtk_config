// HTTP API 路由
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const config = require('../config');
const { log } = require('./logger');
const state = require('./state');
const {
  runningProcesses, tcp, tcpClients, sseClients,
  latestData, ecefCache, stationStability,
  batchScheduler, roundManager, clearStationCaches
} = state;
const store = require('./store');
const {
  ensureDirectories, readStableResults, writeStableResults,
  readFailedResults, writeFailedResults, readTemplate,
  ensureTrailingSlash, generateConfigFile, parseStationsTxt
} = store;
const scheduler = require('./scheduler');
const { broadcastToSSE } = require('./sse');
const rtkrcv = require('./rtkrcv');

function registerRoutes(app) {

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
      scheduler.batchSchedulerFillSlots(startedNow);
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
      scheduler.disableRounds();

      // 关闭调度器并清空队列
      batchScheduler.active = false;
      batchScheduler.pending = [];
      batchScheduler.options = null;
      batchScheduler.cooldownUntil = 0;
      // 不清空历史失败：保留给用户查询

      // 处理运行中的站点：无论是否停止进程，都必须清除30分钟超时定时器并清空调度记录，
      // 否则旧定时器可能在新批次运行相同站点时误杀新进程
      batchScheduler.running.forEach((meta, stationId) => {
        try {
          if (meta && meta.timeoutTimer) clearTimeout(meta.timeoutTimer);
        } catch (e) {}
        if (stopRunning) {
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
              clearStationCaches(stationId);
              // SIGTERM + 超时 SIGKILL 兜底，避免拒绝退出的进程残留
              rtkrcv.killProcessWithTimeout(configFile);
              stopped.push(stationId);
            }
          } catch (e) {
            stopErrors.push({ stationId, error: e.message || String(e) });
          }
        }
      });
      batchScheduler.running = new Map();

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
        // 修复：失败记录是对象，需按 stationId 构建集合（原实现 Set(对象) 永远匹配不到）
        const failSet = new Set(failures.map(f => (f && typeof f === 'object') ? f.stationId : String(f)));
        const remaining = original.filter(x => !successSet.has(x.stationId) && !failSet.has(x.stationId));
        // 写文本列表
        const mkTxt = (arr) => arr.map(x => typeof x === 'string' ? x : `${x.stationId}${x.outHeight !== undefined ? ' ' + x.outHeight : ''}`).join('\n');
        fs.writeFileSync(path.join(config.generatedDir, 'last_success.txt'), mkTxt(successes), 'utf-8');
        fs.writeFileSync(path.join(config.generatedDir, 'last_failed.txt'), mkTxt(failures.map(f => (f && typeof f === 'object') ? f.stationId : String(f))), 'utf-8');
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
        const resolved = path.isAbsolute(txtPath) ? txtPath : path.join(config.projectRoot, txtPath);
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
        // 修复：失败记录是对象数组，需按 stationId 构建集合（原实现 skipFailed 永远不生效）
        const failed = skipFailed
          ? new Set(readFailedResults().map(f => (f && typeof f === 'object') ? f.stationId : String(f)))
          : new Set();
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
        store.writeJsonAtomic(lastBatchMetaFile, meta);
        log('info', `Saved last batch meta: ${lastBatchMetaFile} (${originalList.length} stations)`);
        // 同时将本轮原始列表保存为文本（stationId outHeight）
        const originalTxt = originalList.map(x => `${x.stationId} ${x.outHeight}`).join('\n');
        fs.writeFileSync(path.join(config.generatedDir, 'last_batch_original.txt'), originalTxt, 'utf-8');

        // 初始化轮次管理（若请求指定 rounds >= 2 则启用）
        const roundsInt = parseInt(rounds, 10);
        const intervalMinInt = parseInt(roundIntervalMinutes, 10);
        if (!Number.isNaN(roundsInt) && roundsInt >= 2) {
          scheduler.clearRoundTimer();
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
          scheduler.writeRoundState();
          log('info', `Round manager enabled: rounds=${roundManager.totalRounds}, intervalMinutes=${Math.round(roundManager.intervalMs / 60000)}`);
        } else {
          // 未启用多轮时，关闭轮次管理
          scheduler.disableRounds();
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
        scheduler.batchSchedulerFillSlots(startedNow);
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

            const startInfo = rtkrcv.startRtkrcvInternal(fileName);

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
          log('warn', `Duplicate stable result detected for station ${newResult.stationId} (time diff: ${(timeDiff / 1000).toFixed(1)}s), skipping save`);
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
      tcpServer: tcp.server ? 'running' : 'stopped',
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
          running: tcp.server !== null,
          port: config.tcpPort || 60000,
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

      // 启动 RTKRCV 进程（统一使用内部启动逻辑，含日志轮转与退出回调）
      const startInfo = rtkrcv.startRtkrcvInternal(configFile);

      res.json({
        success: true,
        message: `RTKRCV 已启动 (PID: ${startInfo.pid})`,
        pid: startInfo.pid,
        configFile: configFile,
        logFile: startInfo.logFileName
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

      // 终止进程（SIGTERM，超时未退出会被 SIGKILL 强杀）
      rtkrcv.killProcessWithTimeout(configFile);

      log('info', `🛑 Manually stopped RTKRCV: ${configFile} (PID: ${processInfo.pid})`);

      // 若存在批量调度：立即清除超时定时器并从 running 中移除（手动停止不计成败），
      // 但不在此补位——kill() 只是发信号，补位由进程真实 exit 事件驱动（避免并发短时超限）
      try {
        if (batchScheduler && batchScheduler.active && batchScheduler.running && batchScheduler.running.has(stationId)) {
          const meta = batchScheduler.running.get(stationId);
          if (meta && meta.timeoutTimer) clearTimeout(meta.timeoutTimer);
          batchScheduler.running.delete(stationId);
          log('info', `Batch scheduler: freed slot by manual stop of station ${stationId} (fill deferred until process exit)`);
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
      clearStationCaches(stationId);

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
      const roundState = {
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
      res.json({ success: true, state: roundState });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 查看日志（A5：异步读取，避免大日志阻塞事件循环）
  app.get('/api/rtkrcv/log/:logFile', async (req, res) => {
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
      const logContent = await fsp.readFile(logPath, 'utf-8');
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
}

module.exports = { registerRoutes };
