// CORS（NTRIP）账号信息解析：把服务商发来的整段文字拆成 账号/密码/地址/端口/接入点，
// 再组合成 RTKLIB 数据流路径 user:password@host:port/mountpoint。
//
// 兼容常见写法：
//   账号: xxx            密码：xxx
//   IP: yd.ytcors.cn；其次数字IP:115.120.87.59
//   接入点: RTCM33GRCEJ 七星三十频-新机器推荐 \n RTCM32_GGB 三星八频-老机器推荐
//   端口: 8003：CGCS2000…（对齐千寻）8103：…8102对应WGS84坐标系
// 也可以直接粘贴 user:password@host:port/mountpoint 或 ntrip://… 形式。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CorsParser = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const LABELS = [
        { key: 'provider', re: /^(运营商|服务商|供应商|厂商)$/ },
        { key: 'user', re: /^(账号|帐号|账户|帐户|用户名|用户|user(name)?|account)$/i },
        { key: 'password', re: /^(密码|口令|password|passwd|pwd)$/i },
        { key: 'host', re: /^(ip|ip地址|地址|域名|服务器|服务器地址|主机|host|server|caster)$/i },
        { key: 'mount', re: /^(接入点|挂载点|源节点|源列表|节点|mount\s*point|mountpoint|mount)$/i },
        { key: 'port', re: /^(端口|端口号|port)$/i },
        { key: 'other', re: /^(设置方式|售后|备注|说明|注意)$/ }
    ];

    // 一行开头的 “标签:” 视为新段落；标签最长 12 个字符，避免把正文里的冒号当标签
    const LINE_LABEL = /^\s*([^\s:：]{1,12}?|mount\s*point)\s*[:：]\s*/i;
    const HOST_RE = /\b(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,})\b/ig;
    const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
    const MOUNT_RE = /[A-Za-z][A-Za-z0-9_\-]{2,}/g;
    // 端口：前面不是字母/数字/小数点，后面不是数字/小数点（排除 CGCS2000、2000.0、WGS84）
    const PORT_RE = /(?<![A-Za-z0-9.])(\d{2,5})(?![\d.])/g;

    function normalize(text) {
        return String(text || '')
            .replace(/\r\n?/g, '\n')
            .replace(/[\u3000\u00a0]/g, ' ');
    }

    function labelKey(label) {
        const l = label.trim();
        for (const def of LABELS) if (def.re.test(l)) return def.key;
        return null;
    }

    function splitSections(text) {
        const sections = {};
        let current = null;
        for (const rawLine of normalize(text).split('\n')) {
            const m = rawLine.match(LINE_LABEL);
            const key = m ? labelKey(m[1]) : null;
            if (key) {
                current = key;
                const rest = rawLine.slice(m[0].length);
                sections[key] = sections[key] ? `${sections[key]}\n${rest}` : rest;
            } else if (current) {
                sections[current] += `\n${rawLine}`;
            }
        }
        return sections;
    }

    function cleanDesc(s) {
        return String(s || '')
            .replace(/^[\s:：,，;；、。.\-—]+/, '')
            .replace(/[\s,，;；、]+$/, '')
            .trim();
    }

    function firstToken(s) {
        const m = String(s || '').trim().match(/^[^\s,，;；]+/);
        return m ? m[0] : '';
    }

    function parseHosts(s) {
        const seen = new Set();
        const hosts = [];
        for (const m of String(s || '').matchAll(HOST_RE)) {
            const h = m[0].toLowerCase();
            if (seen.has(h)) continue;
            if (IPV4_RE.test(h) && h.split('.').some((n) => Number(n) > 255)) continue;
            seen.add(h);
            hosts.push({ host: h, type: IPV4_RE.test(h) ? 'ip' : 'domain' });
        }
        // 域名优先（服务商一般把域名作为首选，数字 IP 作为备用）
        return hosts.sort((a, b) => (a.type === b.type ? 0 : a.type === 'domain' ? -1 : 1));
    }

    function parseMounts(s) {
        const text = String(s || '');
        const matches = [...text.matchAll(MOUNT_RE)];
        const mounts = [];
        const seen = new Set();
        matches.forEach((m, i) => {
            const name = m[0];
            if (seen.has(name)) return;
            seen.add(name);
            const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
            const desc = cleanDesc(text.slice(m.index + name.length, end).split('\n')[0]);
            mounts.push({ name, desc });
        });
        return mounts;
    }

    function parsePorts(s) {
        const text = String(s || '');
        const matches = [...text.matchAll(PORT_RE)]
            .filter((m) => Number(m[1]) >= 1 && Number(m[1]) <= 65535);
        const ports = [];
        const seen = new Set();
        matches.forEach((m, i) => {
            const port = Number(m[1]);
            if (seen.has(port)) return;
            seen.add(port);
            const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
            let desc = text.slice(m.index + m[1].length, end).replace(/\s+/g, ' ');
            // 最后一个端口后面常跟着无关说明，截到第一个句号
            const stop = desc.search(/[。\n]/);
            if (stop >= 0) desc = desc.slice(0, stop);
            ports.push({ port, desc: cleanDesc(desc) });
        });
        return ports;
    }

    // 默认端口 8003（CGCS2000，参考历元 2000.0，对齐千寻）；没有时取第一个
    const PREFERRED_PORT = 8003;

    function pickPort(ports) {
        if (!ports.length) return null;
        const pref = ports.find((p) => p.port === PREFERRED_PORT);
        return (pref || ports[0]).port;
    }

    function pickMount(mounts) {
        if (!mounts.length) return '';
        const pref = mounts.find((m) => /新机器/.test(m.desc))
            || mounts.find((m) => /推荐/.test(m.desc));
        return (pref || mounts[0]).name;
    }

    // 直接粘贴的 NTRIP 路径
    function parsePath(text) {
        const s = String(text || '').trim().replace(/^ntrip:\/\//i, '');
        const m = s.match(/^([^\s:@]*):(.*)@([^\s@:/]+):(\d{1,5})\/([^\s/]+)$/);
        if (!m) return null;
        return {
            user: m[1], password: m[2],
            hosts: [{ host: m[3], type: IPV4_RE.test(m[3]) ? 'ip' : 'domain' }],
            ports: [{ port: Number(m[4]), desc: '' }],
            mounts: [{ name: m[5], desc: '' }],
            host: m[3], port: Number(m[4]), mount: m[5], provider: ''
        };
    }

    /**
     * 解析服务商文字。返回 { provider, user, password, hosts[], ports[], mounts[],
     * host, port, mount, missing[] }，host/port/mount 为默认选择。
     */
    function parse(text) {
        const direct = parsePath(text);
        const result = direct || (() => {
            const sec = splitSections(text);
            const whole = normalize(text);
            const hosts = parseHosts(sec.host != null ? sec.host : whole);
            const ports = parsePorts(sec.port || '');
            const mounts = parseMounts(sec.mount || '');
            return {
                provider: cleanDesc((sec.provider || '').split(/[,，;；\n]/)[0]),
                user: firstToken(sec.user),
                password: firstToken(sec.password),
                hosts, ports, mounts,
                host: hosts.length ? hosts[0].host : '',
                port: pickPort(ports),
                mount: pickMount(mounts)
            };
        })();
        const missing = [];
        if (!result.user) missing.push('账号');
        if (!result.password) missing.push('密码');
        if (!result.host) missing.push('IP/域名');
        if (!result.port) missing.push('端口');
        if (!result.mount) missing.push('接入点');
        result.missing = missing;
        return result;
    }

    function buildPath(o) {
        return `${o.user}:${o.password}@${o.host}:${o.port}/${o.mount}`;
    }

    return { parse, buildPath, _internal: { splitSections, parseHosts, parsePorts, parseMounts } };
}));
