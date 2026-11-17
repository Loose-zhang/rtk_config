// “配置基站”流程（由 security-monitor 设备参数 →“配置基站”打开本页面）
//
// 启动参数通过 URL 片段 #baseConfig=<json> 传入（不会发送到服务器），
// 读取后转存 sessionStorage 并从地址栏移除，刷新页面可恢复。
//
// 步骤：粘贴 CORS 账号拆分为数据流2 → 检测连接 → 解算等待稳定 → security-monitor 下发 $POLCFGBASE+保存
//      → 本服务单独接收设备 RTCM，1005 与稳定解比对 → 写入 ECEF → 断开
(function () {
    'use strict';

    const API = (typeof API_BASE_URL !== 'undefined') ? API_BASE_URL : `${window.location.origin}/api`;
    const STORAGE_KEY = 'rtkBaseConfigLaunch';
    const CORS_KEY = 'rtkBaseConfigCors';
    const HEARTBEAT_MS = 20000;
    const STATUS_POLL_MS = 5000;
    const VERIFY_POLL_MS = 2000;
    const SOLVE_TIMEOUT_MS = 30 * 60 * 1000;

    const bc = {
        launch: null,
        inpstr1: '',
        sessionAlive: false,
        finished: false,
        status: null,
        heartbeatTimer: null,
        statusTimer: null,
        es: null,
        solving: false,
        solveStartedAt: 0,
        solveWatchTimer: null,
        stable: null,
        jobId: null,
        jobTimer: null,
        busy: false,
        cors: null,
        corsApplied: false,
        lastEventSeq: 0
    };

    const $ = (id) => document.getElementById(id);

    // ------------------------------------------------------------ 工具

    function escapeHtml(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function maskPath(p) {
        const s = String(p || '');
        const at = s.lastIndexOf('@');
        return at >= 0 ? s.slice(at + 1) : s;
    }

    function fmt(n, d) {
        const v = Number(n);
        return Number.isFinite(v) ? v.toFixed(d) : '-';
    }

    function clock(ms) {
        return new Date(ms == null ? Date.now() : ms).toLocaleTimeString('zh-CN', { hour12: false });
    }

    function logLine(msg, at) {
        const el = $('bcLog');
        if (!el) return;
        const t = clock(at);
        el.textContent += `[${t}] ${msg}\n`;
        el.scrollTop = el.scrollHeight;
    }

    function toast(msg, type) {
        if (typeof showMessage === 'function') showMessage(msg, type || 'info');
    }

    function setStep(step, state, note) {
        const li = document.querySelector(`#bcSteps li[data-step="${step}"]`);
        if (!li) return;
        li.classList.remove('active', 'done', 'error');
        if (state) li.classList.add(state);
        let span = li.querySelector('.bc-note');
        if (!span) {
            span = document.createElement('span');
            span.className = 'bc-note';
            li.appendChild(span);
        }
        span.textContent = note ? `— ${note}` : '';
    }

    function setBadge(text, running) {
        const b = $('bcSessionBadge');
        if (!b) return;
        b.textContent = text;
        b.className = `status-badge ${running ? 'running' : 'stopped'}`;
    }

    async function localJson(path, options) {
        const resp = await fetch(`${API}${path}`, options);
        let data = null;
        try { data = await resp.json(); } catch (e) { /* ignore */ }
        return { ok: resp.ok, status: resp.status, data: data || {} };
    }

    function postLocal(path, body) {
        return localJson(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        });
    }

    // security-monitor 回调（跨域，表单编码避免预检）
    async function remote(path, params) {
        const body = new URLSearchParams(Object.assign({ token: bc.launch.token }, params || {}));
        const resp = await fetch(`${bc.launch.apiBase}${path}`, { method: 'POST', body });
        const data = await resp.json();
        if (!data || data.code !== 0) {
            const err = new Error((data && data.msg) || `security-monitor 返回错误 (${resp.status})`);
            err.remote = data;
            throw err;
        }
        return data.data;
    }

    // ------------------------------------------------------------ 启动参数

    function readLaunch() {
        const m = window.location.hash.match(/[#&]baseConfig=([^&]+)/);
        if (m) {
            try {
                const data = JSON.parse(decodeURIComponent(m[1]));
                sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
                history.replaceState(null, '', window.location.pathname + window.location.search);
                return data;
            } catch (e) {
                console.warn('Invalid baseConfig launch data', e);
            }
        }
        try {
            const saved = sessionStorage.getItem(STORAGE_KEY);
            return saved ? JSON.parse(saved) : null;
        } catch (e) {
            return null;
        }
    }

    function validLaunch(l) {
        return l && typeof l.token === 'string' && l.token.length >= 16
            && /^\d{1,12}$/.test(String(l.deviceId || ''))
            && /^https?:\/\/[^\s]+$/i.test(String(l.apiBase || ''));
    }

    function mountPrefix() {
        let prefix = (bc.launch.ntripPrefix || '').trim();
        if (!prefix) {
            const batch = $('batchInpstr1Base');
            prefix = batch && batch.value.trim();
        }
        if (!prefix) {
            const cur = $('inpstr1').value.trim();
            prefix = cur.slice(0, cur.lastIndexOf('/') + 1);
        }
        return prefix.endsWith('/') ? prefix : `${prefix}/`;
    }

    // ------------------------------------------------------------ 会话维护

    async function heartbeat() {
        if (bc.finished) return;
        try {
            await remote('/heartbeat');
            if (!bc.sessionAlive) setBadge('已连接 security-monitor', true);
            bc.sessionAlive = true;
        } catch (e) {
            if (e.remote) {
                bc.sessionAlive = false;
                setBadge('会话已失效', false);
                logLine(`security-monitor 会话已失效：${e.message}`);
                stopTimers();
            }
        }
    }

    async function refreshStatus() {
        if (bc.finished) return null;
        try {
            const st = await remote('/status');
            bc.status = st;
            showCommands(st);
            bc.sessionAlive = true;
            setBadge('已连接 security-monitor', true);
            if (st.setupSent) {
                setStep('setup', 'done', '已送达设备');
            } else {
                setStep('setup', 'active', `设备未处于工作周期，剩余 ${st.setupPending} 条指令排队中，设备上线（D3F0）后自动补发`);
            }
            if (st.coordRequested) {
                if (st.coordSent) setStep('coord', 'done', '已送达设备');
                else setStep('coord', 'active', '设备未处于工作周期，指令排队中，设备上线（D3F0）后自动补发');
            }
            return st;
        } catch (e) {
            if (e.remote) {
                bc.sessionAlive = false;
                setBadge('会话已失效', false);
            }
            return null;
        }
    }

    // ------------------------------------------------------------ 下发指令与推送日志

    const CMD_STATUS = { sent: '已下发', queued: '排队中', cancelled: '已取消' };

    // security-monitor 返回的指令列表（含完整 D310 帧）与推送事件
    function showCommands(st) {
        if (!st) return;
        const cmds = st.commands || [];
        if (cmds.length) {
            const rows = cmds.map((c) => {
                const when = c.status === 'sent' && c.sentAt ? ` ${clock(c.sentAt)}` : '';
                return `<tr>
                    <td>${escapeHtml(c.seq)}</td>
                    <td>${escapeHtml(c.name)}</td>
                    <td class="bc-cmd-status ${escapeHtml(c.status)}">${escapeHtml(CMD_STATUS[c.status] || c.status)}${when}</td>
                    <td class="bc-mono bc-cmd-frame">${escapeHtml(c.frame)}</td>
                </tr>`;
            }).join('');
            $('bcCmds').innerHTML = `<div class="bc-cmds"><h3>📤 下发指令（设备 ${escapeHtml(st.deviceId)}）</h3>
                <table class="bc-table"><thead><tr><th>#</th><th>指令</th><th>状态</th><th>下发帧 HEX（D310）</th></tr></thead>
                <tbody>${rows}</tbody></table></div>`;
        }
        for (const e of st.events || []) {
            if (e.seq <= bc.lastEventSeq) continue;
            bc.lastEventSeq = e.seq;
            logLine(`[security-monitor] ${e.text}`, e.time);
        }
    }

    function stopTimers() {
        clearInterval(bc.heartbeatTimer);
        clearInterval(bc.statusTimer);
        clearInterval(bc.jobTimer);
        clearInterval(bc.solveWatchTimer);
        bc.heartbeatTimer = bc.statusTimer = bc.jobTimer = bc.solveWatchTimer = null;
    }


    // ------------------------------------------------------------ 步骤：CORS 账号 → 数据流 2

    // 有候选项时渲染下拉框，否则渲染文本框供手工填写
    function renderChoice(boxId, inputId, items, selected) {
        const box = $(boxId);
        if (items.length) {
            const opts = items.map((it) => `<option value="${escapeHtml(it.value)}"${String(it.value) === String(selected) ? ' selected' : ''}>${escapeHtml(it.label)}</option>`).join('');
            box.innerHTML = `<select id="${inputId}">${opts}</select><span class="bc-desc" id="${inputId}Desc"></span>`;
        } else {
            box.innerHTML = `<input type="text" id="${inputId}" autocomplete="off" spellcheck="false" placeholder="未识别，请手动填写"><span class="bc-desc" id="${inputId}Desc"></span>`;
        }
        $(inputId).addEventListener('input', updateCorsPreview);
        $(inputId).addEventListener('change', updateCorsPreview);
    }

    function corsValues() {
        return {
            user: $('bcCorsUser').value.trim(),
            password: $('bcCorsPass').value.trim(),
            host: ($('bcCorsHost') ? $('bcCorsHost').value : '').trim(),
            port: ($('bcCorsPort') ? $('bcCorsPort').value : '').trim(),
            mount: ($('bcCorsMount') ? $('bcCorsMount').value : '').trim()
        };
    }

    function corsError(v) {
        if (!v.user) return '账号不能为空';
        if (/[\s:@]/.test(v.user)) return '账号不能包含空格、冒号或 @';
        if (!v.password) return '密码不能为空';
        if (/\s/.test(v.password)) return '密码不能包含空格';
        if (!/^[A-Za-z0-9.-]+$/.test(v.host)) return 'IP/域名格式不正确';
        const port = Number(v.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return '端口应为 1–65535 的整数';
        if (!/^[A-Za-z0-9_.\-]+$/.test(v.mount)) return '接入点格式不正确';
        return '';
    }

    function descOf(list, key, value) {
        const it = (list || []).find((x) => String(x[key]) === String(value));
        return it && it.desc ? it.desc : '';
    }

    function updateCorsPreview() {
        const v = corsValues();
        const p = bc.cors || {};
        const portDesc = descOf(p.ports, 'port', v.port);
        const mountDesc = descOf(p.mounts, 'name', v.mount);
        if ($('bcCorsPortDesc')) $('bcCorsPortDesc').textContent = portDesc;
        if ($('bcCorsMountDesc')) $('bcCorsMountDesc').textContent = mountDesc;
        $('bcCorsPreview').textContent = `${v.user || '?'}:${v.password ? '******' : '?'}@${v.host || '?'}:${v.port || '?'}/${v.mount || '?'}`;
    }

    function corsMsg(html) {
        $('bcCorsMsg').innerHTML = html;
    }

    function parseCors() {
        const text = $('bcCorsText').value;
        if (!text.trim()) {
            corsMsg('<span class="bad">请先粘贴 CORS 账号信息</span>');
            return;
        }
        const p = window.CorsParser.parse(text);
        if (!p.user && !p.password && !p.host && !p.mount) {
            corsMsg('<span class="bad">没有识别到账号信息，请检查粘贴内容（需要包含 账号/密码/IP/端口/接入点）</span>');
            return;
        }
        bc.cors = p;
        $('bcCorsUser').value = p.user || '';
        $('bcCorsPass').value = p.password || '';
        renderChoice('bcCorsHostBox', 'bcCorsHost', p.hosts.map((h) => ({
            value: h.host, label: `${h.host}（${h.type === 'ip' ? '数字 IP' : '域名'}）`
        })), p.host);
        renderChoice('bcCorsPortBox', 'bcCorsPort', p.ports.map((x) => ({
            value: x.port, label: x.desc ? `${x.port} — ${x.desc}` : String(x.port)
        })), p.port);
        renderChoice('bcCorsMountBox', 'bcCorsMount', p.mounts.map((m) => ({
            value: m.name, label: m.desc ? `${m.name} — ${m.desc}` : m.name
        })), p.mount);
        $('bcCorsFields').style.display = '';
        updateCorsPreview();
        const found = `${p.provider ? `${escapeHtml(p.provider)}：` : ''}识别到 ${p.hosts.length} 个地址、${p.ports.length} 个端口、${p.mounts.length} 个接入点`;
        corsMsg(p.missing.length
            ? `<span class="bad">${found}；未识别：${escapeHtml(p.missing.join('、'))}，请手动补充</span>`
            : `<span class="ok">${found}，请核对后点击“应用到数据流 2”</span>`);
        setStep('cors', 'active', '已拆分，待确认');
    }

    function applyCorsPath(path, note) {
        $('inpstr2').value = path;
        $('inpstr2').dispatchEvent(new Event('blur'));
        bc.corsApplied = true;
        try { sessionStorage.setItem(CORS_KEY, JSON.stringify({ path, note })); } catch (e) { /* ignore */ }
        setStep('cors', 'done', note);
    }

    function applyCors() {
        const v = corsValues();
        const err = corsError(v);
        if (err) {
            corsMsg(`<span class="bad">${escapeHtml(err)}</span>`);
            return;
        }
        const path = window.CorsParser.buildPath(v);
        const portDesc = descOf(bc.cors && bc.cors.ports, 'port', v.port);
        const note = `${v.host}:${v.port}/${v.mount}${portDesc ? `（${portDesc}）` : ''}`;
        applyCorsPath(path, note);
        corsMsg(`<span class="ok">已应用到数据流 2：${escapeHtml(maskPath(path))}，可以点击“检测连接”</span>`);
        logLine(`CORS 参考站：${v.user}@${note}`);
    }

    function restoreCors() {
        let saved = null;
        try { saved = JSON.parse(sessionStorage.getItem(CORS_KEY) || 'null'); } catch (e) { /* ignore */ }
        if (saved && saved.path) {
            applyCorsPath(saved.path, saved.note || maskPath(saved.path));
            corsMsg(`<span class="ok">已恢复数据流 2：${escapeHtml(maskPath(saved.path))}</span>`);
        } else {
            setStep('cors', 'active', '请粘贴 CORS 账号信息并拆分');
        }
    }

    // ------------------------------------------------------------ 步骤 3/4：检测连接

    function currentStreams() {
        return [
            { label: '数据流1（设备）', path: $('inpstr1').value.trim(), stopWhen1005: true },
            { label: '数据流2（参考站）', path: $('inpstr2').value.trim() },
            { label: '数据流3（星历）', path: $('inpstr3').value.trim() }
        ];
    }

    function renderConnResults(container, results) {
        const rows = results.map((r) => {
            const types = (r.messageTypes || []).map((m) =>
                `${m.type}${m.name ? `(${escapeHtml(m.name)})` : ''}×${m.count}`).join('，');
            const state = r.connected
                ? `<span class="ok">已连接</span>`
                : `<span class="bad">失败</span>`;
            return `<tr>
                <td>${escapeHtml(r.label)}</td>
                <td class="bc-mono">${escapeHtml(r.target)}</td>
                <td>${state}${r.error ? `<br><span class="bad">${escapeHtml(r.error)}</span>` : ''}</td>
                <td>${r.bytes}</td>
                <td>${r.frames}${r.badCrc ? `（CRC错 ${r.badCrc}）` : ''}</td>
                <td>${types || '-'}</td>
            </tr>`;
        }).join('');
        container.innerHTML = `<table class="bc-table">
            <thead><tr><th>数据流</th><th>挂载点</th><th>连接</th><th>字节</th><th>RTCM 帧</th><th>消息类型</th></tr></thead>
            <tbody>${rows}</tbody></table>`;
    }

    async function runConnectionCheck(container, streams) {
        container.innerHTML = '<p class="loading">正在连接 NTRIP 挂载点并接收数据（约 10 秒）…</p>';
        const res = await postLocal('/base-config/check-connection', { streams, durationMs: 10000 });
        if (!res.ok || !res.data.success) {
            container.innerHTML = `<p class="bad">${escapeHtml(res.data.message || '检测失败')}</p>`;
            return null;
        }
        renderConnResults(container, res.data.results);
        return res.data.results;
    }

    async function checkConnection() {
        if (bc.busy || bc.finished) return;
        if (!bc.corsApplied) {
            const cur = $('inpstr2').value.trim();
            if (!cur) {
                setStep('cors', 'error', '请先粘贴 CORS 账号信息并应用到数据流 2');
                $('bcCorsText').focus();
                return;
            }
            if (!window.confirm(`尚未拆分 CORS 账号。是否直接使用当前数据流 2（${maskPath(cur)}）继续检测？`)) {
                $('bcCorsText').focus();
                return;
            }
            setStep('cors', 'done', `使用现有数据流 2：${maskPath(cur)}`);
        }
        bc.busy = true;
        $('bcCheckBtn').disabled = true;
        setStep('connect', 'active', '检测中…');
        try {
            const results = await runConnectionCheck($('bcConnResult'), currentStreams());
            if (!results) {
                setStep('connect', 'error', '检测失败');
                return;
            }
            const [dev, ref, eph] = results;
            if (!dev.connected || dev.observationFrames === 0) {
                const st = bc.status;
                const hint = st && !st.setupSent
                    ? '设备 打开所有MSM/RTCM MSM4 等指令尚未送达（设备未处于工作周期），请等设备上线后再检测'
                    : (dev.error || '未收到设备观测数据，请确认设备在线且已开启 RTCM');
                setStep('connect', 'error', hint);
                logLine(`检测连接失败：${hint}`);
                return;
            }
            if (!ref.connected) {
                setStep('connect', 'error', `参考站数据流不可用：${ref.error || ''}`);
                return;
            }
            if (!eph.connected) logLine(`⚠️ 星历数据流不可用（${eph.error || '无数据'}），继续解算`);
            setStep('connect', 'done', `设备观测帧 ${dev.observationFrames} 个`);
            logLine('检测连接通过，开始解算');
            try {
                await startSolve();
            } catch (e) {
                solveFailed(e.message);
            }
        } catch (e) {
            setStep('connect', 'error', e.message);
        } finally {
            bc.busy = false;
            $('bcCheckBtn').disabled = bc.finished;
        }
    }

    // ------------------------------------------------------------ 步骤 5：解算等待稳定

    function ensureSse() {
        if (bc.es) return;
        bc.es = new EventSource(`${API}/rtkrcv/stream`);
        bc.es.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch (e) { return; }
            if (!msg || !msg.data || String(msg.data.stationId) !== String(bc.launch.deviceId)) return;
            if (msg.type === 'rtkrcv_data' && bc.solving) {
                const d = msg.data;
                const st = d.stability || {};
                const progress = st.collecting
                    ? `，稳定收集 ${fmt(st.elapsed, 0)}s / 样本 ${st.sampleCount || 0}`
                    : '';
                setStep('solve', 'active',
                    `${d.quality ? d.quality.statusText : ''}，卫星 ${d.quality ? d.quality.satellites : '-'}${progress}`);
            } else if (msg.type === 'station_stable' && bc.solving) {
                onStable(msg.data);
            }
        };
    }

    async function startSolve() {
        const deviceId = String(bc.launch.deviceId);
        const configFile = `${deviceId}.conf`;
        const outHeight = $('bcOutHeight').value;
        $('outHeight').value = outHeight;
        bc.stable = null;
        $('bcSolveBtn').disabled = true;
        setStep('solve', 'active', '生成配置并启动 RTKRCV…');
        ensureSse();

        await postLocal(`/rtkrcv/clear-cache/${encodeURIComponent(deviceId)}`);
        const gen = await postLocal('/generate-config', {
            inpstr1: $('inpstr1').value.trim(),
            inpstr2: $('inpstr2').value.trim(),
            inpstr3: $('inpstr3').value.trim(),
            outHeight
        });
        if (!gen.ok || !gen.data.success) throw new Error(gen.data.message || '生成配置失败');
        if (gen.data.fileName !== configFile) {
            throw new Error(`配置文件名 ${gen.data.fileName} 与设备号不一致，请检查数据流1挂载点`);
        }

        let start = await postLocal('/rtkrcv/start', { configFile });
        if (start.status === 400 && /运行/.test(start.data.message || '')) {
            logLine('RTKRCV 已在运行，重启以加载新配置');
            await postLocal('/rtkrcv/stop', { configFile });
            await new Promise((r) => setTimeout(r, 2000));
            start = await postLocal('/rtkrcv/start', { configFile });
        }
        if (!start.ok || !start.data.success) throw new Error(start.data.message || '启动 RTKRCV 失败');

        bc.solving = true;
        bc.solveStartedAt = Date.now();
        setStep('solve', 'active', `RTKRCV 已启动 (PID ${start.data.pid})，等待固定解…`);
        logLine(`RTKRCV 已启动：${configFile}，高度类型 ${outHeight === '0' ? '椭球高' : '大地高'}`);
        clearInterval(bc.solveWatchTimer);
        bc.solveWatchTimer = setInterval(watchSolve, 15000);
    }

    async function watchSolve() {
        if (!bc.solving) return clearInterval(bc.solveWatchTimer);
        const configFile = `${bc.launch.deviceId}.conf`;
        if (Date.now() - bc.solveStartedAt > SOLVE_TIMEOUT_MS) {
            await postLocal('/rtkrcv/stop', { configFile });
            return solveFailed('30 分钟内未达到稳定解');
        }
        const st = await localJson(`/rtkrcv/status/${encodeURIComponent(configFile)}`);
        // 稳定后 RTKRCV 会在 2 秒后自动关闭；未稳定就退出视为失败
        if (st.ok && st.data.success && !st.data.running && bc.solving) {
            setTimeout(() => { if (bc.solving) solveFailed('RTKRCV 已退出但未得到稳定解'); }, 3000);
        }
    }

    function solveFailed(reason) {
        bc.solving = false;
        clearInterval(bc.solveWatchTimer);
        setStep('solve', 'error', reason);
        logLine(`解算失败：${reason}`);
        $('bcSolveBtn').disabled = bc.finished;
    }

    function onStable(data) {
        const avg = data && data.average;
        if (!avg || !avg.llh || !avg.ecef) return;
        bc.solving = false;
        clearInterval(bc.solveWatchTimer);
        bc.stable = {
            lat: String(avg.llh.lat),
            lon: String(avg.llh.lon),
            height: String(avg.llh.height),
            x: Number(avg.ecef.x),
            y: Number(avg.ecef.y),
            z: Number(avg.ecef.z),
            sampleCount: data.sampleCount
        };
        setStep('solve', 'done', `样本 ${data.sampleCount}，用时 ${data.duration}s`);
        logLine(`稳定解：B=${bc.stable.lat} L=${bc.stable.lon} H=${bc.stable.height}；`
            + `X=${fmt(bc.stable.x, 4)} Y=${fmt(bc.stable.y, 4)} Z=${fmt(bc.stable.z, 4)}`);
        $('bcSolveBtn').disabled = false;
        renderDetail();
        sendCoordinate();
    }

    // ------------------------------------------------------------ 步骤 6：下发基站坐标

    async function sendCoordinate() {
        if (!bc.stable || bc.finished) return;
        setStep('coord', 'active', '下发中…');
        try {
            const st = await remote('/base-coord', {
                lat: bc.stable.lat, lon: bc.stable.lon, height: bc.stable.height
            });
            bc.status = Object.assign({}, bc.status, st);
            showCommands(st);
            renderDetail();
            $('bcResendBtn').style.display = '';
            if (!st.coordSent) {
                setStep('coord', 'active', '设备未处于工作周期，指令排队中，设备上线（D3F0）后自动补发');
                await waitCoordSent();
            }
            if (bc.finished) return;
            setStep('coord', 'done', '已送达设备');
            startVerify();
        } catch (e) {
            setStep('coord', 'error', e.message);
            logLine(`下发基站坐标失败：${e.message}`);
        }
    }

    function waitCoordSent() {
        return new Promise((resolve) => {
            const iv = setInterval(async () => {
                if (bc.finished) { clearInterval(iv); return resolve(); }
                const st = await refreshStatus();
                if (st && st.coordSent) { clearInterval(iv); resolve(); }
            }, STATUS_POLL_MS);
        });
    }

    // ------------------------------------------------------------ 步骤 7：1005 比对

    async function startVerify() {
        if (!bc.stable || bc.finished) return;
        $('bcVerifyBtn').style.display = 'none';
        setStep('verify', 'active', '连接设备挂载点，等待 1005…');
        const res = await postLocal('/base-config/rtcm1005/start', {
            path: $('inpstr1').value.trim(),
            expected: { x: bc.stable.x, y: bc.stable.y, z: bc.stable.z },
            toleranceM: Number(bc.launch.toleranceM) || 0.05,
            requiredMatches: 3,
            timeoutSec: 900
        });
        if (!res.ok || !res.data.success) {
            setStep('verify', 'error', res.data.message || '启动 1005 校验失败');
            $('bcVerifyBtn').style.display = '';
            return;
        }
        bc.jobId = res.data.job.id;
        logLine(`开始接收 ${res.data.job.target} 的 1005（需连续 ${res.data.job.requiredMatches} 次一致）`);
        clearInterval(bc.jobTimer);
        bc.jobTimer = setInterval(pollVerify, VERIFY_POLL_MS);
    }

    async function pollVerify() {
        if (!bc.jobId) return;
        const res = await localJson(`/base-config/rtcm1005/${encodeURIComponent(bc.jobId)}`);
        if (!res.ok || !res.data.success) return;
        const job = res.data.job;
        renderVerify(job);
        if (job.state === 'connecting' || job.state === 'receiving' || job.state === 'reconnecting') {
            const last = job.last
                ? `，最新偏差 ${fmt(job.last.d3, 4)} m（连续一致 ${job.consecutiveMatches}/${job.requiredMatches}）`
                : '';
            setStep('verify', 'active', `已收到 1005 ${job.frames1005} 条${last}${job.state === 'reconnecting' ? '，重连中' : ''}`);
            return;
        }
        clearInterval(bc.jobTimer);
        bc.jobTimer = null;
        if (job.state === 'matched') {
            setStep('verify', 'done', `偏差 ${fmt(job.result.d3, 4)} m`);
            logLine(`1005 与稳定解一致：X=${fmt(job.result.x, 4)} Y=${fmt(job.result.y, 4)} Z=${fmt(job.result.z, 4)}，偏差 ${fmt(job.result.d3, 4)} m`);
            writeEcef(job.result);
        } else if (job.state !== 'stopped') {
            setStep('verify', 'error', job.error || job.state);
            logLine(`1005 校验未通过：${job.error || job.state}`);
            $('bcVerifyBtn').style.display = '';
        }
    }

    // ------------------------------------------------------------ 步骤 8/9：写入 ECEF、断开

    async function writeEcef(pos) {
        setStep('ecef', 'active', '写入中…');
        try {
            const st = await remote('/ecef', { x: pos.x.toFixed(4), y: pos.y.toFixed(4), z: pos.z.toFixed(4) });
            setStep('ecef', 'done', `X=${fmt(pos.x, 4)} Y=${fmt(pos.y, 4)} Z=${fmt(pos.z, 4)}`);
            logLine(`ECEF 已写入设备参数（服务端核对偏差 ${fmt(st.diff3d, 4)} m）`);
            toast(`✅ 设备 ${bc.launch.deviceId} 基站配置完成，ECEF 已写入`, 'success');
            await disconnect(true);
        } catch (e) {
            setStep('ecef', 'error', e.message);
            logLine(`写入 ECEF 失败：${e.message}`);
            $('bcVerifyBtn').style.display = '';
        }
    }

    async function disconnect(completed) {
        if (bc.finished) return;
        bc.finished = true;
        bc.solving = false;
        stopTimers();
        if (bc.jobId) {
            await postLocal(`/base-config/rtcm1005/${encodeURIComponent(bc.jobId)}/stop`).catch(() => {});
        }
        if (!completed) {
            // 中途断开：停止本设备的 RTKRCV
            await postLocal('/rtkrcv/stop', { configFile: `${bc.launch.deviceId}.conf` }).catch(() => {});
        }
        if (bc.es) { bc.es.close(); bc.es = null; }
        try {
            await remote('/close', { immediate: 'true' });
            setStep('close', 'done', '已断开');
            logLine(completed
                ? '已断开与 security-monitor 的连接，设备 NtripCaster 推送已关闭'
                : '已断开与 security-monitor 的连接');
        } catch (e) {
            setStep('close', completed ? 'done' : 'error', e.message);
        }
        try {
            sessionStorage.removeItem(STORAGE_KEY);
            sessionStorage.removeItem(CORS_KEY);
        } catch (e) { /* ignore */ }
        setBadge(completed ? '已完成' : '已断开', false);
        ['bcCheckBtn', 'bcSolveBtn', 'bcResendBtn', 'bcVerifyBtn', 'bcDisconnectBtn',
            'bcCorsParseBtn', 'bcCorsApplyBtn']
            .forEach((id) => { $(id).disabled = true; });
    }

    // ------------------------------------------------------------ 展示

    function renderDetail() {
        const st = bc.status || {};
        const s = bc.stable;
        let html = '<table class="bc-table"><tbody>';
        if (s) {
            html += `<tr><th>稳定解 BLH</th><td class="bc-mono">${escapeHtml(s.lat)}, ${escapeHtml(s.lon)}, ${escapeHtml(s.height)}</td></tr>`;
            html += `<tr><th>稳定解 ECEF</th><td class="bc-mono">${fmt(s.x, 4)}, ${fmt(s.y, 4)}, ${fmt(s.z, 4)}</td></tr>`;
        }
        if (st.baseCommand) {
            html += `<tr><th>基站配置指令</th><td class="bc-mono">${escapeHtml(st.baseCommand)}</td></tr>`;
            html += `<tr><th>HEX</th><td class="bc-mono">${escapeHtml(st.baseHex)}</td></tr>`;
        }
        html += '</tbody></table><div id="bcVerifyDetail"></div>';
        $('bcDetail').innerHTML = html;
    }

    function renderVerify(job) {
        const el = $('bcVerifyDetail');
        if (!el || !job.last) return;
        const l = job.last;
        el.innerHTML = `<table class="bc-table" style="margin-top:8px"><thead><tr>
            <th></th><th>X</th><th>Y</th><th>Z</th><th>3D 偏差</th></tr></thead><tbody>
            <tr><th>设备 1005</th><td class="bc-mono">${fmt(l.x, 4)}</td><td class="bc-mono">${fmt(l.y, 4)}</td><td class="bc-mono">${fmt(l.z, 4)}</td><td></td></tr>
            <tr><th>稳定解</th><td class="bc-mono">${fmt(job.expected.x, 4)}</td><td class="bc-mono">${fmt(job.expected.y, 4)}</td><td class="bc-mono">${fmt(job.expected.z, 4)}</td><td></td></tr>
            <tr><th>差值</th><td class="bc-mono">${fmt(l.dx, 4)}</td><td class="bc-mono">${fmt(l.dy, 4)}</td><td class="bc-mono">${fmt(l.dz, 4)}</td>
                <td class="${l.ok ? 'ok' : 'bad'}">${fmt(l.d3, 4)} m ${l.ok ? '✓' : `> ${job.toleranceM}`}</td></tr>
            </tbody></table>`;
    }

    // ------------------------------------------------------------ 通用“检测连接”按钮（主表单）

    function bindGenericCheck() {
        const btn = $('checkConnBtn');
        if (!btn) return;
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                await runConnectionCheck($('checkConnResult'), [
                    { label: '数据流1', path: $('inpstr1').value.trim(), stopWhen1005: true },
                    { label: '数据流2', path: $('inpstr2').value.trim() },
                    { label: '数据流3', path: $('inpstr3').value.trim() }
                ]);
            } finally {
                btn.disabled = false;
            }
        });
    }

    // ------------------------------------------------------------ 初始化

    function init() {
        bindGenericCheck();
        const launch = readLaunch();
        if (!launch) return;
        if (!validLaunch(launch)) {
            try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
            toast('❌ 配置基站启动参数无效', 'error');
            return;
        }
        bc.launch = launch;
        const card = $('baseConfigCard');
        card.style.display = '';
        $('bcDeviceId').textContent = launch.deviceId;
        $('bcTolerance').textContent = Number(launch.toleranceM) || 0.05;

        // 步骤 4：测站挂载点改为该设备
        bc.inpstr1 = `${mountPrefix()}${launch.deviceId}`;
        $('inpstr1').value = bc.inpstr1;
        $('bcMount').textContent = maskPath(bc.inpstr1);
        $('outHeight').value = $('bcOutHeight').value;

        setStep('type', 'done', launch.previousParentId
            ? `已清理原基站编号 ${launch.previousParentId}` : '已完成');
        setStep('setup', 'active', '查询中…');
        logLine(`配置基站：设备 ${launch.deviceId}，挂载点 ${maskPath(bc.inpstr1)}`);

        restoreCors();
        $('bcCorsParseBtn').addEventListener('click', parseCors);
        $('bcCorsApplyBtn').addEventListener('click', applyCors);
        ['bcCorsUser', 'bcCorsPass'].forEach((id) => $(id).addEventListener('input', updateCorsPreview));
        $('bcCheckBtn').addEventListener('click', checkConnection);
        $('bcSolveBtn').addEventListener('click', async () => {
            if (bc.busy || bc.finished) return;
            bc.busy = true;
            try { await startSolve(); } catch (e) { solveFailed(e.message); } finally { bc.busy = false; }
        });
        $('bcResendBtn').addEventListener('click', () => {
            if (bc.jobId) postLocal(`/base-config/rtcm1005/${encodeURIComponent(bc.jobId)}/stop`);
            clearInterval(bc.jobTimer);
            sendCoordinate();
        });
        $('bcVerifyBtn').addEventListener('click', startVerify);
        $('bcDisconnectBtn').addEventListener('click', () => {
            if (window.confirm('确定断开配置基站会话？未完成的步骤不会继续执行。')) disconnect(false);
        });

        // 页面关闭：通知 security-monitor 延迟关闭（15 秒内刷新页面会由心跳取消）
        window.addEventListener('pagehide', () => {
            if (bc.finished || !bc.launch) return;
            try {
                navigator.sendBeacon(`${bc.launch.apiBase}/close`, new URLSearchParams({ token: bc.launch.token }));
                if (bc.jobId) navigator.sendBeacon(`${API}/base-config/rtcm1005/${encodeURIComponent(bc.jobId)}/stop`);
            } catch (e) { /* ignore */ }
        });

        heartbeat();
        refreshStatus();
        bc.heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
        // 持续刷新：展示指令状态与 security-monitor 推送日志
        bc.statusTimer = setInterval(refreshStatus, STATUS_POLL_MS);
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
