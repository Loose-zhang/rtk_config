// TCP 服务器：接收 RTKRCV 解算输出（60000 端口）
const net = require('net');
const config = require('../config');
const { log } = require('./logger');
const state = require('./state');
const { tcp, tcpClients, latestData, ecefCache } = state;
const { parseRtkcrvOutput } = require('./parser');
const { checkStationStability } = require('./stability');
const { broadcastToSSE } = require('./sse');
const { writeDataLog } = require('./rtkrcv');

// 处理一条完整解析结果（LLH-only 或 ECEF+LLH 组合）
function handleParsedData(parsedData, rawData, llhOnly) {
  writeDataLog(parsedData, rawData);
  const stabilityCheck = checkStationStability(parsedData.stationId, parsedData);
  parsedData.stability = {
    stable: stabilityCheck.stable,
    collecting: stabilityCheck.collecting || false,
    elapsed: stabilityCheck.elapsed || 0,
    sampleCount: stabilityCheck.sampleCount || 0,
    required: config.stabilityRequiredSeconds
  };
  if (stabilityCheck.stable && stabilityCheck.average) {
    parsedData.average = stabilityCheck.average;
  }
  latestData.set(parsedData.stationId, parsedData);
  if (!stabilityCheck.stable || stabilityCheck.elapsed === undefined) {
    broadcastToSSE({ type: 'rtkrcv_data', data: parsedData });
  }
  const tag = llhOnly ? '✅(LLH-only)' : '✅';
  log('info', `${tag} Station ${parsedData.stationId}: ${parsedData.quality.statusText}, Sats: ${parsedData.quality.satellites}, Lat: ${parsedData.llh.lat}, Lon: ${parsedData.llh.lon}`);
}

// 启动 TCP 服务器监听 60000 端口
function startTcpServer() {
  if (tcp.server) {
    log('warn', 'TCP server already running');
    return;
  }

  tcp.server = net.createServer((socket) => {
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
              handleParsedData(parsedData, line, true);
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
              handleParsedData(parsedData, dataPacket, false);
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
              handleParsedData(parsedData, line, true);
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

  tcp.server.listen(config.tcpPort || 60000, '0.0.0.0', () => {
    log('info', `📡 TCP server listening on port ${config.tcpPort || 60000} for RTKRCV output`);
  });

  tcp.server.on('error', (err) => {
    log('error', `TCP server error: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      log('warn', `Port ${config.tcpPort || 60000} is already in use, waiting 5 seconds to retry...`);
      tcp.server = null;
      setTimeout(startTcpServer, 5000);
    }
  });
}

module.exports = { startTcpServer };
