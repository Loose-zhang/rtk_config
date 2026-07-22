const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseStationsTxt, readTextFileSmart, extractMountPoint,
  ensureTrailingSlash, replaceTemplateKey, writeJsonAtomic,
  isSafeGeneratedName, mergeStableResults, filterBatchStationsByHistory
} = require('../lib/store');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtktest-'));

function tmpFile(name, bufOrStr) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, bufOrStr);
  return p;
}

test('parseStationsTxt: UTF-8 基本解析（含注释与空行）', () => {
  const p = tmpFile('u8.txt', '# comment\n6539837 1\n\n6539840\t0\n// skip\nbad-line\n');
  const items = parseStationsTxt(p);
  assert.deepStrictEqual(items, [
    { stationId: '6539837', outHeight: 1 },
    { stationId: '6539840', outHeight: 0 }
  ]);
});

test('parseStationsTxt: UTF-16LE（带BOM）也能正确解析（B1）', () => {
  const content = '6539837\t1\r\n6539840\t0\r\n';
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]);
  const p = tmpFile('u16.txt', buf);
  const items = parseStationsTxt(p);
  assert.deepStrictEqual(items, [
    { stationId: '6539837', outHeight: 1 },
    { stationId: '6539840', outHeight: 0 }
  ]);
});

test('readTextFileSmart: UTF-8 BOM 被去除', () => {
  const p = tmpFile('bom.txt', '﻿hello');
  assert.strictEqual(readTextFileSmart(p), 'hello');
});

test('extractMountPoint: 从 NTRIP 路径提取挂载点', () => {
  assert.strictEqual(extractMountPoint('user:pass@host:8001/6539840'), '6539840');
  assert.strictEqual(extractMountPoint('nopath'), 'default');
});

test('ensureTrailingSlash', () => {
  assert.strictEqual(ensureTrailingSlash('a/b'), 'a/b/');
  assert.strictEqual(ensureTrailingSlash('a/b/'), 'a/b/');
});

test('filterBatchStationsByHistory: 重复提交默认重新处理全部站点', () => {
  const list = [
    { stationId: '6539837', outHeight: 1 },
    { stationId: '6539840', outHeight: 0 }
  ];
  const actual = filterBatchStationsByHistory(list, {
    failedResults: [{ stationId: '6539837' }],
    stableResults: [{ stationId: '6539840' }]
  });
  assert.deepStrictEqual(actual, list);
});

test('filterBatchStationsByHistory: 显式启用时仍可跳过历史站点', () => {
  const list = [
    { stationId: '6539837', outHeight: 1 },
    { stationId: '6539840', outHeight: 0 },
    { stationId: '6539842', outHeight: 1 }
  ];
  const actual = filterBatchStationsByHistory(list, {
    failedResults: [{ stationId: '6539837' }],
    stableResults: [{ stationId: '6539840' }],
    skipFailed: true,
    skipSucceeded: true
  });
  assert.deepStrictEqual(actual, [{ stationId: '6539842', outHeight: 1 }]);
});

test('replaceTemplateKey: 正常替换', () => {
  const tpl = 'inpstr1-path       =old  # comment\nother=1\n';
  const out = replaceTemplateKey(tpl, 'inpstr1-path', 'inpstr1-path       =new');
  assert.ok(out.includes('=new'));
  assert.ok(!out.includes('=old'));
});

test('replaceTemplateKey: 缺少配置项时抛错（B5）', () => {
  assert.throws(() => replaceTemplateKey('foo=1\n', 'inpstr1-path', 'x'), /模板缺少配置项/);
});

test('isSafeGeneratedName: 拒绝目录穿越与路径分隔符', () => {
  assert.strictEqual(isSafeGeneratedName('6539840.conf'), true);
  assert.strictEqual(isSafeGeneratedName('6539840.log'), true);
  assert.strictEqual(isSafeGeneratedName('../README.md'), false);
  assert.strictEqual(isSafeGeneratedName('..\\config.js'), false);
  assert.strictEqual(isSafeGeneratedName('a/b.conf'), false);
  assert.strictEqual(isSafeGeneratedName('..'), false);
  assert.strictEqual(isSafeGeneratedName('/etc/passwd'), false);
  assert.strictEqual(isSafeGeneratedName(''), false);
  assert.strictEqual(isSafeGeneratedName(null), false);
});

test('writeJsonAtomic: 写入后可读回，且无残留tmp（A4）', () => {
  const p = path.join(tmpDir, 'atomic.json');
  writeJsonAtomic(p, [{ a: 1 }]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, 'utf-8')), [{ a: 1 }]);
  assert.ok(!fs.existsSync(`${p}.tmp`));
});

test('mergeStableResults: 合并数据库与 JSON，数据库字段优先且按时间倒序', () => {
  const jsonResults = [
    { id: 'a', stationId: 'A', timestamp: '2026-07-14T01:00:00.000Z', height: '1.0', originalSampleCount: 40 },
    { id: 'b', stationId: 'B', timestamp: '2026-07-14T03:00:00.000Z', height: '2.0' }
  ];
  const databaseResults = [
    { id: 'a', stationId: 'A', timestamp: '2026-07-14T01:00:00.000Z', height: '1.1' },
    { id: 'c', stationId: 'C', timestamp: '2026-07-14T02:00:00.000Z', height: '3.0' }
  ];

  const merged = mergeStableResults(databaseResults, jsonResults);
  assert.deepStrictEqual(merged.map(r => r.id), ['b', 'c', 'a']);
  assert.strictEqual(merged.find(r => r.id === 'a').height, '1.1');
  assert.strictEqual(merged.find(r => r.id === 'a').originalSampleCount, 40);
});

test('mergeStableResults: 非数组输入安全回退为空数组', () => {
  assert.deepStrictEqual(mergeStableResults(null, undefined), []);
});
