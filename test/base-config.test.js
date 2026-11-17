// 用本地假 NTRIP caster 端到端验证“检测连接”与“1005 校验”
const { test, after } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { checkStream, startVerifyJob, stopAllJobs, publicJob } = require('../lib/base-config');
const { encode1005Frame, wrapFrame } = require('../lib/rtcm3');

const EXPECTED = { x: -1814691.1163, y: 5626089.5970, z: 2387186.0594 };
const servers = [];

// 假 caster：校验认证与挂载点，然后按 frames(n) 周期推送帧
function fakeCaster(framesAt) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.once('data', (req) => {
        const text = req.toString();
        if (!/^GET \/DEV1 HTTP\/1\.0/.test(text)) { sock.end('SOURCETABLE 200 OK\r\n\r\nENDSOURCETABLE\r\n'); return; }
        if (!text.includes('Authorization: Basic ' + Buffer.from('u:p@ss').toString('base64'))) {
          sock.end('HTTP/1.0 401 Unauthorized\r\n\r\n'); return;
        }
        sock.write('ICY 200 OK\r\n');
        let n = 0;
        const timer = setInterval(() => {
          if (sock.destroyed) return clearInterval(timer);
          for (const f of framesAt(n++)) sock.write(f);
        }, 50);
        sock.on('close', () => clearInterval(timer));
        sock.on('error', () => {});
      });
      sock.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server.address().port); });
  });
}

after(() => { stopAllJobs(); servers.forEach(s => s.close()); });

const msm = wrapFrame(Buffer.from([0x46, 0x40, 0, 0, 0, 0])); // 1124 北斗 MSM4

test('检测连接：统计消息类型并提前结束', async () => {
  const port = await fakeCaster(() => [msm, encode1005Frame(EXPECTED)]);
  const r = await checkStream({ label: 'inpstr1', path: `u:p@ss@127.0.0.1:${port}/DEV1`, durationMs: 5000, stopWhen1005: true });
  assert.strictEqual(r.connected, true, r.error);
  assert.strictEqual(r.target, `127.0.0.1:${port}/DEV1`);
  assert.ok(r.observationFrames >= 1);
  assert.ok(r.messageTypes.some(m => m.type === 1124 && m.name === '北斗 MSM4'));
  assert.ok(Math.abs(r.last1005.x - EXPECTED.x) < 1e-6);
  assert.ok(r.elapsedMs < 3000);
});

test('检测连接：认证失败与挂载点不存在', async () => {
  const port = await fakeCaster(() => []);
  const bad = await checkStream({ label: 'a', path: `u:wrong@127.0.0.1:${port}/DEV1`, durationMs: 3000 });
  assert.strictEqual(bad.connected, false);
  assert.match(bad.error, /401/);
  const missing = await checkStream({ label: 'b', path: `u:p@ss@127.0.0.1:${port}/NOPE`, durationMs: 3000 });
  assert.match(missing.error, /挂载点/);
});

function waitJob(job, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const s = publicJob(job).state;
      if (!['connecting', 'receiving', 'reconnecting'].includes(s) || Date.now() - t0 > ms) {
        clearInterval(iv); resolve(publicJob(job));
      }
    }, 50);
  });
}

test('1005 校验：先收到旧坐标，切换为新坐标后连续 3 次一致即通过', async () => {
  const old = { x: EXPECTED.x + 3, y: EXPECTED.y, z: EXPECTED.z };
  const port = await fakeCaster((n) => [msm, encode1005Frame(n < 4 ? old : { ...EXPECTED, x: EXPECTED.x + 0.0004 })]);
  const job = startVerifyJob({ path: `u:p@ss@127.0.0.1:${port}/DEV1`, expected: EXPECTED, toleranceM: 0.05, requiredMatches: 3, timeoutSec: 30 });
  const s = await waitJob(job, 5000);
  assert.strictEqual(s.state, 'matched', JSON.stringify(s));
  assert.ok(s.frames1005 >= 7);
  assert.ok(s.result.d3 < 0.001);
  assert.ok(!JSON.stringify(s).includes('p@ss'), '不应泄露账号密码');
});

test('1005 校验：参数校验', () => {
  assert.throws(() => startVerifyJob({ path: 'h:1/m', expected: { x: 1, y: 2, z: 3 } }), /ECEF/);
  assert.throws(() => startVerifyJob({ path: 'bad', expected: EXPECTED }), /路径/);
});
