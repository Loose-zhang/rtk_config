// RTKRCV 输出解析
const { log } = require('./logger');
const { gpsToUtc, gpstDateTimeToUtc, llhToEcef } = require('./geodesy');

function statusText(q) {
  return q === 1 ? '固定解' : q === 2 ? '浮点解' : q === 4 ? 'DGPS' : q === 5 ? '单点' : '未知';
}

// 解析 RTKRCV 输出数据
// 支持：单行 LLH（日期或 GPS 周开头）；两行 ECEF+LLH
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
          dateTime: `${utcTime.getUTCFullYear()}/${String(utcTime.getUTCMonth() + 1).padStart(2, '0')}/${String(utcTime.getUTCDate()).padStart(2, '0')} ` +
                    `${String(utcTime.getUTCHours()).padStart(2, '0')}:${String(utcTime.getUTCMinutes()).padStart(2, '0')}:${String(utcTime.getUTCSeconds()).padStart(2, '0')}`
        },
        llh: {
          lat: lat.toFixed(9),
          lon: lon.toFixed(9),
          height: height.toFixed(4)
        },
        quality: {
          status: q,
          statusText: statusText(q),
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

    log('debug', `Parse success: Station ${stationId}, Status: ${statusText(q)}, Sats: ${ns}`);

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
        statusText: statusText(q),
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

module.exports = { parseRtkcrvOutput };
