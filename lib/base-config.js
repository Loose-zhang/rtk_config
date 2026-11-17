// “配置基站”流程的服务端能力（由 security-monitor 设备参数页拉起本页面）：
//   1) 检测连接：连接 NTRIP 挂载点，统计 RTCM 消息类型，确认设备数据已到达 caster；
//   2) 1005 校验：基站坐标下发后单独接收设备 RTCM，解析 1005 并与稳定解比对。
const crypto = require('crypto');
const { log } = require('./logger');
const { openNtripStream, describeNtripPath } = require('./ntrip-client');
const { Rtcm3Parser, decode1005, MESSAGE_NAMES, isObservationMessage } = require('./rtcm3');

const verifyJobs = new Map();
const JOB_RETENTION_MS = 60 * 60 * 1000;
const RECONNECT_DELAY_MS = 5000;

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function diffOf(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return { dx, dy, dz, d3: Math.sqrt(dx * dx + dy * dy + dz * dz) };
}

function parseExpected(expected) {
  if (!expected) return null;
  const e = { x: Number(expected.x), y: Number(expected.y), z: Number(expected.z) };
  if (![e.x, e.y, e.z].every(Number.isFinite)) return null;
  const r = Math.sqrt(e.x * e.x + e.y * e.y + e.z * e.z);
  return (r > 6300000 && r < 6400000) ? e : null;
}

// ---------------------------------------------------------------- 检测连接

/**
 * 连接一个 NTRIP 挂载点并在 durationMs 内统计数据。
 * stopWhen1005：设备流在收到观测量与 1005 后提前结束。
 */
function checkStream({ label, path, durationMs = 10000, stopWhen1005 = false }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const result = {
      label,
      target: describeNtripPath(path),
      connected: false,
      status: null,
      bytes: 0,
      frames: 0,
      observationFrames: 0,
      badCrc: 0,
      messageTypes: [],
      last1005: null,
      error: null,
      elapsedMs: 0
    };
    const counts = new Map();
    const parser = new Rtcm3Parser();
    let stream = null;
    let timer = null;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (stream) stream.close();
      result.badCrc = parser.badCrc;
      result.elapsedMs = Date.now() - startedAt;
      result.messageTypes = Array.from(counts.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([type, count]) => ({ type, count, name: MESSAGE_NAMES[type] || '' }));
      resolve(result);
    };

    try {
      stream = openNtripStream({
        path,
        connectTimeoutMs: 8000,
        onConnected: (statusLine) => {
          result.connected = true;
          result.status = statusLine;
          clearTimeout(timer);
          timer = setTimeout(finish, durationMs);
        },
        onData: (chunk) => {
          result.bytes += chunk.length;
          for (const frame of parser.push(chunk)) {
            result.frames++;
            counts.set(frame.type, (counts.get(frame.type) || 0) + 1);
            if (isObservationMessage(frame.type)) result.observationFrames++;
            if (frame.type === 1005 || frame.type === 1006) {
              const pos = decode1005(frame.payload);
              if (pos) result.last1005 = pos;
            }
          }
          if (stopWhen1005 && result.last1005 && result.observationFrames > 0) finish();
        },
        onError: (err) => { result.error = err.message; },
        onClose: finish
      });
      // 连接阶段的兜底超时（openNtripStream 自身也有 8 秒超时）
      timer = setTimeout(() => {
        if (!result.connected && !result.error) result.error = '连接超时';
        finish();
      }, 10000);
    } catch (e) {
      result.error = e.message;
      finish();
    }
  });
}

// ---------------------------------------------------------------- 1005 校验任务

function publicJob(job) {
  return {
    id: job.id,
    target: job.target,
    state: job.state,
    expected: job.expected,
    toleranceM: job.toleranceM,
    requiredMatches: job.requiredMatches,
    consecutiveMatches: job.consecutiveMatches,
    frames1005: job.frames1005,
    bytes: job.bytes,
    connectAttempts: job.connectAttempts,
    last: job.last,
    result: job.result,
    error: job.error,
    startedAt: new Date(job.startedAt).toISOString(),
    deadline: new Date(job.deadline).toISOString()
  };
}

function finishJob(job, state, error) {
  if (job.state === 'matched' || job.state === 'timeout' || job.state === 'stopped' || job.state === 'error') return;
  job.state = state;
  if (error) job.error = error;
  job.finishedAt = Date.now();
  clearTimeout(job.deadlineTimer);
  clearTimeout(job.reconnectTimer);
  if (job.stream) {
    job.stream.close();
    job.stream = null;
  }
  log('info', `1005 verify job ${job.id} (${job.target}) -> ${state}${error ? ': ' + error : ''}`);
}

function isRunning(job) {
  return job.state === 'connecting' || job.state === 'receiving' || job.state === 'reconnecting';
}

function connectJob(job) {
  if (!isRunning(job)) return;
  job.connectAttempts++;
  job.state = job.connectAttempts > 1 ? 'reconnecting' : 'connecting';
  const parser = new Rtcm3Parser();
  try {
    job.stream = openNtripStream({
      path: job.path,
      connectTimeoutMs: 8000,
      onConnected: () => {
        if (isRunning(job)) job.state = 'receiving';
      },
      onData: (chunk) => {
        if (!isRunning(job)) return;
        job.bytes += chunk.length;
        for (const frame of parser.push(chunk)) {
          if (frame.type !== 1005 && frame.type !== 1006) continue;
          const pos = decode1005(frame.payload);
          if (!pos) continue;
          job.frames1005++;
          const diff = diffOf(pos, job.expected);
          const ok = diff.d3 <= job.toleranceM;
          job.consecutiveMatches = ok ? job.consecutiveMatches + 1 : 0;
          job.last = { ...pos, ...diff, ok, at: new Date().toISOString() };
          if (job.consecutiveMatches >= job.requiredMatches) {
            job.result = job.last;
            finishJob(job, 'matched');
            return;
          }
        }
      },
      onError: (err) => { job.error = err.message; },
      onClose: () => {
        job.stream = null;
        if (!isRunning(job)) return;
        job.state = 'reconnecting';
        job.reconnectTimer = setTimeout(() => connectJob(job), RECONNECT_DELAY_MS);
      }
    });
  } catch (e) {
    finishJob(job, 'error', e.message);
  }
}

function startVerifyJob({ path, expected, toleranceM, requiredMatches, timeoutSec }) {
  const exp = parseExpected(expected);
  if (!exp) throw new Error('expected 必须是有效的 ECEF 坐标 {x,y,z}');
  const target = describeNtripPath(path);
  if (!target) throw new Error('NTRIP 路径格式错误，应为 user:password@host:port/mountpoint');

  // 同一挂载点只保留一个运行中的校验任务
  for (const job of verifyJobs.values()) {
    if (job.target === target && isRunning(job)) finishJob(job, 'stopped', '被新的校验任务替换');
  }

  const now = Date.now();
  const job = {
    id: crypto.randomUUID(),
    path,
    target,
    expected: exp,
    toleranceM: clamp(toleranceM, 0.001, 1, 0.05),
    requiredMatches: Math.round(clamp(requiredMatches, 1, 20, 3)),
    consecutiveMatches: 0,
    frames1005: 0,
    bytes: 0,
    connectAttempts: 0,
    state: 'connecting',
    last: null,
    result: null,
    error: null,
    stream: null,
    startedAt: now,
    deadline: now + clamp(timeoutSec, 30, 3600, 900) * 1000
  };
  job.deadlineTimer = setTimeout(() => {
    finishJob(job, 'timeout', job.frames1005 > 0
      ? `超时：已收到 ${job.frames1005} 条 1005，但未连续 ${job.requiredMatches} 次与稳定解一致`
      : '超时：未收到设备的 1005 报文');
  }, job.deadline - now);
  verifyJobs.set(job.id, job);
  log('info', `1005 verify job ${job.id} started for ${target}, tolerance ${job.toleranceM} m`);
  connectJob(job);
  return job;
}

function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of verifyJobs) {
    if (!isRunning(job) && job.finishedAt && now - job.finishedAt > JOB_RETENTION_MS) {
      verifyJobs.delete(id);
    }
  }
}

function stopAllJobs() {
  for (const job of verifyJobs.values()) finishJob(job, 'stopped');
}

// ---------------------------------------------------------------- 路由

function registerBaseConfigRoutes(app) {
  const sweeper = setInterval(sweepJobs, 10 * 60 * 1000);
  if (sweeper.unref) sweeper.unref();

  // 检测连接：body { streams: [{label, path, stopWhen1005}], durationMs }
  app.post('/api/base-config/check-connection', async (req, res) => {
    try {
      const streams = Array.isArray(req.body && req.body.streams) ? req.body.streams : [];
      if (streams.length === 0 || streams.length > 3) {
        return res.status(400).json({ success: false, message: '请提供 1~3 个数据流' });
      }
      const durationMs = clamp(req.body.durationMs, 3000, 30000, 10000);
      const results = await Promise.all(streams.map((s, i) => checkStream({
        label: String((s && s.label) || `inpstr${i + 1}`).slice(0, 32),
        path: String((s && s.path) || ''),
        durationMs,
        stopWhen1005: !!(s && s.stopWhen1005)
      })));
      res.json({ success: true, results });
    } catch (e) {
      log('error', `check-connection failed: ${e.message}`);
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 启动 1005 校验：body { path, expected:{x,y,z}, toleranceM, requiredMatches, timeoutSec }
  app.post('/api/base-config/rtcm1005/start', (req, res) => {
    try {
      const job = startVerifyJob(req.body || {});
      res.json({ success: true, job: publicJob(job) });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.get('/api/base-config/rtcm1005/:jobId', (req, res) => {
    const job = verifyJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, message: '校验任务不存在' });
    res.json({ success: true, job: publicJob(job) });
  });

  app.post('/api/base-config/rtcm1005/:jobId/stop', (req, res) => {
    const job = verifyJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, message: '校验任务不存在' });
    finishJob(job, 'stopped');
    res.json({ success: true, job: publicJob(job) });
  });
}

module.exports = {
  registerBaseConfigRoutes,
  checkStream,
  startVerifyJob,
  stopAllJobs,
  publicJob,
  _verifyJobs: verifyJobs
};
