const { test } = require('node:test');
const assert = require('node:assert');
const { gpsToUtc, gpstDateTimeToUtc, llhToEcef, GPS_UTC_LEAP_SECONDS } = require('../lib/geodesy');

test('GPS_UTC_LEAP_SECONDS 默认为 18', () => {
  assert.strictEqual(GPS_UTC_LEAP_SECONDS, 18);
});

test('gpsToUtc: GPS 纪元(周0秒0)减闰秒', () => {
  const utc = gpsToUtc(0, 0);
  // 1980-01-06T00:00:00Z - 18s
  assert.strictEqual(utc.toISOString(), '1980-01-05T23:59:42.000Z');
});

test('gpsToUtc: 已知历元换算', () => {
  // GPS 周 2340，周内秒 0 => 2024-11-10T00:00:00 GPST => UTC 减 18 秒
  const utc = gpsToUtc(2340, 0);
  assert.strictEqual(utc.toISOString(), '2024-11-09T23:59:42.000Z');
});

test('gpstDateTimeToUtc: 日期时间字符串换算（GPST -> UTC）', () => {
  const utc = gpstDateTimeToUtc('2025/12/16', '10:00:18.000');
  assert.strictEqual(utc.toISOString(), '2025-12-16T10:00:00.000Z');
});

test('gpstDateTimeToUtc: 毫秒保留', () => {
  const utc = gpstDateTimeToUtc('2025/01/01', '00:00:18.500');
  assert.strictEqual(utc.toISOString(), '2025-01-01T00:00:00.500Z');
});

test('llhToEcef: 赤道原点', () => {
  const { x, y, z } = llhToEcef(0, 0, 0);
  assert.ok(Math.abs(x - 6378137.0) < 1e-6);
  assert.ok(Math.abs(y) < 1e-6);
  assert.ok(Math.abs(z) < 1e-6);
});

test('llhToEcef: 北极点', () => {
  const { x, y, z } = llhToEcef(90, 0, 0);
  // b = a*(1-f) ≈ 6356752.3142
  assert.ok(Math.abs(z - 6356752.3142) < 0.001);
  assert.ok(Math.abs(x) < 1e-6);
});

test('llhToEcef: 与生产数据一致（站点6539840）', () => {
  // 来自 result/stable_results.json 的实测记录
  const { x, y, z } = llhToEcef(22.123770818, 107.877068568, 189.6000);
  assert.ok(Math.abs(x - (-1814691.1163)) < 0.01, `x=${x}`);
  assert.ok(Math.abs(y - 5626089.5970) < 0.01, `y=${y}`);
  assert.ok(Math.abs(z - 2387186.0594) < 0.01, `z=${z}`);
});
