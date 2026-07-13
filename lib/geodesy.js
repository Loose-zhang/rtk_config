// 大地测量与时间转换（纯函数，无副作用）

// GPS 时间与 UTC 的偏差（闰秒）。
// 注意：闰秒由 IERS 不定期公布（上一次调整为 2017-01-01 起 GPS-UTC=18s）。
// 若未来闰秒调整，请更新此常量（或通过环境变量 GPS_LEAP_SECONDS 覆盖）。
const GPS_UTC_LEAP_SECONDS = parseInt(process.env.GPS_LEAP_SECONDS || '18', 10);

// GPS 时间起始点: 1980年1月6日 00:00:00 UTC
const GPS_EPOCH_MS = Date.UTC(1980, 0, 6, 0, 0, 0);

// WGS84 椭球参数
const WGS84_A = 6378137.0;              // 半长轴
const WGS84_F = 1 / 298.257223563;      // 扁率
const WGS84_E2 = WGS84_F * (2 - WGS84_F); // 第一偏心率平方

// GPS 周 + 周内秒 转 UTC Date
function gpsToUtc(week, secondsOfWeek, leapSeconds = GPS_UTC_LEAP_SECONDS) {
  const totalSeconds = week * 604800 + secondsOfWeek;
  return new Date(GPS_EPOCH_MS + (totalSeconds - leapSeconds) * 1000);
}

// 将 "YYYY/MM/DD" 和 "HH:MM:SS.sss"（GPST）转换为 UTC Date
function gpstDateTimeToUtc(dateStr, timeStr, leapSeconds = GPS_UTC_LEAP_SECONDS) {
  try {
    const [y, m, d] = dateStr.split('/').map(n => parseInt(n, 10));
    const [hh, mm, ssms] = timeStr.split(':');
    const h = parseInt(hh, 10);
    const mi = parseInt(mm, 10);
    const s = parseFloat(ssms);
    const sec = Math.floor(s);
    const ms = Math.round((s - sec) * 1000);
    const gpst = new Date(Date.UTC(y, (m || 1) - 1, d || 1, h || 0, mi || 0, sec || 0, ms || 0));
    return new Date(gpst.getTime() - leapSeconds * 1000);
  } catch (e) {
    return new Date();
  }
}

// 从 LLH 计算 ECEF（WGS84）
function llhToEcef(latDeg, lonDeg, heightMeters) {
  const lat = latDeg * Math.PI / 180.0;
  const lon = lonDeg * Math.PI / 180.0;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);

  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);

  const x = (N + heightMeters) * cosLat * cosLon;
  const y = (N + heightMeters) * cosLat * sinLon;
  const z = (N * (1 - WGS84_E2) + heightMeters) * sinLat;

  return { x, y, z };
}

module.exports = {
  GPS_UTC_LEAP_SECONDS,
  gpsToUtc,
  gpstDateTimeToUtc,
  llhToEcef
};
