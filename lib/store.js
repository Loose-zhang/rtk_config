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
  const filePath = path.join(config.generatedDir, fileName);

  ensureDirectories();
  fs.writeFileSync(filePath, configContent, 'utf-8');
  log('info', `Generated config file: ${fileName}`);

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
  readFailedResults,
  writeFailedResults,
  readTemplate,
  replaceTemplateKey,
  extractMountPoint,
  ensureTrailingSlash,
  generateConfigFile,
  readTextFileSmart,
  parseStationsTxt
};
