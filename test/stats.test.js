const { test } = require('node:test');
const assert = require('node:assert');
const { calculateAverage, calculateAverageInternal, calculateStdDev } = require('../lib/stats');

function makeSample(x, y, z, lat = 22.1, lon = 107.8, height = 189.6, satellites = 20) {
  return { ecef: { x, y, z }, llh: { lat, lon, height }, timestamp: new Date(), satellites };
}

test('calculateAverage: 空样本返回 null', () => {
  assert.strictEqual(calculateAverage([]), null);
});

test('calculateAverage: 样本<=3 不做过滤', () => {
  const avg = calculateAverage([makeSample(1, 2, 3), makeSample(3, 4, 5)]);
  assert.strictEqual(avg.filtered, undefined);
  assert.strictEqual(avg.sampleCount, 2);
  assert.strictEqual(avg.ecef.x, '2.0000');
  assert.strictEqual(avg.ecef.y, '3.0000');
  assert.strictEqual(avg.ecef.z, '4.0000');
});

test('calculateAverage: >3 样本剔除误差最大的2个', () => {
  const samples = [
    makeSample(100, 100, 100),
    makeSample(100.001, 100.001, 100.001),
    makeSample(100.002, 100.002, 100.002),
    makeSample(100.001, 100, 100.001),
    makeSample(150, 150, 150),   // 异常值
    makeSample(50, 50, 50)       // 异常值
  ];
  const avg = calculateAverage(samples);
  assert.strictEqual(avg.filtered, true);
  assert.strictEqual(avg.removedSampleCount, 2);
  assert.strictEqual(avg.originalSampleCount, 6);
  assert.strictEqual(avg.sampleCount, 4);
  // 剔除两个异常值后均值应接近 100
  assert.ok(Math.abs(parseFloat(avg.ecef.x) - 100.001) < 0.01, avg.ecef.x);
});

test('calculateAverageInternal: 平均与卫星数取整', () => {
  const avg = calculateAverageInternal([
    makeSample(1, 1, 1, 10, 20, 30, 19),
    makeSample(3, 3, 3, 12, 22, 32, 20)
  ]);
  assert.strictEqual(avg.ecef.x, '2.0000');
  assert.strictEqual(avg.llh.lat, '11.000000000');
  assert.strictEqual(avg.satellites, 20); // round(19.5)
  assert.ok(avg.stdDev);
});

test('calculateStdDev: 单样本返回 null', () => {
  const mean = { ecef: { x: 1, y: 1, z: 1 }, llh: { lat: 1, lon: 1, height: 1 } };
  assert.strictEqual(calculateStdDev([makeSample(1, 1, 1)], mean), null);
});

test('calculateStdDev: 恒定样本标准差为0', () => {
  const samples = [makeSample(5, 5, 5), makeSample(5, 5, 5)];
  const mean = { ecef: { x: 5, y: 5, z: 5 }, llh: { lat: 22.1, lon: 107.8, height: 189.6 } };
  const sd = calculateStdDev(samples, mean);
  assert.strictEqual(sd.ecef.x, '0.0000');
  assert.strictEqual(sd.llh.lat, '0.000000000');
});
