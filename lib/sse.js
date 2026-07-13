// SSE 广播（含按站点限频）
const config = require('../config');
const { log } = require('./logger');
const { sseClients, sseLastSent } = require('./state');

// 广播消息到所有 SSE 客户端
function broadcastToSSE(message) {
  // 对 rtkrcv_data 做按站点的最小间隔限频
  if (message && message.type === 'rtkrcv_data' && message.data && message.data.stationId) {
    try {
      const stationId = message.data.stationId;
      const now = Date.now();
      const last = sseLastSent.get(stationId) || 0;
      const minGap = Number.isFinite(config.sseMinIntervalMs) ? config.sseMinIntervalMs : 0;
      if (now - last < minGap) {
        return;
      }
      sseLastSent.set(stationId, now);
    } catch (e) {
      // 忽略限频异常，保证功能不受影响
    }
  }
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

module.exports = { broadcastToSSE };
