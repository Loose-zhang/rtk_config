// RTCM 3.x 帧解析（CRC24Q 校验）与 1005/1006 基站坐标编解码（纯函数，无 IO）
//
// 1005 位布局（payload 内，单位 bit）：
//   消息号 12 | 基站ID 12 | ITRF 6 | GPS/GLO/GAL/参考站 各1 | X 38(有符号, 0.1mm)
//   | 单接收机振荡器 1 | 保留 1 | Y 38 | 1/4周指示 2 | Z 38   （1006 另加 天线高 16 位）
// 与 public/app.js 的 parseEcefFromHex（tools/Int38Parser.java）取位一致。

const PREAMBLE = 0xd3;
const MAX_PAYLOAD = 1023;

const CRC24Q_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 16;
    for (let j = 0; j < 8; j++) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= 0x1864cfb;
    }
    table[i] = crc & 0xffffff;
  }
  return table;
})();

function crc24q(buf, start = 0, end = buf.length) {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc = ((crc << 8) & 0xffffff) ^ CRC24Q_TABLE[((crc >>> 16) ^ buf[i]) & 0xff];
  }
  return crc;
}

function getBitU(buf, pos, len) {
  let v = 0n;
  for (let i = pos; i < pos + len; i++) {
    v = (v << 1n) | BigInt((buf[i >> 3] >> (7 - (i & 7))) & 1);
  }
  return v;
}

function getBitS(buf, pos, len) {
  const v = getBitU(buf, pos, len);
  const sign = 1n << BigInt(len - 1);
  return (v & sign) ? v - (1n << BigInt(len)) : v;
}

function setBitU(buf, pos, len, value) {
  let v = BigInt.asUintN(len, BigInt(value));
  for (let i = pos + len - 1; i >= pos; i--) {
    const bit = Number(v & 1n);
    if (bit) buf[i >> 3] |= (1 << (7 - (i & 7)));
    else buf[i >> 3] &= ~(1 << (7 - (i & 7)));
    v >>= 1n;
  }
}

// 流式帧解析器：push 任意分片，返回完整且 CRC 正确的帧
class Rtcm3Parser {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.badCrc = 0;
    this.skippedBytes = 0;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const frames = [];
    let i = 0;
    const b = this.buf;
    while (i < b.length) {
      if (b[i] !== PREAMBLE) { i++; this.skippedBytes++; continue; }
      if (b.length - i < 3) break;
      if ((b[i + 1] & 0xfc) !== 0) { i++; this.skippedBytes++; continue; }
      const len = ((b[i + 1] & 0x03) << 8) | b[i + 2];
      const total = len + 6;
      if (b.length - i < total) break;
      const crc = crc24q(b, i, i + 3 + len);
      const got = (b[i + 3 + len] << 16) | (b[i + 4 + len] << 8) | b[i + 5 + len];
      if (crc !== got) { this.badCrc++; i++; continue; }
      const payload = Buffer.from(b.subarray(i + 3, i + 3 + len));
      const type = len >= 2 ? Number(getBitU(payload, 0, 12)) : 0;
      frames.push({ type, length: len, payload });
      i += total;
    }
    this.buf = Buffer.from(b.subarray(i));
    return frames;
  }
}

// 解析 1005/1006 payload（不含 D3+长度 头与 CRC）
function decode1005(payload) {
  if (!payload || payload.length < 19) return null;
  const type = Number(getBitU(payload, 0, 12));
  if (type !== 1005 && type !== 1006) return null;
  if (type === 1006 && payload.length < 21) return null;
  const result = {
    type,
    stationId: Number(getBitU(payload, 12, 12)),
    itrf: Number(getBitU(payload, 24, 6)),
    x: Number(getBitS(payload, 34, 38)) * 0.0001,
    y: Number(getBitS(payload, 74, 38)) * 0.0001,
    z: Number(getBitS(payload, 114, 38)) * 0.0001
  };
  if (type === 1006) result.antennaHeight = Number(getBitU(payload, 152, 16)) * 0.0001;
  return result;
}

// 生成完整 1005 帧（测试与模拟用）
function encode1005Frame({ x, y, z, stationId = 0 }) {
  const payload = Buffer.alloc(19);
  setBitU(payload, 0, 12, 1005);
  setBitU(payload, 12, 12, stationId);
  setBitU(payload, 24, 6, 0);
  setBitU(payload, 30, 4, 0b1111);
  setBitU(payload, 34, 38, BigInt(Math.round(x * 10000)));
  setBitU(payload, 72, 2, 0);
  setBitU(payload, 74, 38, BigInt(Math.round(y * 10000)));
  setBitU(payload, 112, 2, 0);
  setBitU(payload, 114, 38, BigInt(Math.round(z * 10000)));
  return wrapFrame(payload);
}

function wrapFrame(payload) {
  if (payload.length > MAX_PAYLOAD) throw new Error('RTCM payload too long');
  const frame = Buffer.alloc(payload.length + 6);
  frame[0] = PREAMBLE;
  frame[1] = (payload.length >> 8) & 0x03;
  frame[2] = payload.length & 0xff;
  payload.copy(frame, 3);
  const crc = crc24q(frame, 0, payload.length + 3);
  frame[payload.length + 3] = (crc >> 16) & 0xff;
  frame[payload.length + 4] = (crc >> 8) & 0xff;
  frame[payload.length + 5] = crc & 0xff;
  return frame;
}

// 常见消息号说明（检测连接结果展示用）
const MESSAGE_NAMES = {
  1005: '基站坐标', 1006: '基站坐标+天线高', 1007: '天线描述', 1008: '天线描述+序列号', 1033: '接收机/天线描述',
  1019: 'GPS星历', 1020: 'GLONASS星历', 1042: '北斗星历', 1044: 'QZSS星历', 1045: 'Galileo F/NAV星历', 1046: 'Galileo I/NAV星历',
  1074: 'GPS MSM4', 1075: 'GPS MSM5', 1077: 'GPS MSM7',
  1084: 'GLONASS MSM4', 1085: 'GLONASS MSM5', 1087: 'GLONASS MSM7',
  1094: 'Galileo MSM4', 1095: 'Galileo MSM5', 1097: 'Galileo MSM7',
  1114: 'QZSS MSM4', 1117: 'QZSS MSM7',
  1124: '北斗 MSM4', 1125: '北斗 MSM5', 1127: '北斗 MSM7',
  1230: 'GLONASS 码相位偏差', 4065: '私有消息 4065'
};

function isObservationMessage(type) {
  return (type >= 1001 && type <= 1004) || (type >= 1009 && type <= 1012)
    || (type >= 1071 && type <= 1137);
}

module.exports = {
  crc24q,
  getBitU,
  getBitS,
  Rtcm3Parser,
  decode1005,
  encode1005Frame,
  wrapFrame,
  MESSAGE_NAMES,
  isObservationMessage
};
