const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const config = require('./config');

const app = express();

// 进程管理对象 - 存储运行中的 RTKRCV 进程
// 格式: { 'configFileName': { process: childProcess, pid: number, startTime: Date, configFile: string, logStream: WriteStream } }
const runningProcesses = new Map();

// TCP 服务器和连接管理
let tcpServer = null;
const tcpClients = new Map();

// SSE 客户端管理 - 用于推送实时数据到网页
const sseClients = new Map();

// 最新的 RTKRCV 数据缓存
const latestData = new Map();

// ECEF 行缓存 - 等待对应的 LLH 行（因为数据可能分包到达）
const ecefCache = new Map();

// 站点稳定性跟踪
// 格式: { stationId: { status: 'collecting'|'stable', startTime: Date, samples: [], average: {} } }
const stationStability = new Map();

// Middleware
app.use(cors({ origin: config.corsOrigin }));
app.use(bodyParser.json());
app.use(express.static(config.publicDir));

// 日志函数
function log(level, message) {
  const timestamp = new Date().toISOString();
  
  // 根据配置的日志级别过滤
  const logLevels = { debug: 0, info: 1, warn: 2, error: 3 };
  const currentLevel = logLevels[config.logLevel] || 1;
  const messageLevel = logLevels[level] || 1;
  
  if (messageLevel >= currentLevel) {
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
  }
}

// 确保必要的目录存在
function ensureDirectories() {
  if (!fs.existsSync(config.generatedDir)) {
    fs.mkdirSync(config.generatedDir, { recursive: true });
    log('info', `Created directory: ${config.generatedDir}`);
  }
}

// 稳定结果数据文件路径
const stableResultsFile = path.join(config.generatedDir, 'stable_results.json');

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
    fs.writeFileSync(stableResultsFile, JSON.stringify(results, null, 2), 'utf-8');
    log('info', `Saved ${results.length} stable results`);
    return true;
  } catch (error) {
    log('error', `Error writing stable results: ${error.message}`);
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

// 从路径中提取挂载点
function extractMountPoint(path) {
  // 格式: user:pass@host:port/mountpoint
  const match = path.match(/\/([^\/]+)$/);
  return match ? match[1] : 'default';
}

// GPS 时间转换为 UTC 时间
function gpsToUtc(week, secondsOfWeek) {
  // GPS 时间起始点: 1980年1月6日 00:00:00 UTC
  const gpsEpoch = new Date(Date.UTC(1980, 0, 6, 0, 0, 0));
  
  // 计算总秒数
  const totalSeconds = week * 604800 + secondsOfWeek;
  
  // GPS 时间与 UTC 的偏差（闰秒）- 当前为 18 秒
  const leapSeconds = 18;
  
  // 计算 UTC 时间
  const utcTime = new Date(gpsEpoch.getTime() + (totalSeconds - leapSeconds) * 1000);
  
  return utcTime;
}

// 将 "YYYY/MM/DD" 和 "HH:MM:SS.sss"（GPST）转换为 UTC Date
function gpstDateTimeToUtc(dateStr, timeStr) {
  try {
    const [y, m, d] = dateStr.split('/').map(n => parseInt(n, 10));
    const [hh, mm, ssms] = timeStr.split(':');
    const h = parseInt(hh, 10);
    const mi = parseInt(mm, 10);
    const s = parseFloat(ssms);
    const sec = Math.floor(s);
    const ms = Math.round((s - sec) * 1000);
    const gpst = new Date(Date.UTC(y, (m || 1) - 1, d || 1, h || 0, mi || 0, sec || 0, ms || 0));
    const leapSeconds = 18;
    return new Date(gpst.getTime() - leapSeconds * 1000);
  } catch (e) {
    return new Date();
  }
}

// 从 LLH 计算 ECEF（WGS84）
function llhToEcef(latDeg, lonDeg, heightMeters) {
  const a = 6378137.0; // 半长轴
  const f = 1 / 298.257223563; // 扁率
  const e2 = f * (2 - f); // 第一偏心率平方
  
  const lat = latDeg * Math.PI / 180.0;
  const lon = lonDeg * Math.PI / 180.0;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  
  const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  
  const x = (N + heightMeters) * cosLat * cosLon;
  const y = (N + heightMeters) * cosLat * sinLon;
  const z = (N * (1 - e2) + heightMeters) * sinLat;
  
  return { x, y, z };
}

// 解析 RTKRCV 输出数据
function parseRtkcrvOutput(data) {
  const lines = data.trim().split('\n').filter(Boolean);
  
  try {
    // 支持仅 LLH 单行：从 LLH 反算 ECEF 并完成解算
    if (lines.length === 1) {
      const p = lines[0].trim().split(/\s+/);
      log('debug', `LLH-only parts count: ${p.length}, data: ${lines[0].substring(0, 150)}`);
      
      if (p.length < 6) {
        log('warn', `Parse failed: LLH-only line has only ${p.length} fields (need >= 6)`);
        return null;
      }
      
      let lat, lon, height, q, ns, stationId, utcTime;
      
      // 两种格式：
      // A) gpsWeek gpsSeconds lat lon height q ns ... stationId
      // B) YYYY/MM/DD HH:MM:SS.sss lat lon height q ns ... stationId  （GPST）
      if (p[0].includes('/')) {
        // 格式B：日期+时间开头
        const dateStr = p[0];
        const timeStr = p[1];
        lat = parseFloat(p[2]);
        lon = parseFloat(p[3]);
        height = parseFloat(p[4]);
        q = parseInt(p[5]);
        ns = parseInt(p[6]);
        stationId = p[p.length - 1];
        if ([lat, lon, height].some(v => Number.isNaN(v))) {
          log('error', `Parse failed: invalid LLH-only (date-time) values`);
          return null;
        }
        utcTime = gpstDateTimeToUtc(dateStr, timeStr);
      } else {
        // 格式A：周+周内秒开头
        const gpsWeek = parseInt(p[0]);
        const gpsSecondsOfWeek = parseFloat(p[1]);
        lat = parseFloat(p[2]);
        lon = parseFloat(p[3]);
        height = parseFloat(p[4]);
        q = parseInt(p[5]);
        ns = parseInt(p[6]);
        stationId = p[p.length - 1];
        if ([gpsWeek, gpsSecondsOfWeek, lat, lon, height].some(v => Number.isNaN(v))) {
          log('error', `Parse failed: invalid LLH-only (week+sec) values`);
          return null;
        }
        utcTime = gpsToUtc(gpsWeek, gpsSecondsOfWeek);
      }
      
      const ecef = llhToEcef(lat, lon, height);
      const statusText = q === 1 ? '固定解' : q === 2 ? '浮点解' : q === 4 ? 'DGPS' : q === 5 ? '单点' : '未知';
      // 尝试从倒数第二个字段提取“模糊度”，例如样例中的 1.1
      let ambiguityVal = null;
      const maybeAmb = parseFloat(p[p.length - 2]);
      if (!Number.isNaN(maybeAmb)) {
        ambiguityVal = parseFloat(maybeAmb.toFixed(1));
      }
      
      return {
        stationId: stationId,
        timestamp: utcTime.toISOString(),
        dateTime: utcTime.toLocaleString('zh-CN', { 
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }),
        ecef: {
          x: ecef.x.toFixed(4),
          y: ecef.y.toFixed(4),
          z: ecef.z.toFixed(4),
          dateTime: `${utcTime.getUTCFullYear()}/${String(utcTime.getUTCMonth()+1).padStart(2,'0')}/${String(utcTime.getUTCDate()).padStart(2,'0')} ` +
                    `${String(utcTime.getUTCHours()).padStart(2,'0')}:${String(utcTime.getUTCMinutes()).padStart(2,'0')}:${String(utcTime.getUTCSeconds()).padStart(2,'0')}`
        },
        llh: {
          lat: lat.toFixed(9),
          lon: lon.toFixed(9),
          height: height.toFixed(4)
        },
        quality: {
          status: q,
          statusText: statusText,
          satellites: ns,
          ambiguity: ambiguityVal
        }
      };
    }
    
    // 解析 ECEF 行
    const ecefParts = lines[0].trim().split(/\s+/);
    log('debug', `ECEF parts count: ${ecefParts.length}, data: ${lines[0].substring(0, 150)}`);
    
    if (ecefParts.length < 10) {
      log('warn', `Parse failed: ECEF line has only ${ecefParts.length} fields (need >= 10)`);
      return null;
    }
    
    const ecefDate = ecefParts[0];
    const ecefTime = ecefParts[1];
    const x = parseFloat(ecefParts[2]);
    const y = parseFloat(ecefParts[3]);
    const z = parseFloat(ecefParts[4]);
    const q = parseInt(ecefParts[5]); // 解算状态: 1=固定解, 2=浮点解
    const ns = parseInt(ecefParts[6]); // 卫星数
    const stationId = ecefParts[ecefParts.length - 1]; // 站点编号
    // 从 ECEF 行提取模糊度（倒数第二个字段）
    const ambiguityRaw = ecefParts[ecefParts.length - 2];
    const ambiguityVal = parseFloat(ambiguityRaw);
    
    // 解析 LLH 行
    const llhParts = lines[1].trim().split(/\s+/);
    log('debug', `LLH parts count: ${llhParts.length}, data: ${lines[1].substring(0, 150)}`);
    
    if (llhParts.length < 10) {
      log('warn', `Parse failed: LLH line has only ${llhParts.length} fields (need >= 10)`);
      return null;
    }
    
    const gpsWeek = parseInt(llhParts[0]);
    const gpsSecondsOfWeek = parseFloat(llhParts[1]);
    const lat = parseFloat(llhParts[2]); // 纬度
    const lon = parseFloat(llhParts[3]); // 经度
    const height = parseFloat(llhParts[4]); // 高度
    
    // 验证解析的数据
    if (isNaN(x) || isNaN(y) || isNaN(z) || isNaN(lat) || isNaN(lon)) {
      log('error', `Parse failed: invalid coordinate values`);
      return null;
    }
    
    // 转换 GPS 时间为 UTC 时间
    const utcTime = gpsToUtc(gpsWeek, gpsSecondsOfWeek);
    
    // 解算状态文本
    const statusText = q === 1 ? '固定解' : q === 2 ? '浮点解' : q === 4 ? 'DGPS' : q === 5 ? '单点' : '未知';
    
    log('debug', `Parse success: Station ${stationId}, Status: ${statusText}, Sats: ${ns}`);
    
    return {
      stationId: stationId,
      timestamp: utcTime.toISOString(),
      dateTime: utcTime.toLocaleString('zh-CN', { 
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }),
      ecef: {
        x: x.toFixed(4),
        y: y.toFixed(4),
        z: z.toFixed(4),
        dateTime: `${ecefDate} ${ecefTime}`
      },
      llh: {
        lat: lat.toFixed(9),
        lon: lon.toFixed(9),
        height: height.toFixed(4),
        gpsWeek: gpsWeek,
        gpsSeconds: gpsSecondsOfWeek.toFixed(3)
      },
      quality: {
        status: q,
        statusText: statusText,
        satellites: ns,
        ambiguity: isNaN(ambiguityVal) ? null : parseFloat(ambiguityVal.toFixed(1))
      }
    };
  } catch (error) {
    log('error', `Error parsing RTKRCV output: ${error.message}, Stack: ${error.stack}`);
    log('debug', `Failed data: ${data}`);
    return null;
  }
}

// 启动 TCP 服务器监听 60000 端口
function startTcpServer() {
  if (tcpServer) {
    log('warn', 'TCP server already running');
    return;
  }
  
  tcpServer = net.createServer((socket) => {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    log('info', `TCP client connected: ${clientId}`);
    
    tcpClients.set(clientId, socket);
    
    let buffer = '';
    
    socket.on('data', (data) => {
      const rawData = data.toString();
      buffer += rawData;
      
      // 记录接收到的原始数据（用于调试）
      log('debug', `Received TCP data (${rawData.length} bytes): ${rawData.substring(0, 200)}...`);
      
      // 处理完整的数据包
      const lines = buffer.split('\n');
      
      // 保留最后可能不完整的数据
      buffer = lines.pop() || '';
      
      // 处理所有完整的行
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        if (!line) continue; // 跳过空行
        
        const parts = line.split(/\s+/);
        
        if (parts.length < 7) {
          log('warn', `Skipping invalid line (too few fields): ${line}`);
          continue;
        }
        
        // 提取站点 ID（最后一个字段）
        const stationId = parts[parts.length - 1];
        
        // 判断是否为日期时间开头的行（可能是 ECEF 也可能是 LLH）
        if (parts[0].includes('/')) {
          // 判断第三、四、五列是否像经纬高
          const v2 = parseFloat(parts[2]);
          const v3 = parseFloat(parts[3]);
          const v4 = parseFloat(parts[4]);
          const looksLikeLLH = ![v2, v3, v4].some(Number.isNaN) && Math.abs(v2) <= 90 && Math.abs(v3) <= 180 && Math.abs(v4) < 20000;
          
          if (looksLikeLLH) {
            // 直接按 LLH-only 解析
            const parsedData = parseRtkcrvOutput(line);
            if (parsedData) {
              writeDataLog(parsedData, line);
              const stabilityCheck = checkStationStability(parsedData.stationId, parsedData);
              parsedData.stability = {
                stable: stabilityCheck.stable,
                collecting: stabilityCheck.collecting || false,
                elapsed: stabilityCheck.elapsed || 0,
                sampleCount: stabilityCheck.sampleCount || 0
              };
              if (stabilityCheck.stable && stabilityCheck.average) {
                parsedData.average = stabilityCheck.average;
              }
              latestData.set(parsedData.stationId, parsedData);
              if (!stabilityCheck.stable || stabilityCheck.elapsed === undefined) {
                broadcastToSSE({ type: 'rtkrcv_data', data: parsedData });
              }
              log('info', `✅(LLH-only) Station ${parsedData.stationId}: ${parsedData.quality.statusText}, Sats: ${parsedData.quality.satellites}, Lat: ${parsedData.llh.lat}, Lon: ${parsedData.llh.lon}`);
            } else {
              log('error', `❌ Failed to parse LLH-only (date-time) for station ${stationId}`);
            }
          } else {
            // 视为 ECEF 行 - 缓存等待 LLH
            ecefCache.set(stationId, {
              line: line,
              timestamp: Date.now()
            });
            log('debug', `📐 Cached ECEF line for station ${stationId}: ${line.substring(0, 100)}`);
          }
        }
        // 判断是否是 LLH 行（纯数字开头：gpsWeek gpsSeconds ...）
        else if (!isNaN(parseInt(parts[0])) && !isNaN(parseFloat(parts[1]))) {
          // LLH 行 - 查找对应的 ECEF 行
          const cachedEcef = ecefCache.get(stationId);
          
          if (cachedEcef) {
            // 找到配对的 ECEF 行，组合解析
            const dataPacket = cachedEcef.line + '\n' + line;
            log('debug', `🔗 Pairing ECEF+LLH for station ${stationId}`);
            
            const parsedData = parseRtkcrvOutput(dataPacket);
            
            if (parsedData) {
              // 写入数据流日志
              writeDataLog(parsedData, dataPacket);
              
              // 检查站点稳定性
              const stabilityCheck = checkStationStability(parsedData.stationId, parsedData);
              
              // 添加稳定性信息到数据中
              parsedData.stability = {
                stable: stabilityCheck.stable,
                collecting: stabilityCheck.collecting || false,
                elapsed: stabilityCheck.elapsed || 0,
                sampleCount: stabilityCheck.sampleCount || 0
              };
              
              // 如果已稳定，添加平均值
      if (stabilityCheck.stable && stabilityCheck.average) {
                parsedData.average = stabilityCheck.average;
              }
              
              // 缓存最新数据（包含稳定性信息）
              latestData.set(parsedData.stationId, parsedData);
              
              // 只有在未稳定或刚稳定时才推送实时数据
              if (!stabilityCheck.stable || stabilityCheck.elapsed === undefined) {
                broadcastToSSE({
                  type: 'rtkrcv_data',
                  data: parsedData
                });
              }
              
              log('info', `✅ Station ${parsedData.stationId}: ${parsedData.quality.statusText}, Sats: ${parsedData.quality.satellites}, Lat: ${parsedData.llh.lat}, Lon: ${parsedData.llh.lon}`);
              
              // 清除已使用的 ECEF 缓存
              ecefCache.delete(stationId);
            } else {
              log('error', `❌ Failed to parse data packet for station ${stationId}`);
            }
          } else {
            // 无 ECEF，仅 LLH 单行模式：直接解析并解算
            log('info', `ℹ️ LLH-only received for station ${stationId}, proceeding without ECEF`);
            const parsedData = parseRtkcrvOutput(line);
            if (parsedData) {
              // 写入数据流日志（仅原始一行）
              writeDataLog(parsedData, line);
              
              // 稳定性检测
              const stabilityCheck = checkStationStability(parsedData.stationId, parsedData);
              
              parsedData.stability = {
                stable: stabilityCheck.stable,
                collecting: stabilityCheck.collecting || false,
                elapsed: stabilityCheck.elapsed || 0,
                sampleCount: stabilityCheck.sampleCount || 0
              };
              
              if (stabilityCheck.stable && stabilityCheck.average) {
                parsedData.average = stabilityCheck.average;
              }
              
              latestData.set(parsedData.stationId, parsedData);
              
              if (!stabilityCheck.stable || stabilityCheck.elapsed === undefined) {
                broadcastToSSE({
                  type: 'rtkrcv_data',
                  data: parsedData
                });
              }
              
              log('info', `✅(LLH-only) Station ${parsedData.stationId}: ${parsedData.quality.statusText}, Sats: ${parsedData.quality.satellites}, Lat: ${parsedData.llh.lat}, Lon: ${parsedData.llh.lon}`);
            } else {
              log('error', `❌ Failed to parse LLH-only line for station ${stationId}`);
            }
          }
        } else {
          log('debug', `Skipping unknown line format: ${line.substring(0, 50)}`);
        }
      }
      
      // 清理超过 10 秒的旧 ECEF 缓存
      const now = Date.now();
      ecefCache.forEach((value, key) => {
        if (now - value.timestamp > 10000) {
          log('debug', `Clearing stale ECEF cache for station ${key}`);
          ecefCache.delete(key);
        }
      });
    });
    
    socket.on('end', () => {
      log('info', `TCP client disconnected: ${clientId}`);
      tcpClients.delete(clientId);
    });
    
    socket.on('error', (err) => {
      log('error', `TCP client error ${clientId}: ${err.message}`);
      tcpClients.delete(clientId);
    });
  });
  
  tcpServer.listen(60000, '0.0.0.0', () => {
    log('info', '📡 TCP server listening on port 60000 for RTKRCV output');
  });
  
  tcpServer.on('error', (err) => {
    log('error', `TCP server error: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      log('warn', 'Port 60000 is already in use, waiting 5 seconds to retry...');
      setTimeout(startTcpServer, 5000);
    }
  });
}

// 广播消息到所有 SSE 客户端
function broadcastToSSE(message) {
  const data = `data: ${JSON.stringify(message)}\n\n`;
  sseClients.forEach((client, id) => {
    try {
      client.write(data);
    } catch (error) {
      log('error', `Error sending to SSE client ${id}: ${error.message}`);
      sseClients.delete(id);
    }
  });
}

// 根据站点 ID 停止 RTKRCV 进程
function stopRtkcrvByStationId(stationId) {
  // 查找包含该站点 ID 的配置文件
  const configFile = `${stationId}.conf`;
  const processInfo = runningProcesses.get(configFile);
  
  if (processInfo) {
    try {
      processInfo.process.kill();
      log('info', `🛑 Station ${stationId}: 已达到稳定，自动关闭 RTKRCV (PID: ${processInfo.pid})`);
      
      // 推送关闭通知到前端
      broadcastToSSE({
        type: 'rtkrcv_auto_stopped',
        data: {
          stationId: stationId,
          configFile: configFile,
          reason: 'stable',
          message: `站点 ${stationId} 已达到稳定状态，RTKRCV 已自动关闭`
        }
      });
      
      return true;
    } catch (error) {
      log('error', `Error stopping RTKRCV for station ${stationId}: ${error.message}`);
      return false;
    }
  } else {
    log('warn', `Cannot stop RTKRCV for station ${stationId}: process not found (config: ${configFile})`);
    return false;
  }
}

// 检查并更新站点稳定性（容错版）
function checkStationStability(stationId, data) {
  const isFixed = data.quality.status === 1; // 1 = 固定解

  let stability = stationStability.get(stationId);

  // 仅在首次出现固定解时开始收集；若当前为浮点且尚未开始，则不创建状态
  if (!stability) {
    if (!isFixed) {
      return { stable: false, collecting: false };
    }
    stability = {
      status: 'collecting',
      startTime: new Date(),
      samples: [],
      average: null,
      // 容错累计
      lastSampleTimeMs: null,
      accumulatedFixedSeconds: 0,
      nonFixedStreakSeconds: 0
    };
    stationStability.set(stationId, stability);
    log('info', `🎯 Station ${stationId}: 检测到固定解，开始收集（容错模式）`);
  }

  // 计算本次样本与上次样本的时间间隔（秒），限制最大间隔，避免时间戳异常
  const currentTimeMs = Date.now();
  let deltaSeconds = 0;
  if (stability.lastSampleTimeMs) {
    deltaSeconds = (currentTimeMs - stability.lastSampleTimeMs) / 1000;
    if (deltaSeconds < 0) deltaSeconds = 0; // 防护
    if (deltaSeconds > config.maxSampleIntervalSeconds) {
      deltaSeconds = config.maxSampleIntervalSeconds;
    }
  }
  stability.lastSampleTimeMs = currentTimeMs;

  // 收集样本（仅在固定时计入）
  if (isFixed) {
    stability.samples.push({
      ecef: {
        x: parseFloat(data.ecef.x),
        y: parseFloat(data.ecef.y),
        z: parseFloat(data.ecef.z)
      },
      llh: {
        lat: parseFloat(data.llh.lat),
        lon: parseFloat(data.llh.lon),
        height: parseFloat(data.llh.height)
      },
      timestamp: new Date(data.timestamp),
      satellites: data.quality.satellites
    });
    stability.accumulatedFixedSeconds += deltaSeconds || 1; // 首个样本按1秒计
    stability.nonFixedStreakSeconds = 0;
  } else {
    // 非固定，若已开始收集则增加非固定连续秒数；未开始的情况在前面已返回
    stability.nonFixedStreakSeconds += deltaSeconds || 1;
    // 若超过容忍阈值，则重置收集
    if (stability.nonFixedStreakSeconds > config.nonFixedToleranceSeconds) {
      log('warn', `⚠️  Station ${stationId}: 非固定超过容忍(${config.nonFixedToleranceSeconds}s)，重置收集。已累计固定 ${stability.accumulatedFixedSeconds.toFixed(1)}s，样本 ${stability.samples.length}`);
      stationStability.delete(stationId);
      return { stable: false, collecting: false };
    }
  }

  // 判定是否达到稳定
  if (stability.status === 'collecting') {
    const required = config.stabilityRequiredSeconds;
    if (stability.accumulatedFixedSeconds >= required) {
      const average = calculateAverage(stability.samples);
      stability.average = average;
      stability.status = 'stable';
      stability.endTime = new Date();

      log('info', `✅ Station ${stationId}: 达到稳定状态（容错）。累计固定 ${stability.accumulatedFixedSeconds.toFixed(1)}s，样本数: ${stability.samples.length}`);

      broadcastToSSE({
        type: 'station_stable',
        data: {
          stationId: stationId,
          average: average,
          sampleCount: stability.samples.length,
          duration: stability.accumulatedFixedSeconds.toFixed(1),
          startTime: stability.startTime.toISOString(),
          endTime: stability.endTime.toISOString()
        }
      });

      setTimeout(() => {
        stopRtkcrvByStationId(stationId);
      }, 2000);

      return { stable: true, average: average };
    } else {
      log('debug', `📊 Station ${stationId}: 收集中 ${stability.accumulatedFixedSeconds.toFixed(1)}s / ${required}s, 样本数: ${stability.samples.length}, 非固定连续 ${stability.nonFixedStreakSeconds.toFixed(1)}s`);
      return { stable: false, collecting: true, elapsed: stability.accumulatedFixedSeconds, sampleCount: stability.samples.length };
    }
  }

  // 已稳定
  return { stable: true, average: stability.average };
}

// 计算样本均值（优化版：去除误差最大的2个样本）
function calculateAverage(samples) {
  if (samples.length === 0) return null;
  
  // 如果样本数量少于等于3个，不去除任何样本（至少保留1个样本）
  if (samples.length <= 3) {
    log('warn', `样本数量不足 (${samples.length}个)，不进行异常值过滤`);
    return calculateAverageInternal(samples);
  }
  
  // 步骤1：计算初步平均值（使用所有样本）
  const preliminaryMean = calculateAverageInternal(samples);
  
  // 步骤2：计算每个样本到平均值的距离
  const samplesWithDistance = samples.map((sample, index) => {
    // 计算ECEF坐标的欧氏距离
    const dx = sample.ecef.x - parseFloat(preliminaryMean.ecef.x);
    const dy = sample.ecef.y - parseFloat(preliminaryMean.ecef.y);
    const dz = sample.ecef.z - parseFloat(preliminaryMean.ecef.z);
    const ecefDistance = Math.sqrt(dx*dx + dy*dy + dz*dz);
    
    // 计算LLH坐标的距离（归一化后的距离）
    const dlat = (sample.llh.lat - parseFloat(preliminaryMean.llh.lat)) * 111320; // 1度纬度约111km
    const dlon = (sample.llh.lon - parseFloat(preliminaryMean.llh.lon)) * 111320 * Math.cos(sample.llh.lat * Math.PI / 180);
    const dheight = sample.llh.height - parseFloat(preliminaryMean.llh.height);
    const llhDistance = Math.sqrt(dlat*dlat + dlon*dlon + dheight*dheight);
    
    // 使用ECEF距离作为主要依据（更准确）
    return {
      sample: sample,
      distance: ecefDistance,
      llhDistance: llhDistance,
      index: index
    };
  });
  
  // 步骤3：按距离排序，找出最大的2个
  samplesWithDistance.sort((a, b) => b.distance - a.distance);
  
  // 记录被移除的样本
  const removed1 = samplesWithDistance[0];
  const removed2 = samplesWithDistance[1];
  
  log('info', `🔍 异常值检测: 移除误差最大的2个样本`);
  log('info', `  ❌ 样本#${removed1.index + 1}: ECEF距离=${removed1.distance.toFixed(4)}m, LLH距离=${removed1.llhDistance.toFixed(4)}m`);
  log('info', `  ❌ 样本#${removed2.index + 1}: ECEF距离=${removed2.distance.toFixed(4)}m, LLH距离=${removed2.llhDistance.toFixed(4)}m`);
  
  // 步骤4：去除最大的2个样本
  const filteredSamples = samplesWithDistance.slice(2).map(item => item.sample);
  
  log('info', `✅ 保留样本数: ${filteredSamples.length} / ${samples.length}`);
  
  // 步骤5：使用过滤后的样本计算最终平均值
  const finalAverage = calculateAverageInternal(filteredSamples);
  
  // 添加过滤信息
  finalAverage.filtered = true;
  finalAverage.originalSampleCount = samples.length;
  finalAverage.removedSampleCount = 2;
  finalAverage.removedSamples = [
    {
      index: removed1.index + 1,
      ecefDistance: removed1.distance.toFixed(4),
      llhDistance: removed1.llhDistance.toFixed(4)
    },
    {
      index: removed2.index + 1,
      ecefDistance: removed2.distance.toFixed(4),
      llhDistance: removed2.llhDistance.toFixed(4)
    }
  ];
  
  return finalAverage;
}

// 内部函数：直接计算平均值（不过滤异常值）
function calculateAverageInternal(samples) {
  if (samples.length === 0) return null;
  
  const sum = samples.reduce((acc, sample) => {
    return {
      ecef: {
        x: acc.ecef.x + sample.ecef.x,
        y: acc.ecef.y + sample.ecef.y,
        z: acc.ecef.z + sample.ecef.z
      },
      llh: {
        lat: acc.llh.lat + sample.llh.lat,
        lon: acc.llh.lon + sample.llh.lon,
        height: acc.llh.height + sample.llh.height
      },
      satellites: acc.satellites + sample.satellites
    };
  }, {
    ecef: { x: 0, y: 0, z: 0 },
    llh: { lat: 0, lon: 0, height: 0 },
    satellites: 0
  });
  
  const count = samples.length;
  
  // 计算平均值
  const mean = {
    ecef: {
      x: sum.ecef.x / count,
      y: sum.ecef.y / count,
      z: sum.ecef.z / count
    },
    llh: {
      lat: sum.llh.lat / count,
      lon: sum.llh.lon / count,
      height: sum.llh.height / count
    }
  };
  
  // 计算标准差
  const stdDev = calculateStdDev(samples, mean);
  
  return {
    ecef: {
      x: mean.ecef.x.toFixed(4),
      y: mean.ecef.y.toFixed(4),
      z: mean.ecef.z.toFixed(4)
    },
    llh: {
      lat: mean.llh.lat.toFixed(9),
      lon: mean.llh.lon.toFixed(9),
      height: mean.llh.height.toFixed(4)
    },
    satellites: Math.round(sum.satellites / count),
    sampleCount: count,
    stdDev: stdDev
  };
}

// 计算标准差
function calculateStdDev(samples, mean) {
  if (samples.length < 2) return null;
  
  const variance = samples.reduce((acc, sample) => {
    return {
      ecef: {
        x: acc.ecef.x + Math.pow(sample.ecef.x - mean.ecef.x, 2),
        y: acc.ecef.y + Math.pow(sample.ecef.y - mean.ecef.y, 2),
        z: acc.ecef.z + Math.pow(sample.ecef.z - mean.ecef.z, 2)
      },
      llh: {
        lat: acc.llh.lat + Math.pow(sample.llh.lat - mean.llh.lat, 2),
        lon: acc.llh.lon + Math.pow(sample.llh.lon - mean.llh.lon, 2),
        height: acc.llh.height + Math.pow(sample.llh.height - mean.llh.height, 2)
      }
    };
  }, {
    ecef: { x: 0, y: 0, z: 0 },
    llh: { lat: 0, lon: 0, height: 0 }
  });
  
  const count = samples.length;
  
  return {
    ecef: {
      x: Math.sqrt(variance.ecef.x / count).toFixed(4),
      y: Math.sqrt(variance.ecef.y / count).toFixed(4),
      z: Math.sqrt(variance.ecef.z / count).toFixed(4)
    },
    llh: {
      lat: Math.sqrt(variance.llh.lat / count).toFixed(9),
      lon: Math.sqrt(variance.llh.lon / count).toFixed(9),
      height: Math.sqrt(variance.llh.height / count).toFixed(4)
    }
  };
}

// 写入数据流日志（合并到进程日志）
function writeDataLog(parsedData, rawData) {
  try {
    const stationId = parsedData.stationId;
    const configFile = `${stationId}.conf`;
    
    // 查找对应的RTKRCV进程
    const processInfo = runningProcesses.get(configFile);
    
    if (processInfo && processInfo.logStream) {
      // 格式化日志内容
      const logEntry = `\n[TCP数据流] ${parsedData.dateTime} - ${parsedData.quality.statusText} (${parsedData.quality.satellites}颗卫星)\n` +
                       `  ECEF: X=${parsedData.ecef.x} Y=${parsedData.ecef.y} Z=${parsedData.ecef.z}\n` +
                       `  LLH:  Lat=${parsedData.llh.lat}° Lon=${parsedData.llh.lon}° H=${parsedData.llh.height}m\n` +
                       `  原始数据:\n${rawData}\n`;
      
      processInfo.logStream.write(logEntry);
    } else {
      // 如果进程不存在，直接追加到日志文件
      const logFileName = `${stationId}.log`;
      const logPath = path.join(config.generatedDir, logFileName);
      
      if (fs.existsSync(logPath)) {
        const logEntry = `\n[TCP数据流] ${parsedData.dateTime} - ${parsedData.quality.statusText} (${parsedData.quality.satellites}颗卫星)\n` +
                         `  ECEF: X=${parsedData.ecef.x} Y=${parsedData.ecef.y} Z=${parsedData.ecef.z}\n` +
                         `  LLH:  Lat=${parsedData.llh.lat}° Lon=${parsedData.llh.lon}° H=${parsedData.llh.height}m\n` +
                         `  原始数据:\n${rawData}\n`;
        
        fs.appendFileSync(logPath, logEntry);
      }
    }
  } catch (error) {
    log('error', `Error writing data log: ${error.message}`);
  }
}

// 生成配置文件
app.post('/api/generate-config', (req, res) => {
  try {
    const { inpstr1, inpstr2, inpstr3, outHeight } = req.body;
    
    // 验证输入
    if (!inpstr1 || !inpstr2 || !inpstr3 || outHeight === undefined) {
      log('warn', 'Missing required fields in request');
      return res.status(400).json({ 
        success: false, 
        message: '请填写所有必需字段' 
      });
    }

    // 读取模板
    let configContent = readTemplate();
    
    // 替换配置项
    configContent = configContent.replace(/^inpstr1-path\s*=.*$/m, `inpstr1-path       =${inpstr1}`);
    configContent = configContent.replace(/^inpstr2-path\s*=.*$/m, `inpstr2-path       =${inpstr2}`);
    configContent = configContent.replace(/^inpstr3-path\s*=.*$/m, `inpstr3-path       =${inpstr3}`);
    configContent = configContent.replace(/^out-height\s*=.*$/m, `out-height         =${outHeight}   # (0:ellipsoidal,1:geodetic)`);
    
    // 同时更新输出文件路径，使用挂载点命名
    const mountPoint = extractMountPoint(inpstr1);
    configContent = configContent.replace(/^outstr1-path\s*=.*$/m, `outstr1-path       =127.0.0.1:60000`);
    configContent = configContent.replace(/^outstr2-path\s*=.*$/m, `outstr2-path       =127.0.0.1:60000`);
    
    // 生成文件名
    const fileName = `${mountPoint}.conf`;
    const filePath = path.join(config.generatedDir, fileName);
    
    // 确保 generated 目录存在
    ensureDirectories();
    
    // 写入文件
    fs.writeFileSync(filePath, configContent, 'utf-8');
    log('info', `Generated config file: ${fileName}`);
    
    res.json({ 
      success: true, 
      message: `配置文件已生成: ${fileName}`,
      fileName: fileName,
      content: configContent
    });
    
  } catch (error) {
    log('error', `Error generating config: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: '生成配置文件时出错: ' + error.message 
    });
  }
});

// 下载配置文件
app.get('/api/download/:filename', (req, res) => {
  try {
    const fileName = req.params.filename;
    const filePath = path.join(config.generatedDir, fileName);
    
    if (!fs.existsSync(filePath)) {
      log('warn', `File not found: ${fileName}`);
      return res.status(404).json({ 
        success: false, 
        message: '文件不存在' 
      });
    }
    
    log('info', `Downloading file: ${fileName}`);
    res.download(filePath, fileName);
  } catch (error) {
    log('error', `Error downloading file: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: '下载文件时出错' 
    });
  }
});

// 获取已生成的配置文件列表
app.get('/api/configs', (req, res) => {
  try {
    ensureDirectories();
    
    if (!fs.existsSync(config.generatedDir)) {
      return res.json({ success: true, files: [] });
    }
    
    const files = fs.readdirSync(config.generatedDir)
      .filter(file => file.toLowerCase().endsWith('.conf'))
      .map(file => {
        try {
          const stationId = file.toLowerCase().endsWith('.conf') ? file.slice(0, -5) : file;
          const stats = fs.statSync(path.join(config.generatedDir, file));
          
          // 检查是否存在日志文件
          const logCandidates = [
            `${stationId}.log`,
            `${stationId}.LOG`
          ];
          const logFilePath = logCandidates.map(n => path.join(config.generatedDir, n)).find(p => fs.existsSync(p));
          const logFile = logFilePath ? path.basename(logFilePath) : null;
          
          return {
            name: file,
            created: stats.mtime,
            logFile: logFile
          };
        } catch (e) {
          log('warn', `Skipping file due to error: ${file} - ${e.message}`);
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.created - a.created);
    
    res.json({ success: true, files });
  } catch (error) {
    log('error', `Error listing configs: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: '获取文件列表时出错' 
    });
  }
});

// 删除配置文件
app.delete('/api/config/delete/:filename', (req, res) => {
  try {
    const fileName = req.params.filename;
    const filePath = path.join(config.generatedDir, fileName);
    
    // 验证文件名（防止目录遍历攻击）
    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      return res.status(400).json({
        success: false,
        message: '非法的文件名'
      });
    }
    
    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: '配置文件不存在'
      });
    }
    
    // 检查是否有正在运行的进程使用此配置
    if (runningProcesses.has(fileName)) {
      return res.status(400).json({
        success: false,
        message: '该配置文件正在被使用中，请先停止相关的 RTKRCV 进程'
      });
    }
    
    // 删除配置文件
    fs.unlinkSync(filePath);
    log('info', `Deleted config file: ${fileName}`);

    // 同名日志文件也删除（如果存在）
    const stationId = fileName.replace('.conf', '');
    const logFile = `${stationId}.log`;
    const logPath = path.join(config.generatedDir, logFile);
    if (fs.existsSync(logPath)) {
      // 确保没有相关进程在使用
      if (!runningProcesses.has(fileName)) {
        try {
          fs.unlinkSync(logPath);
          log('info', `Deleted related log file: ${logFile}`);
        } catch (e) {
          log('warn', `Failed to delete related log file ${logFile}: ${e.message}`);
        }
      }
    }
    
    res.json({
      success: true,
      message: `配置文件 ${fileName} 已删除`
    });
    
  } catch (error) {
    log('error', `Error deleting config file: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '删除文件时出错: ' + error.message
    });
  }
});

// 删除日志文件
app.delete('/api/log/delete/:filename', (req, res) => {
  try {
    const fileName = req.params.filename;
    const filePath = path.join(config.generatedDir, fileName);
    
    // 验证文件名（防止目录遍历攻击）
    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      return res.status(400).json({
        success: false,
        message: '非法的文件名'
      });
    }
    
    // 只允许删除.log文件
    if (!fileName.endsWith('.log')) {
      return res.status(400).json({
        success: false,
        message: '只能删除日志文件'
      });
    }
    
    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: '日志文件不存在'
      });
    }
    
    // 检查是否有正在使用此日志的进程
    const stationId = fileName.replace('.log', '');
    const configFile = `${stationId}.conf`;
    if (runningProcesses.has(configFile)) {
      return res.status(400).json({
        success: false,
        message: '该日志文件正在被使用中，请先停止相关的 RTKRCV 进程'
      });
    }
    
    // 删除文件
    fs.unlinkSync(filePath);
    log('info', `Deleted log file: ${fileName}`);
    
    res.json({
      success: true,
      message: `日志文件 ${fileName} 已删除`
    });
    
  } catch (error) {
    log('error', `Error deleting log file: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '删除日志文件时出错: ' + error.message
    });
  }
});

// 获取所有稳定结果
app.get('/api/stable-results', (req, res) => {
  try {
    const results = readStableResults();
    res.json({
      success: true,
      results: results,
      count: results.length
    });
  } catch (error) {
    log('error', `Error getting stable results: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '获取稳定结果失败: ' + error.message
    });
  }
});

// 保存新的稳定结果
app.post('/api/stable-results', (req, res) => {
  try {
    const newResult = req.body;
    
    // 验证必需字段
    const requiredFields = ['stationId', 'ecef_x', 'ecef_y', 'ecef_z', 'lat', 'lon', 'height'];
    const missingFields = requiredFields.filter(field => !newResult[field]);
    
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `缺少必需字段: ${missingFields.join(', ')}`
      });
    }
    
    // 读取现有结果
    const results = readStableResults();
    
    // 去重检查：检查是否已存在相同站点在最近60秒内的记录
    const now = Date.now();
    const duplicateThreshold = 60000; // 60秒内认为是重复
    
    const isDuplicate = results.some(existing => {
      if (existing.stationId !== newResult.stationId) {
        return false;
      }
      
      // 检查时间差
      const existingTime = new Date(existing.timestamp).getTime();
      const timeDiff = Math.abs(now - existingTime);
      
      if (timeDiff < duplicateThreshold) {
        log('warn', `Duplicate stable result detected for station ${newResult.stationId} (time diff: ${(timeDiff/1000).toFixed(1)}s), skipping save`);
        return true;
      }
      return false;
    });
    
    if (isDuplicate) {
      return res.json({
        success: true,
        message: '稳定结果已存在（跳过重复保存）',
        duplicate: true
      });
    }
    
    // 添加ID和时间戳
    newResult.id = `${newResult.stationId}_${Date.now()}`;
    if (!newResult.timestamp) {
      newResult.timestamp = new Date().toISOString();
    }
    
    // 添加到列表
    results.unshift(newResult); // 新记录在最前面
    
    // 保存
    if (writeStableResults(results)) {
      log('info', `Saved stable result for station ${newResult.stationId}`);
      res.json({
        success: true,
        message: '稳定结果已保存',
        id: newResult.id
      });
    } else {
      res.status(500).json({
        success: false,
        message: '保存失败'
      });
    }
  } catch (error) {
    log('error', `Error saving stable result: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '保存稳定结果失败: ' + error.message
    });
  }
});

// 删除稳定结果
app.delete('/api/stable-results/:id', (req, res) => {
  try {
    const id = req.params.id;
    
    // 读取现有结果
    let results = readStableResults();
    
    // 查找并删除
    const initialLength = results.length;
    results = results.filter(r => r.id !== id);
    
    if (results.length === initialLength) {
      return res.status(404).json({
        success: false,
        message: '未找到该记录'
      });
    }
    
    // 保存
    if (writeStableResults(results)) {
      log('info', `Deleted stable result: ${id}`);
      res.json({
        success: true,
        message: '记录已删除'
      });
    } else {
      res.status(500).json({
        success: false,
        message: '删除失败'
      });
    }
  } catch (error) {
    log('error', `Error deleting stable result: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '删除失败: ' + error.message
    });
  }
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    platform: process.platform,
    templatePath: config.templatePath,
    generatedDir: config.generatedDir,
    rtkcrvPath: config.rtkcrvPath,
    rtkcrvWorkDir: config.rtkcrvWorkDir,
    rtkcrvExists: fs.existsSync(config.rtkcrvPath),
    runningProcesses: runningProcesses.size,
    tcpServer: tcpServer ? 'running' : 'stopped',
    tcpClients: tcpClients.size,
    sseClients: sseClients.size,
    activeStations: latestData.size,
    ecefCacheSize: ecefCache.size,
    stableResults: readStableResults().length
  });
});

// SSE 端点 - 实时推送 RTKRCV 数据
app.get('/api/rtkrcv/stream', (req, res) => {
  // 设置 SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  
  // 生成客户端 ID
  const clientId = `sse_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  sseClients.set(clientId, res);
  
  log('info', `SSE client connected: ${clientId}`);
  
  // 发送初始消息
  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);
  
  // 发送最新数据
  latestData.forEach((data, stationId) => {
    res.write(`data: ${JSON.stringify({ type: 'rtkrcv_data', data })}\n\n`);
  });
  
  // 客户端断开连接处理
  req.on('close', () => {
    log('info', `SSE client disconnected: ${clientId}`);
    sseClients.delete(clientId);
  });
});

// 获取所有站点的最新数据
app.get('/api/rtkrcv/latest', (req, res) => {
  try {
    const stations = [];
    latestData.forEach((data, stationId) => {
      stations.push(data);
    });
    
    res.json({
      success: true,
      count: stations.length,
      stations: stations
    });
  } catch (error) {
    log('error', `Error getting latest data: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '获取最新数据失败: ' + error.message
    });
  }
});

// 获取指定站点的最新数据
app.get('/api/rtkrcv/latest/:stationId', (req, res) => {
  try {
    const stationId = req.params.stationId;
    const data = latestData.get(stationId);
    
    if (!data) {
      return res.status(404).json({
        success: false,
        message: '未找到该站点数据'
      });
    }
    
    res.json({
      success: true,
      data: data
    });
  } catch (error) {
    log('error', `Error getting station data: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '获取站点数据失败: ' + error.message
    });
  }
});

// 获取站点稳定性信息
app.get('/api/rtkrcv/stability', (req, res) => {
  try {
    const stabilityInfo = [];
    
    stationStability.forEach((stability, stationId) => {
      const info = {
        stationId: stationId,
        status: stability.status,
        startTime: stability.startTime.toISOString(),
        sampleCount: stability.samples.length
      };
      
      if (stability.status === 'collecting') {
        const elapsed = stability.accumulatedFixedSeconds || ((Date.now() - stability.startTime.getTime()) / 1000);
        const required = config.stabilityRequiredSeconds;
        info.elapsed = elapsed.toFixed(1);
        info.remaining = Math.max(0, required - elapsed).toFixed(1);
        info.progress = Math.min(100, (elapsed / required) * 100).toFixed(1);
      } else if (stability.status === 'stable') {
        info.endTime = stability.endTime.toISOString();
        info.average = stability.average;
      }
      
      stabilityInfo.push(info);
    });
    
    res.json({
      success: true,
      stations: stabilityInfo
    });
  } catch (error) {
    log('error', `Error getting stability info: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '获取稳定性信息失败: ' + error.message
    });
  }
});

// 重置站点稳定性（重新开始收集）
app.post('/api/rtkrcv/stability/reset/:stationId', (req, res) => {
  try {
    const stationId = req.params.stationId;
    
    if (stationStability.has(stationId)) {
      stationStability.delete(stationId);
      log('info', `🔄 Station ${stationId}: 稳定性已重置`);
      
      res.json({
        success: true,
        message: `站点 ${stationId} 稳定性已重置，将重新开始收集`
      });
    } else {
      res.status(404).json({
        success: false,
        message: '该站点没有稳定性数据'
      });
    }
  } catch (error) {
    log('error', `Error resetting stability: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '重置失败: ' + error.message
    });
  }
});

// 清理站点缓存（防止已清除的卡片重新出现）
app.post('/api/rtkrcv/clear-cache/:stationId', (req, res) => {
  try {
    const stationId = req.params.stationId;
    
    // 清理相关缓存
    let cleared = [];
    
    if (latestData.has(stationId)) {
      latestData.delete(stationId);
      cleared.push('latestData');
    }
    
    if (stationStability.has(stationId)) {
      stationStability.delete(stationId);
      cleared.push('stationStability');
    }
    
    if (ecefCache.has(stationId)) {
      ecefCache.delete(stationId);
      cleared.push('ecefCache');
    }
    
    if (cleared.length > 0) {
      log('info', `🗑️ Cleared cache for station ${stationId}: ${cleared.join(', ')}`);
      res.json({
        success: true,
        message: `站点 ${stationId} 缓存已清理`,
        cleared: cleared
      });
    } else {
      res.json({
        success: true,
        message: `站点 ${stationId} 无需清理缓存`
      });
    }
  } catch (error) {
    log('error', `Error clearing cache: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '清理缓存失败: ' + error.message
    });
  }
});

// 调试端点 - 查看 TCP 连接和数据统计
app.get('/api/debug/tcp', (req, res) => {
  try {
    const clients = [];
    tcpClients.forEach((socket, id) => {
      clients.push({
        id: id,
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
        bytesRead: socket.bytesRead,
        bytesWritten: socket.bytesWritten
      });
    });
    
    const ecefCacheInfo = [];
    ecefCache.forEach((value, stationId) => {
      ecefCacheInfo.push({
        stationId: stationId,
        age: Math.floor((Date.now() - value.timestamp) / 1000),
        preview: value.line.substring(0, 80)
      });
    });
    
    const stabilityInfo = [];
    stationStability.forEach((stability, stationId) => {
      stabilityInfo.push({
        stationId: stationId,
        status: stability.status,
        sampleCount: stability.samples.length,
        elapsed: ((Date.now() - stability.startTime.getTime()) / 1000).toFixed(1)
      });
    });
    
    res.json({
      success: true,
      tcpServer: {
        running: tcpServer !== null,
        port: 60000,
        clients: clients.length
      },
      clients: clients,
      sseClients: sseClients.size,
      cachedStations: Array.from(latestData.keys()),
      ecefCache: ecefCacheInfo,
      stability: stabilityInfo,
      statistics: {
        totalStations: latestData.size,
        pendingEcef: ecefCache.size,
        collecting: stabilityInfo.filter(s => s.status === 'collecting').length,
        stable: stabilityInfo.filter(s => s.status === 'stable').length
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// 启动 RTKRCV 进程
app.post('/api/rtkrcv/start', (req, res) => {
  try {
    const { configFile } = req.body;
    
    if (!configFile) {
      return res.status(400).json({
        success: false,
        message: '请提供配置文件名'
      });
    }
    
    // 检查配置文件是否存在
    const configPath = path.join(config.generatedDir, configFile);
    if (!fs.existsSync(configPath)) {
      return res.status(404).json({
        success: false,
        message: '配置文件不存在'
      });
    }
    
    // 检查是否已经在运行
    if (runningProcesses.has(configFile)) {
      return res.status(400).json({
        success: false,
        message: '该配置的 RTKRCV 已在运行中'
      });
    }
    
    // 启动 RTKRCV 进程
    const rtkcrvPath = config.rtkcrvPath;
    
    // 如果是 Linux 且 rtkrcv 不在指定路径，尝试从系统 PATH 查找
    const rtkcrvExePath = fs.existsSync(rtkcrvPath) ? rtkcrvPath : (
      process.platform === 'win32' ? 'rtkrcv.exe' : 'rtkrcv'
    );
    
    log('info', `Using RTKRCV executable: ${rtkcrvExePath}`);
    log('info', `Working directory: ${config.rtkcrvWorkDir}`);
    
    // 无控制台方式启动
    // -nc: 无控制台模式启动
    // -o: 指定配置文件路径（使用相对路径，因为已设置工作目录）
    const childProcess = spawn(rtkcrvExePath, ['-nc', '-o', configFile], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'], // 忽略 stdin，捕获 stdout 和 stderr
      cwd: config.rtkcrvWorkDir, // 设置工作目录
      windowsHide: true // Windows 下隐藏控制台窗口
    });
    
    const pid = childProcess.pid;
    const startTime = new Date();
    
    // 创建日志文件
    const logFileName = configFile.replace('.conf', '.log');
    const logPath = path.join(config.generatedDir, logFileName);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    
    // 记录启动信息
    logStream.write(`\n========== RTKRCV 启动 ==========\n`);
    logStream.write(`时间: ${startTime.toISOString()}\n`);
    logStream.write(`配置文件: ${configFile}\n`);
    logStream.write(`进程 PID: ${pid}\n`);
    logStream.write(`================================\n\n`);
    
    // 捕获输出到日志文件
    childProcess.stdout.on('data', (data) => {
      logStream.write(data);
    });
    
    childProcess.stderr.on('data', (data) => {
      logStream.write(`[ERROR] ${data}`);
    });
    
    // 进程退出处理
    childProcess.on('exit', (code, signal) => {
      const exitTime = new Date();
      logStream.write(`\n========== RTKRCV 退出 ==========\n`);
      logStream.write(`时间: ${exitTime.toISOString()}\n`);
      logStream.write(`退出码: ${code}\n`);
      logStream.write(`信号: ${signal}\n`);
      logStream.write(`================================\n\n`);
      logStream.end();
      
      runningProcesses.delete(configFile);
      log('info', `RTKRCV process exited: ${configFile} (PID: ${pid}, Code: ${code})`);
    });
    
    childProcess.on('error', (error) => {
      logStream.write(`\n[FATAL ERROR] ${error.message}\n`);
      logStream.end();
      
      runningProcesses.delete(configFile);
      log('error', `RTKRCV process error: ${configFile} - ${error.message}`);
    });
    
    // 保存进程信息（包含日志流引用）
    runningProcesses.set(configFile, {
      process: childProcess,
      pid: pid,
      startTime: startTime,
      configFile: configFile,
      logFile: logFileName,
      logStream: logStream  // 保存日志流引用，用于写入TCP数据
    });
    
    log('info', `Started RTKRCV: ${configFile} (PID: ${pid})`);
    
    res.json({
      success: true,
      message: `RTKRCV 已启动 (PID: ${pid})`,
      pid: pid,
      configFile: configFile,
      logFile: logFileName
    });
    
  } catch (error) {
    log('error', `Error starting RTKRCV: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '启动 RTKRCV 失败: ' + error.message
    });
  }
});

// 停止 RTKRCV 进程
app.post('/api/rtkrcv/stop', (req, res) => {
  try {
    const { configFile } = req.body;
    
    if (!configFile) {
      return res.status(400).json({
        success: false,
        message: '请提供配置文件名'
      });
    }
    
    const processInfo = runningProcesses.get(configFile);
    
    if (!processInfo) {
      return res.status(404).json({
        success: false,
        message: '该配置的 RTKRCV 未在运行'
      });
    }
    
    // 提取站点ID（从配置文件名）
    const stationId = configFile.replace('.conf', '');
    
    // 终止进程
    processInfo.process.kill();
    
    log('info', `🛑 Manually stopped RTKRCV: ${configFile} (PID: ${processInfo.pid})`);
    
    // 推送停止通知到前端（让前端清除卡片和缓存）
    broadcastToSSE({
      type: 'rtkrcv_manual_stopped',
      data: {
        stationId: stationId,
        configFile: configFile,
        reason: 'manual',
        message: `站点 ${stationId} 的 RTKRCV 已手动停止`
      }
    });
    
    res.json({
      success: true,
      message: 'RTKRCV 已停止',
      pid: processInfo.pid
    });
    
  } catch (error) {
    log('error', `Error stopping RTKRCV: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '停止 RTKRCV 失败: ' + error.message
    });
  }
});

// 获取所有运行中的进程状态
app.get('/api/rtkrcv/status', (req, res) => {
  try {
    const processes = [];
    
    runningProcesses.forEach((info, configFile) => {
      processes.push({
        configFile: configFile,
        pid: info.pid,
        startTime: info.startTime,
        uptime: Math.floor((Date.now() - info.startTime.getTime()) / 1000), // 秒
        logFile: info.logFile
      });
    });
    
    res.json({
      success: true,
      processes: processes,
      count: processes.length
    });
    
  } catch (error) {
    log('error', `Error getting RTKRCV status: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '获取状态失败: ' + error.message
    });
  }
});

// 获取单个进程状态
app.get('/api/rtkrcv/status/:configFile', (req, res) => {
  try {
    const configFile = req.params.configFile;
    const processInfo = runningProcesses.get(configFile);
    
    if (!processInfo) {
      return res.json({
        success: true,
        running: false,
        configFile: configFile
      });
    }
    
    res.json({
      success: true,
      running: true,
      configFile: configFile,
      pid: processInfo.pid,
      startTime: processInfo.startTime,
      uptime: Math.floor((Date.now() - processInfo.startTime.getTime()) / 1000),
      logFile: processInfo.logFile
    });
    
  } catch (error) {
    log('error', `Error getting RTKRCV status: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '获取状态失败: ' + error.message
    });
  }
});

// 查看日志
app.get('/api/rtkrcv/log/:logFile', (req, res) => {
  try {
    const logFile = req.params.logFile;
    const logPath = path.join(config.generatedDir, logFile);
    
    if (!fs.existsSync(logPath)) {
      return res.status(404).json({
        success: false,
        message: '日志文件不存在'
      });
    }
    
    // 读取日志文件（最后 1000 行）
    const logContent = fs.readFileSync(logPath, 'utf-8');
    const lines = logContent.split('\n');
    const lastLines = lines.slice(-1000).join('\n');
    
    res.json({
      success: true,
      logFile: logFile,
      content: lastLines,
      totalLines: lines.length
    });
    
  } catch (error) {
    log('error', `Error reading log: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '读取日志失败: ' + error.message
    });
  }
});

// 预览配置文件内容
app.get('/api/config/content/:filename', (req, res) => {
  try {
    const fileName = req.params.filename;
    const filePath = path.join(config.generatedDir, fileName);

    // 基本校验
    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      return res.status(400).json({
        success: false,
        message: '非法的文件名'
      });
    }
    if (!fileName.toLowerCase().endsWith('.conf')) {
      return res.status(400).json({
        success: false,
        message: '只能预览 .conf 文件'
      });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: '配置文件不存在'
      });
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({
      success: true,
      fileName: fileName,
      content: content
    });
  } catch (error) {
    log('error', `Error reading config content: ${error.message}`);
    res.status(500).json({
      success: false,
      message: '读取配置内容失败: ' + error.message
    });
  }
});

// 初始化并启动服务器
function startServer() {
  try {
    // 确保必要的目录存在
    ensureDirectories();
    
    // 启动 TCP 服务器监听 RTKRCV 输出
    startTcpServer();
    
    // 检查模板文件
    if (!fs.existsSync(config.templatePath)) {
      log('error', `Template file not found: ${config.templatePath}`);
      log('warn', 'Please ensure bbb.conf is in the correct location');
    } else {
      log('info', `Template file found: ${config.templatePath}`);
    }
    
    app.listen(config.port, '0.0.0.0', () => {
      log('info', `🚀 Server is running on port ${config.port}`);
      log('info', `📝 Platform: ${process.platform}`);
      log('info', `📂 Template: ${config.templatePath}`);
      log('info', `📁 Generated dir: ${config.generatedDir}`);
      log('info', `🔧 RTKRCV path: ${config.rtkcrvPath}`);
      log('info', `📂 RTKRCV work dir: ${config.rtkcrvWorkDir}`);
      log('info', `✅ RTKRCV exists: ${fs.existsSync(config.rtkcrvPath) ? 'Yes' : 'No (will try system PATH)'}`);
      log('info', `🌐 Access at: http://localhost:${config.port}`);
    });
  } catch (error) {
    log('error', `Failed to start server: ${error.message}`);
    process.exit(1);
  }
}

// 优雅关闭
process.on('SIGTERM', () => {
  log('info', 'SIGTERM received, shutting down gracefully');
  
  // 关闭 TCP 服务器
  if (tcpServer) {
    tcpServer.close(() => {
      log('info', 'TCP server closed');
    });
  }
  
  // 关闭所有 TCP 客户端
  tcpClients.forEach((client) => client.end());
  
  // 关闭所有 SSE 客户端
  sseClients.forEach((client) => client.end());
  
  process.exit(0);
});

process.on('SIGINT', () => {
  log('info', 'SIGINT received, shutting down gracefully');
  
  // 关闭 TCP 服务器
  if (tcpServer) {
    tcpServer.close(() => {
      log('info', 'TCP server closed');
    });
  }
  
  // 关闭所有 TCP 客户端
  tcpClients.forEach((client) => client.end());
  
  // 关闭所有 SSE 客户端
  sseClients.forEach((client) => client.end());
  
  process.exit(0);
});

startServer();

