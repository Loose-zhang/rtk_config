const { test } = require('node:test');
const assert = require('node:assert');
const { parseRtkcrvOutput } = require('../lib/parser');

// ECEF 行 + LLH 行（rtkrcv solution 输出，末尾字段为站点ID）
const ECEF_LINE = '2025/12/16 10:00:18.000  -1814691.1163   5626089.5970   2387186.0594   1  20   0.0100   0.0100   0.0100  0.0000  0.0000  0.0000   0.00    1.1 6539840';
const LLH_LINE = '2394 202818.000   22.123770818  107.877068568   189.6000   1  20   0.0100   0.0100   0.0100  0.0000  0.0000  0.0000   0.00    1.1 6539840';

test('ECEF+LLH 两行组合解析', () => {
  const r = parseRtkcrvOutput(`${ECEF_LINE}\n${LLH_LINE}`);
  assert.ok(r, '解析不应返回 null');
  assert.strictEqual(r.stationId, '6539840');
  assert.strictEqual(r.quality.status, 1);
  assert.strictEqual(r.quality.statusText, '固定解');
  assert.strictEqual(r.quality.satellites, 20);
  assert.strictEqual(r.ecef.x, '-1814691.1163');
  assert.strictEqual(r.llh.lat, '22.123770818');
  assert.strictEqual(r.quality.ambiguity, 1.1);
});

test('LLH-only（GPS周开头）单行解析并反算 ECEF', () => {
  const r = parseRtkcrvOutput(LLH_LINE);
  assert.ok(r);
  assert.strictEqual(r.stationId, '6539840');
  assert.strictEqual(r.llh.lat, '22.123770818');
  // 反算的 ECEF 应与实际 ECEF 接近（厘米级）
  assert.ok(Math.abs(parseFloat(r.ecef.x) - (-1814691.1163)) < 0.01, r.ecef.x);
  assert.ok(Math.abs(parseFloat(r.ecef.y) - 5626089.5970) < 0.01, r.ecef.y);
});

test('LLH-only（日期时间开头）单行解析', () => {
  const line = '2025/12/16 10:00:18.000   22.123770818  107.877068568   189.6000   1  20    1.1 6539840';
  const r = parseRtkcrvOutput(line);
  assert.ok(r);
  assert.strictEqual(r.stationId, '6539840');
  assert.strictEqual(r.quality.status, 1);
  // GPST 10:00:18 - 18s 闰秒 = UTC 10:00:00
  assert.strictEqual(r.timestamp, '2025-12-16T10:00:00.000Z');
});

test('字段过少返回 null', () => {
  assert.strictEqual(parseRtkcrvOutput('1 2 3'), null);
});

test('浮点解状态文本', () => {
  const line = '2394 202818.000   22.123770818  107.877068568   189.6000   2  15    0.5 6539840';
  const r = parseRtkcrvOutput(line);
  assert.ok(r);
  assert.strictEqual(r.quality.status, 2);
  assert.strictEqual(r.quality.statusText, '浮点解');
});
