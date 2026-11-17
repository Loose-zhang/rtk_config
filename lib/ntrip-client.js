// 最小 NTRIP v1 客户端：连接 caster 挂载点，回调原始二进制数据（RTCM3）
const net = require('net');

// 解析 rtkrcv 风格的路径：user:password@host:port/mountpoint
// 密码中可能含 '@' 或 ':'，因此用户名取第一个 ':' 之前，主机取最后一个 '@' 之后。
function parseNtripPath(input) {
  let rest = String(input || '').trim().replace(/^ntrip:\/\//i, '');
  // rtkrcv 允许在挂载点后附加 ":str"（发送的字符串），这里忽略
  let user = '';
  let password = '';
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    const cred = rest.slice(0, at);
    rest = rest.slice(at + 1);
    const colon = cred.indexOf(':');
    if (colon >= 0) {
      user = cred.slice(0, colon);
      password = cred.slice(colon + 1);
    } else {
      user = cred;
    }
  }
  const m = rest.match(/^([^:/\s]+)(?::(\d{1,5}))?\/([^\s:]+)/);
  if (!m) {
    throw new Error('NTRIP 路径格式错误，应为 user:password@host:port/mountpoint');
  }
  const port = m[2] ? parseInt(m[2], 10) : 2101;
  if (!(port > 0 && port < 65536)) throw new Error('NTRIP 端口无效');
  return { user, password, host: m[1], port, mountpoint: m[3] };
}

// 不含账号密码的展示用路径
function describeNtripPath(input) {
  try {
    const p = parseNtripPath(input);
    return `${p.host}:${p.port}/${p.mountpoint}`;
  } catch (e) {
    return '';
  }
}

/**
 * 打开 NTRIP 数据流。
 * @param {object} opts
 *   path              user:password@host:port/mountpoint
 *   connectTimeoutMs  连接+响应头超时
 *   onConnected(statusLine)
 *   onData(buffer)
 *   onError(err)      连接/认证失败等（只回调一次，随后 onClose）
 *   onClose()
 * @returns {{info, close: Function}}
 */
function openNtripStream(opts) {
  const info = parseNtripPath(opts.path);
  const connectTimeoutMs = opts.connectTimeoutMs || 8000;
  let headerDone = false;
  let headerBuf = Buffer.alloc(0);
  let finished = false;

  const socket = net.connect({ host: info.host, port: info.port });
  socket.setTimeout(connectTimeoutMs);

  const fail = (message) => {
    if (finished) return;
    finished = true;
    if (opts.onError) opts.onError(new Error(message));
    socket.destroy();
  };

  socket.on('connect', () => {
    const lines = [
      `GET /${info.mountpoint} HTTP/1.0`,
      `Host: ${info.host}:${info.port}`,
      'User-Agent: NTRIP RTKConfigBaseCheck/1.0',
      'Accept: */*',
      'Connection: close'
    ];
    if (info.user || info.password) {
      const token = Buffer.from(`${info.user}:${info.password}`).toString('base64');
      lines.push(`Authorization: Basic ${token}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
  });

  socket.on('timeout', () => {
    if (!headerDone) fail('连接 NTRIP caster 超时');
  });

  socket.on('data', (chunk) => {
    if (finished) return;
    if (headerDone) {
      if (opts.onData) opts.onData(chunk);
      return;
    }
    headerBuf = Buffer.concat([headerBuf, chunk]);
    const lineEnd = headerBuf.indexOf('\r\n');
    if (lineEnd < 0) {
      if (headerBuf.length > 4096) fail('NTRIP 响应头异常');
      return;
    }
    const statusLine = headerBuf.subarray(0, lineEnd).toString('latin1').trim();
    let body;
    if (/^ICY 200/i.test(statusLine)) {
      body = headerBuf.subarray(lineEnd + 2);
    } else if (/^HTTP\/1\.[01] 200/i.test(statusLine)) {
      const headerEnd = headerBuf.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (headerBuf.length > 8192) fail('NTRIP 响应头异常');
        return;
      }
      body = headerBuf.subarray(headerEnd + 4);
    } else if (/^SOURCETABLE/i.test(statusLine)) {
      return fail(`挂载点 ${info.mountpoint} 不存在或当前无数据（caster 返回源列表）`);
    } else if (/\b401\b/.test(statusLine)) {
      return fail('NTRIP 账号或密码错误 (401)');
    } else {
      return fail(`NTRIP caster 拒绝连接: ${statusLine.slice(0, 80)}`);
    }
    headerDone = true;
    socket.setTimeout(0);
    if (opts.onConnected) opts.onConnected(statusLine);
    if (opts.nmea) socket.write(`${opts.nmea}\r\n`);
    if (body.length && opts.onData) opts.onData(Buffer.from(body));
  });

  socket.on('error', (err) => {
    fail(`NTRIP 连接失败: ${err.message}`);
  });

  socket.on('close', () => {
    finished = true;
    if (opts.onClose) opts.onClose();
  });

  return {
    info,
    close() {
      finished = true;
      socket.destroy();
    }
  };
}

module.exports = { parseNtripPath, describeNtripPath, openNtripStream };
