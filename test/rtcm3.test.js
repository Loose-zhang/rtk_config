const { test } = require('node:test');
const assert = require('node:assert');
const { Rtcm3Parser, decode1005, encode1005Frame, crc24q, wrapFrame } = require('../lib/rtcm3');
const { parseNtripPath } = require('../lib/ntrip-client');

const X = -1814691.1163, Y = 5626089.5970, Z = 2387186.0594;

test('1005 编码后解码一致（0.1mm）', () => {
  const frame = encode1005Frame({ x: X, y: Y, z: Z, stationId: 123 });
  const [f] = new Rtcm3Parser().push(frame);
  assert.strictEqual(f.type, 1005);
  const pos = decode1005(f.payload);
  assert.strictEqual(pos.stationId, 123);
  assert.ok(Math.abs(pos.x - X) < 1e-6, String(pos.x));
  assert.ok(Math.abs(pos.y - Y) < 1e-6, String(pos.y));
  assert.ok(Math.abs(pos.z - Z) < 1e-6, String(pos.z));
});

test('与网页 HEX 解析器（Int38）取位一致', () => {
  // 复刻 public/app.js 的 parseEcefFromHex：hex[14..24)、[24..34)、[34..44) 各跳过前 2 位
  const hex = encode1005Frame({ x: X, y: Y, z: Z }).toString('hex');
  const int38 = (h) => {
    const bits = BigInt('0x' + h).toString(2).padStart(40, '0').substring(2);
    let v = BigInt('0b' + bits);
    if (bits[0] === '1') v -= 1n << 38n;
    return Number(v) / 10000;
  };
  assert.ok(Math.abs(int38(hex.substring(14, 24)) - X) < 1e-6);
  assert.ok(Math.abs(int38(hex.substring(24, 34)) - Y) < 1e-6);
  assert.ok(Math.abs(int38(hex.substring(34, 44)) - Z) < 1e-6);
});

test('分片、噪声、CRC 错误帧均能正确重同步', () => {
  const good = encode1005Frame({ x: X, y: Y, z: Z });
  const bad = Buffer.from(good); bad[10] ^= 0xff;
  const obs = wrapFrame(Buffer.from([0x43, 0x20, 0, 0, 0])); // 1074 头
  const stream = Buffer.concat([Buffer.from('ICY junk \xd3'), bad, obs, good]);
  const parser = new Rtcm3Parser();
  const frames = [];
  for (let i = 0; i < stream.length; i += 7) frames.push(...parser.push(stream.subarray(i, i + 7)));
  assert.deepStrictEqual(frames.map(f => f.type), [1074, 1005]);
  assert.ok(parser.badCrc >= 1);
});

test('CRC24Q 已知值', () => {
  // "123456789" 的 CRC-24Q = 0xCDE703
  assert.strictEqual(crc24q(Buffer.from('123456789')), 0xcde703);
});

test('NTRIP 路径解析：密码含 @ 与 :', () => {
  assert.deepStrictEqual(parseNtripPath('beidou:29832611@8.134.185.53:8001/6539837'),
    { user: 'beidou', password: '29832611', host: '8.134.185.53', port: 8001, mountpoint: '6539837' });
  assert.deepStrictEqual(parseNtripPath('Ming:@Zhang12345@ntrip.data.gnss.ga.gov.au:2101/BCEP00BKG0'),
    { user: 'Ming', password: '@Zhang12345', host: 'ntrip.data.gnss.ga.gov.au', port: 2101, mountpoint: 'BCEP00BKG0' });
  assert.strictEqual(parseNtripPath('host/MP').port, 2101);
  assert.throws(() => parseNtripPath('no-mountpoint:2101'));
});
