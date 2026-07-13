const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../config');
const { log } = require('../lib/logger');

function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (msg) => lines.push(msg);
  try { fn(); } finally { console.log = orig; }
  return lines;
}

test('LOG_LEVEL=info 时不输出 debug 日志（P2修复回归）', () => {
  const prev = config.logLevel;
  config.logLevel = 'info';
  const lines = capture(() => log('debug', 'should-not-appear'));
  config.logLevel = prev;
  assert.strictEqual(lines.length, 0);
});

test('LOG_LEVEL=info 时输出 info/warn/error', () => {
  const prev = config.logLevel;
  config.logLevel = 'info';
  const lines = capture(() => {
    log('info', 'i');
    log('warn', 'w');
    log('error', 'e');
  });
  config.logLevel = prev;
  assert.strictEqual(lines.length, 3);
});

test('LOG_LEVEL=debug 时输出 debug', () => {
  const prev = config.logLevel;
  config.logLevel = 'debug';
  const lines = capture(() => log('debug', 'd'));
  config.logLevel = prev;
  assert.strictEqual(lines.length, 1);
});

test('LOG_LEVEL=error 时抑制 warn 及以下', () => {
  const prev = config.logLevel;
  config.logLevel = 'error';
  const lines = capture(() => {
    log('debug', 'd');
    log('info', 'i');
    log('warn', 'w');
    log('error', 'e');
  });
  config.logLevel = prev;
  assert.strictEqual(lines.length, 1);
});
