const { test } = require('node:test');
const assert = require('node:assert');
const { parse, buildPath } = require('../public/cors-parser');

const QIXING = `运营商: 七星CORS，请先确保网络正常
账号: fyx7942
密码: fyx28534
IP: yd.ytcors.cn；其次数字IP:115.120.87.59
接入点: RTCM33GRCEJ 七星三十频-新机器推荐
RTCM33GRCEPRO 五星十六频
RTCM32_GGB 三星八频-老机器推荐
端口: 8003：CGCS2000, 参考历元：2000.0（对齐千寻）8103：CGCS2000, 参考历元：2000.0（对齐移动）8104：地方CGCS2000，参考历元：2000.0（各省厅CORS），8102对应WGS84坐标系。可以做到千寻与移动进行无感切换可以无感切换
设置方式: 售后：如不会设置或设置失败，请及时联系在线客服解决；

请按照对应的账号IP、端口、源节点信息去设置，登录后注意核对控制点，谢谢。`;

test('splits a 七星CORS message into account, hosts, ports and mount points', () => {
  const r = parse(QIXING);
  assert.deepStrictEqual(r.missing, []);
  assert.strictEqual(r.provider, '七星CORS');
  assert.strictEqual(r.user, 'fyx7942');
  assert.strictEqual(r.password, 'fyx28534');
  assert.deepStrictEqual(r.hosts.map((h) => h.host), ['yd.ytcors.cn', '115.120.87.59']);
  assert.deepStrictEqual(r.ports.map((p) => p.port), [8003, 8103, 8104, 8102]);
  assert.match(r.ports[0].desc, /对齐千寻/);
  assert.match(r.ports[3].desc, /WGS84/);
  assert.deepStrictEqual(r.mounts.map((m) => m.name), ['RTCM33GRCEJ', 'RTCM33GRCEPRO', 'RTCM32_GGB']);
  assert.strictEqual(r.mounts[0].desc, '七星三十频-新机器推荐');
  assert.strictEqual(buildPath(r), 'fyx7942:fyx28534@yd.ytcors.cn:8003/RTCM33GRCEJ');
});

test('handles full-width colons, single-line mount lists and CRLF', () => {
  const r = parse('账号：abc123\r\n密码：p@ss:1\r\n服务器地址：120.1.2.3\r\n端口号：8002\r\n挂载点：RTCM32_GGB 三星 RTCM33_GRCE 四星');
  assert.strictEqual(r.user, 'abc123');
  assert.strictEqual(r.password, 'p@ss:1');
  assert.strictEqual(r.host, '120.1.2.3');
  assert.strictEqual(r.port, 8002);
  assert.deepStrictEqual(r.mounts.map((m) => m.name), ['RTCM32_GGB', 'RTCM33_GRCE']);
});

test('accepts a ready-made NTRIP path', () => {
  const r = parse('ntrip://ytcors14847:fyx25943@gnss.ytcors.cn:8003/RTCM33GRCEJpro');
  assert.deepStrictEqual(r.missing, []);
  assert.strictEqual(buildPath(r), 'ytcors14847:fyx25943@gnss.ytcors.cn:8003/RTCM33GRCEJpro');
});

test('reports missing fields instead of guessing', () => {
  const r = parse('账号: u1\n密码: p1');
  assert.deepStrictEqual(r.missing, ['IP/域名', '端口', '接入点']);
});

test('defaults to port 8003 even when it is not listed first', () => {
  const r = parse('账号: u\n密码: p\nIP: a.b.cn\n端口: 8102对应WGS84；8103：对齐移动；8003：对齐千寻\n接入点: RTCM33GRCEJ');
  assert.deepStrictEqual(r.ports.map((p) => p.port), [8102, 8103, 8003]);
  assert.strictEqual(r.port, 8003);
});
