// 文件存取：结果 JSON（原子写入）、模板、站点 TXT、配置生成
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { log } = require('./logger');

// 稳定结果数据文件路径
const stableResultsFile = path.join(config.generatedDir, 'stable_results.json');
// 失败结果数据文件路径（记录每次失败的站点、轮次和失败序号）
const failedResultsFile = path.join(config.generatedDir, 'failed_results.json');

// 确保必要的目录存在
function ensureDirectories() {
  if (!fs.existsSync(config.generatedDir)) {
    fs.mkdirSync(config.generatedDir, { recursive: true });
    log('info', `Created directory: ${config.generatedDir}`);
  }
}

// 原子写入 JSON：先写临时文件再 rename，避免写入中断导致文件损坏（A4）
function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// 读取稳定结果
function readStableResults() {
  try {
    if (fs.existsSync(stableResultsFile)) {
      const data = fs.readFileSync(stableResultsFile, 'utf-8');
      return JSON.parse(data);
    }
    return [];
  } catch (error) {
    log('error', `Error reading stable results: ${error.message}`);
    return [];
  }
}

// 写入稳定结果
function writeStableResults(results) {
  try {
    ensureDirectories();
    writeJsonAtomic(stableResultsFile, results);
    log('info', `Saved ${results.length} stable results`);
    return true;
  } catch (error) {
    log('error', `Error writing stable results: ${error.message}`);
    return false;
  }
}

// 合并数据库与 JSON 中的稳定结果。primaryResults（通常为数据库）字段优先，
// JSON 中仅存在的记录仍会保留，确保数据库短暂写入失败时页面不会丢数据。
function mergeStableResults(primaryResults, fallbackResults) {
  const merged = new Map();

  const recordKey = (record, index, source) => {
    if (record && record.id) return `id:${record.id}`;
    if (record && (record.stationId || record.timestamp)) {
      return `legacy:${record.stationId || ''}:${record.timestamp || ''}`;
    }
    return `${source}:${index}`;
  };

  const fallback = Array.isArray(fallbackResults) ? fallbackResults : [];
  fallback.forEach((record, index) => {
    if (!record || typeof record !== 'object') return;
    merged.set(recordKey(record, index, 'fallback'), { ...record });
  });

  const primary = Array.isArray(primaryResults) ? primaryResults : [];
  primary.forEach((record, index) => {
    if (!record || typeof record !== 'object') return;
    const key = recordKey(record, index, 'primary');
    const existing = merged.get(key) || {};
    merged.set(key, { ...existing, ...record });
  });

  return Array.from(merged.values()).sort((a, b) => {
    const aTime = Date.parse(a.timestamp || '') || 0;
    const bTime = Date.parse(b.timestamp || '') || 0;
    return bTime - aTime;
  });
}

// 读取失败结果（数组：{ stationId, round, index, at }）
function readFailedResults() {
  try {
    if (fs.existsSync(failedResultsFile)) {
      const data = fs.readFileSync(failedResultsFile, 'utf-8');
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) return [];
      // 兼容旧格式：纯 stationId 列表
      return parsed.map((item, idx) => {
        if (item && typeof item === 'object') {
          return item;
        }
        return {
          stationId: String(item),
          round: 0,
          index: idx + 1
        };
      });
    }
    return [];
  } catch (error) {
    log('error', `Error reading failed results: ${error.message}`);
    return [];
  }
}

// 写入失败结果（数组：{ stationId, round, index, at }）
function writeFailedResults(list) {
  try {
    ensureDirectories();
    const arr = Array.isArray(list) ? list : [];
    writeJsonAtomic(failedResultsFile, arr);
    log('info', `Saved ${arr.length} failed results`);
    return true;
  } catch (error) {
    log('error', `Error writing failed results: ${error.message}`);
    return false;
  }
}

// 按需使用历史结果过滤新提交的批处理列表。
// 默认不跳过任何站点，使重复提交与自动多轮都重新计算完整列表。
function filterBatchStationsByHistory(list, {
  failedResults = [],
  stableResults = [],
  skipFailed = false,
  skipSucceeded = false
} = {}) {
  const failed = skipFailed
    ? new Set(failedResults.map(item => String(item && typeof item === 'object' ? item.stationId : item)))
    : new Set();
  const succeeded = skipSucceeded
    ? new Set(stableResults.map(item => String(item && typeof item === 'object' ? item.stationId : item)))
    : new Set();

  return (Array.isArray(list) ? list : []).filter(item => {
    const stationId = String(item && item.stationId);
    return !failed.has(stationId) && !succeeded.has(stationId);
  });
}

// 读取模板配置文件
function readTemplate() {
  try {
    if (!fs.existsSync(config.templatePath)) {
      throw new Error(`Template file not found: ${config.templatePath}`);
    }
    return fs.readFileSync(config.templatePath, 'utf-8');
  } catch (error) {
    log('error', `Error reading template: ${error.message}`);
    throw error;
  }
}

// 替换模板中的一个配置项；若模板中不存在该项则抛错（B5：避免静默生成错误配置）
function replaceTemplateKey(content, key, replacement) {
  const regex = new RegExp(`^${key}\\s*=.*$`, 'm');
  if (!regex.test(content)) {
    throw new Error(`模板缺少配置项: ${key}（请检查 ${config.templatePath}）`);
  }
  return content.replace(regex, replacement);
}

// ---------- 设备文件夹布局 ----------
// 新布局：generated/<设备号>/<设备号>.conf 与 .log；兼容旧的平铺布局 generated/<文件名>

// 文件名安全校验：仅允许纯文件名，禁止路径分隔符与 ..（防目录穿越）
function isSafeGeneratedName(fileName) {
  const s = String(fileName || '');
  if (!s) return false;
  if (s.includes('..') || s.includes('/') || s.includes('\\')) return false;
  if (path.isAbsolute(s)) return false;
  return true;
}

// 在设备文件夹（优先）或旧平铺位置查找文件；找不到（或文件名非法）返回 null
function resolveGeneratedFile(fileName) {
  return resolveGeneratedFileAll(fileName)[0] || null;
}

// 返回该文件名在新旧两种布局下的全部存在路径（用于删除等需要彻底处理的场景）
function resolveGeneratedFileAll(fileName) {
  if (!isSafeGeneratedName(fileName)) return [];
  const base = String(fileName).replace(/\.[^.]+$/, '');
  const candidates = [
    path.join(config.generatedDir, base, fileName), // 设备文件夹（优先）
    path.join(config.generatedDir, fileName)        // 旧平铺布局
  ];
  return candidates.filter(p => fs.existsSync(p));
}

// 新建文件时的目标路径：generated/<设备号>/<文件名>（自动创建设备文件夹）
function preferredGeneratedPath(fileName) {
  if (!isSafeGeneratedName(fileName)) {
    throw new Error(`非法的文件名: ${fileName}`);
  }
  const base = String(fileName).replace(/\.[^.]+$/, '');
  const dir = path.join(config.generatedDir, base);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, fileName);
}

// 从路径中提取挂载点
function extractMountPoint(inputPath) {
  // 格式: user:pass@host:port/mountpoint
  const match = inputPath.match(/\/([^\/]+)$/);
  return match ? match[1] : 'default';
}

// 保证 base 以单个斜杠结尾
function ensureTrailingSlash(base) {
  if (!base.endsWith('/')) return `${base}/`;
  return base;
}

// 生成配置文件（可复用）
function generateConfigFile({ inpstr1, inpstr2, inpstr3, outHeight }) {
  let configContent = readTemplate();

  configContent = replaceTemplateKey(configContent, 'inpstr1-path', `inpstr1-path       =${inpstr1}`);
  configContent = replaceTemplateKey(configContent, 'inpstr2-path', `inpstr2-path       =${inpstr2}`);
  configContent = replaceTemplateKey(configContent, 'inpstr3-path', `inpstr3-path       =${inpstr3}`);
  configContent = replaceTemplateKey(configContent, 'out-height', `out-height         =${outHeight}   # (0:ellipsoidal,1:geodetic)`);

  // 同时更新输出文件路径，TCP 输出指向本服务（端口跟随 TCP_PORT 配置）
  const tcpPort = config.tcpPort || 60000;
  const mountPoint = extractMountPoint(inpstr1);
  configContent = replaceTemplateKey(configContent, 'outstr1-path', `outstr1-path       =127.0.0.1:${tcpPort}`);
  configContent = replaceTemplateKey(configContent, 'outstr2-path', `outstr2-path       =127.0.0.1:${tcpPort}`);

  const fileName = `${mountPoint}.conf`;
  ensureDirectories();
  // 每个设备一个文件夹：generated/<设备号>/<设备号>.conf
  const filePath = preferredGeneratedPath(fileName);
  fs.writeFileSync(filePath, configContent, 'utf-8');
  log('info', `Generated config file: ${path.relative(config.generatedDir, filePath)}`);

  return { fileName, filePath, content: configContent };
}

// 读取文本文件并容错处理编码（B1：兼容 UTF-8/UTF-16LE/UTF-16BE 及 BOM）
function readTextFileSmart(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
    if (buf[0] === 0xfe && buf[1] === 0xff) {
      // UTF-16BE：交换字节后按 LE 解码
      const swapped = Buffer.from(buf.subarray(2));
      swapped.swap16();
      return swapped.toString('utf16le');
    }
  }
  let text = buf.toString('utf-8');
  // 去除 UTF-8 BOM 与可能残留的空字节
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\x00/g, '');
}

// 解析站点TXT：每行格式 "stationId outHeight"
function parseStationsTxt(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`TXT 文件不存在: ${filePath}`);
  }
  const content = readTextFileSmart(filePath);
  const lines = content.split(/\r?\n/);
  const items = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const stationId = parts[0];
    const outHeight = parseInt(parts[1], 10);
    if (!stationId) continue;
    if (Number.isNaN(outHeight)) continue;
    items.push({ stationId, outHeight });
  }
  return items;
}

module.exports = {
  stableResultsFile,
  failedResultsFile,
  ensureDirectories,
  writeJsonAtomic,
  readStableResults,
  writeStableResults,
  mergeStableResults,
  readFailedResults,
  writeFailedResults,
  filterBatchStationsByHistory,
  readTemplate,
  replaceTemplateKey,
  isSafeGeneratedName,
  resolveGeneratedFile,
  resolveGeneratedFileAll,
  preferredGeneratedPath,
  extractMountPoint,
  ensureTrailingSlash,
  generateConfigFile,
  readTextFileSmart,
  parseStationsTxt
};
