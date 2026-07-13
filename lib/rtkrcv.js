// RTKRCV 子进程管理：启动、日志（含轮转）、数据流日志
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config');
const { log } = require('./logger');
const { runningProcesses } = require('./state');
const { ensureDirectories, resolveGeneratedFile } = require('./store');

// 进程退出回调（由调度器注册，避免循环依赖）
let exitHandler = null;
function onProcessExit(cb) {
  exitHandler = cb;
}

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

// 日志轮转（B4）：超过上限时将旧日志重命名为 .log.1（覆盖上一份），防止无限增长
function rotateLogIfNeeded(logPath) {
  try {
    const maxBytes = (config.maxLogSizeMB || 20) * 1024 * 1024;
    if (fs.existsSync(logPath)) {
      const stats = fs.statSync(logPath);
      if (stats.size >= maxBytes) {
        const rotated = `${logPath}.1`;
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
        fs.renameSync(logPath, rotated);
        log('info', `Rotated log: ${path.basename(logPath)} -> ${path.basename(rotated)} (${(stats.size / 1048576).toFixed(1)}MB)`);
      }
    }
  } catch (e) {
    log('warn', `rotateLogIfNeeded failed for ${logPath}: ${e.message}`);
  }
}

// 启动 RTKRCV（内部复用版本）
// 注意：runningProcesses 始终以文件名（如 "6539840.conf"）为键，
// 实际文件位于设备文件夹 generated/<设备号>/ 下（兼容旧平铺布局）
function startRtkrcvInternal(configFile) {
  // 检查配置文件是否存在（设备文件夹优先，兼容旧平铺位置）
  const configPath = resolveGeneratedFile(configFile);
  if (!configPath) {
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
  // 配置文件参数使用相对工作目录的路径（如 "6539840/6539840.conf"）
  const configArg = path.relative(config.rtkcrvWorkDir, configPath) || configFile;
  log('info', `Using RTKRCV executable: ${rtkcrvExePath}`);
  log('info', `Working directory: ${config.rtkcrvWorkDir}, config: ${configArg}`);
  const childProcess = spawn(rtkcrvExePath, ['-nc', '-o', configArg], {
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
  // 日志与配置文件放在同一设备文件夹
  const logPath = path.join(path.dirname(configPath), logFileName);
  rotateLogIfNeeded(logPath);
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
    // 通知调度器（B3修复：批量启动的进程退出时也必须释放调度槽，
    // 否则进程自行崩溃/退出的站点会占用并发槽直到30分钟超时被误记失败）
    try {
      if (exitHandler) {
        const stationId = String(configFile).replace(/\.conf$/i, '');
        exitHandler(stationId);
      }
    } catch (e) {
      log('warn', `Process exit handler error: ${e.message}`);
    }
  });
  childProcess.on('error', (error) => {
    logStream.write(`\n[FATAL ERROR] ${error.message}\n`);
    logStream.end();
    runningProcesses.delete(configFile);
    log('error', `RTKRCV process error: ${configFile} - ${error.message}`);
    // spawn 失败（如可执行文件不存在）时 exit 事件可能不触发，
    // 必须在此通知调度器释放并发槽，否则站点会卡住直到30分钟超时。
    // 若 error 与 exit 都触发，第二次回调因 running 已删除而自动 no-op。
    try {
      if (exitHandler) {
        const stationId = String(configFile).replace(/\.conf$/i, '');
        exitHandler(stationId);
      }
    } catch (e) {
      log('warn', `Process error handler notify failed: ${e.message}`);
    }
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

// 停止进程：发送 SIGTERM，超时未退出则 SIGKILL 强杀，
// 防止拒绝退出的进程永久占用并发槽（补位由 exit 事件驱动）
function killProcessWithTimeout(configFile) {
  const info = runningProcesses.get(configFile);
  if (!info) return false;
  const graceMs = config.killGraceMs || 10000;
  try {
    info.process.kill();
  } catch (e) {
    log('warn', `SIGTERM failed for ${configFile}: ${e.message}`);
  }
  const timer = setTimeout(() => {
    const still = runningProcesses.get(configFile);
    if (still && still.process === info.process) {
      log('warn', `Process ${configFile} (PID: ${still.pid}) did not exit within ${graceMs}ms, sending SIGKILL`);
      try { still.process.kill('SIGKILL'); } catch (e) {
        log('error', `SIGKILL failed for ${configFile}: ${e.message}`);
      }
    }
  }, graceMs);
  if (timer.unref) timer.unref();
  return true;
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

    let logEntry = `\n[TCP数据流] ${parsedData.dateTime} - ${parsedData.quality.statusText} (${parsedData.quality.satellites}颗卫星)\n` +
                   `  ECEF: X=${parsedData.ecef.x} Y=${parsedData.ecef.y} Z=${parsedData.ecef.z}\n` +
                   `  LLH:  Lat=${parsedData.llh.lat}° Lon=${parsedData.llh.lon}° H=${parsedData.llh.height}m\n`;
    if (config.enableRawDataLog) {
      logEntry += `  原始数据:\n${rawData}\n`;
    }

    if (processInfo && processInfo.logStream) {
      processInfo.logStream.write(logEntry);
    } else {
      // 如果进程不存在，直接追加到日志文件（异步，避免阻塞 TCP 数据处理，A5）
      const logPath = resolveGeneratedFile(`${stationId}.log`);
      if (logPath) {
        fs.appendFile(logPath, logEntry, (err) => {
          if (err) log('error', `Error appending data log: ${err.message}`);
        });
      }
    }
  } catch (error) {
    log('error', `Error writing data log: ${error.message}`);
  }
}

module.exports = {
  applyChildPriority,
  rotateLogIfNeeded,
  startRtkrcvInternal,
  killProcessWithTimeout,
  writeDataLog,
  onProcessExit,
  ensureDirectories
};
