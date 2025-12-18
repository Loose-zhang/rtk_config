// API 基础 URL - 自动使用当前访问的域名和端口
const API_BASE_URL = `${window.location.protocol}//${window.location.host}/api`;

// ========== Int38 HEX 解析器 ==========

/**
 * 解析 38 位有符号整数（从 10 字符的十六进制字符串）
 * 移植自 Int38Parser.java
 * @param {string} hexString - 10个字符的十六进制字符串（40位）
 * @returns {bigint} 解析后的有符号整数值
 */
function parseInt38(hexString) {
    // 将十六进制字符串转为 BigInt
    const value40bit = BigInt('0x' + hexString);
    
    // 转为二进制字符串并补齐到 40 位
    let binaryString = value40bit.toString(2);
    while (binaryString.length < 40) {
        binaryString = '0' + binaryString;
    }
    
    // 跳过前 2 位，取后 38 位
    const effectiveBits = binaryString.substring(2);
    
    // 将 38 位有效数据转为整数
    let value = BigInt('0b' + effectiveBits);
    
    // 检查是否是负数 (第 38 位为符号位，即 effectiveBits 的第一位)
    if (effectiveBits.charAt(0) === '1') {
        // 如果是负数，进行补码处理：value - 2^38
        const negativeOffset = BigInt(1) << BigInt(38);
        value = value - negativeOffset;
    }
    
    return value;
}

/**
 * 解析完整的 HEX 字符串，提取 ECEF X/Y/Z 坐标
 * @param {string} input - 完整的十六进制输入字符串（至少44个字符）
 * @returns {object} 包含 ecefX, ecefY, ecefZ 的对象，以及调试信息
 */
function parseEcefFromHex(input) {
    // 去除空格并转为小写
    input = input.replace(/\s/g, '').toLowerCase();
    
    if (input.length < 44) {
        throw new Error(`输入字符串长度不足：需要至少 44 个字符，当前 ${input.length} 个字符`);
    }
    
    // 提取各字段（与 Java 版本相同的位置）
    // substring(14, 24) -> 第 15 到 24 个字符（Java 的 0-indexed）
    const ecefXHex = input.substring(14, 24);
    const ecefYHex = input.substring(24, 34);
    const ecefZHex = input.substring(34, 44);
    
    // 解析每个字段
    const ecefXRaw = parseInt38(ecefXHex);
    const ecefYRaw = parseInt38(ecefYHex);
    const ecefZRaw = parseInt38(ecefZHex);
    
    // 除以 10000 得到米为单位的坐标
    const ecefX = Number(ecefXRaw) / 10000;
    const ecefY = Number(ecefYRaw) / 10000;
    const ecefZ = Number(ecefZRaw) / 10000;
    
    return {
        ecefX,
        ecefY,
        ecefZ,
        debug: {
            inputLength: input.length,
            ecefXHex,
            ecefYHex,
            ecefZHex,
            ecefXRaw: ecefXRaw.toString(),
            ecefYRaw: ecefYRaw.toString(),
            ecefZRaw: ecefZRaw.toString()
        }
    };
}

/**
 * 处理 HEX 解析按钮点击
 */
function handleParseHex() {
    const hexInput = document.getElementById('hexInput');
    const resultSection = document.getElementById('hexParseResult');
    const ecefXResult = document.getElementById('ecefXResult');
    const ecefYResult = document.getElementById('ecefYResult');
    const ecefZResult = document.getElementById('ecefZResult');
    const debugInfo = document.getElementById('hexDebugInfo');
    
    const input = hexInput.value.trim();
    
    if (!input) {
        showMessage('❌ 请输入十六进制字符串', 'error');
        return;
    }
    
    try {
        const result = parseEcefFromHex(input);
        
        // 显示结果（保留4位小数）
        ecefXResult.textContent = result.ecefX.toFixed(4);
        ecefYResult.textContent = result.ecefY.toFixed(4);
        ecefZResult.textContent = result.ecefZ.toFixed(4);
        
        // 更新调试信息
        debugInfo.innerHTML = `
            <div class="debug-section">
                <h4>🔍 解析详情</h4>
                <div class="debug-grid">
                    <div class="debug-item">
                        <span class="debug-label">输入长度:</span>
                        <span class="debug-value">${result.debug.inputLength} 字符</span>
                    </div>
                    <div class="debug-item">
                        <span class="debug-label">X 字段 HEX:</span>
                        <span class="debug-value hex-code">${result.debug.ecefXHex}</span>
                    </div>
                    <div class="debug-item">
                        <span class="debug-label">Y 字段 HEX:</span>
                        <span class="debug-value hex-code">${result.debug.ecefYHex}</span>
                    </div>
                    <div class="debug-item">
                        <span class="debug-label">Z 字段 HEX:</span>
                        <span class="debug-value hex-code">${result.debug.ecefZHex}</span>
                    </div>
                    <div class="debug-item">
                        <span class="debug-label">X 原始值 (×10000):</span>
                        <span class="debug-value">${result.debug.ecefXRaw}</span>
                    </div>
                    <div class="debug-item">
                        <span class="debug-label">Y 原始值 (×10000):</span>
                        <span class="debug-value">${result.debug.ecefYRaw}</span>
                    </div>
                    <div class="debug-item">
                        <span class="debug-label">Z 原始值 (×10000):</span>
                        <span class="debug-value">${result.debug.ecefZRaw}</span>
                    </div>
                </div>
            </div>
        `;
        
        // 显示结果区域
        resultSection.style.display = 'block';
        resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        
        showMessage('✅ 解析成功！', 'success');
        
    } catch (error) {
        console.error('HEX 解析错误:', error);
        showMessage(`❌ 解析失败：${error.message}`, 'error');
    }
}

/**
 * 清空 HEX 输入和结果
 */
function handleClearHex() {
    document.getElementById('hexInput').value = '';
    document.getElementById('hexParseResult').style.display = 'none';
    document.getElementById('hexDebugInfo').style.display = 'none';
}

/**
 * 切换调试信息显示
 */
function toggleHexDebug() {
    const debugInfo = document.getElementById('hexDebugInfo');
    if (debugInfo.style.display === 'none') {
        debugInfo.style.display = 'block';
    } else {
        debugInfo.style.display = 'none';
    }
}

/**
 * 复制全部 ECEF 坐标
 */
function copyAllEcef() {
    const x = document.getElementById('ecefXResult').textContent;
    const y = document.getElementById('ecefYResult').textContent;
    const z = document.getElementById('ecefZResult').textContent;
    
    const text = `ECEF_X: ${x} m\nECEF_Y: ${y} m\nECEF_Z: ${z} m`;
    copyToClipboard(text);
}

// ========== 原有代码 ==========

// 当前生成的文件信息
let currentFile = null;

// DOM 元素
const configForm = document.getElementById('configForm');
const resultSection = document.getElementById('resultSection');
const resultMessage = document.getElementById('resultMessage');
const downloadBtn = document.getElementById('downloadBtn');
const viewContentBtn = document.getElementById('viewContentBtn');
const startRtkcrvBtn = document.getElementById('startRtkcrvBtn');
const contentPreview = document.getElementById('contentPreview');
const configContent = document.getElementById('configContent');
const closePreviewBtn = document.getElementById('closePreviewBtn');
const configList = document.getElementById('configList');
const processList = document.getElementById('processList');
const processStatus = document.getElementById('processStatus');
const realtimeData = document.getElementById('realtimeData');
const connectionStatus = document.getElementById('connectionStatus');
const dataCount = document.getElementById('dataCount');
// 批量DOM
const batchInpstr1Base = document.getElementById('batchInpstr1Base');
const batchInpstr2 = document.getElementById('batchInpstr2');
const batchInpstr3 = document.getElementById('batchInpstr3');
const batchTxtFile = document.getElementById('batchTxtFile');
const batchTxtText = document.getElementById('batchTxtText');
const batchRunBtn = document.getElementById('batchRunBtn');
const batchClearBtn = document.getElementById('batchClearBtn');
const batchCancelBtn = document.getElementById('batchCancelBtn');
const batchResults = document.getElementById('batchResults');
const batchSummary = document.getElementById('batchSummary');
const batchTableContainer = document.getElementById('batchTableContainer');
const roundStatusEl = document.getElementById('roundStatus');
const roundAuxEl = document.getElementById('roundAux');
const batchRoundsInput = document.getElementById('batchRounds');
const batchRoundIntervalInput = document.getElementById('batchRoundInterval');
const batchConcurrencyInput = document.getElementById('batchConcurrency');

// SSE 连接
let eventSource = null;
const stationDataMap = new Map();
// 站点卡片清除定时器 - 稳定后10分钟自动清除
const stationClearTimers = new Map();
// 已清除的站点列表 - 防止重新出现
const clearedStations = new Set();

// 配置文件列表折叠状态（默认折叠：未在集合中视为折叠）
let expandedConfigItems = new Set();

// 配置文件列表：搜索与分页状态
let configFilesAll = [];
let configSearch = '';
let configPage = 1;
const configPageSize = 10;

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', async () => {
    // 依次加载，确保在连接 SSE 前已同步稳定结果，避免刷新后旧站点再次出现
    await loadConfigList();
    await loadProcessList();
    await loadStableResults(); // 加载稳定结果历史记录并先行隐藏已稳定站点
    await loadRoundState(); // 加载轮次状态
    setupEventListeners();
    connectSSE(); // 再连接实时数据流，避免竞态导致已稳定站点重新出现
    
    // 定期更新进程状态（每5秒）
    setInterval(() => {
        loadProcessList();
        if (currentFile) {
            updateProcessStatus(currentFile.fileName);
        }
    }, 5000);
    
    // 检查并清理超过10分钟的稳定站点（每分钟检查一次）
    setInterval(() => {
        checkAndClearStaleStations();
    }, 60000); // 每分钟检查一次
});

// 加载轮次状态
async function loadRoundState() {
    try {
        const resp = await fetch(`${API_BASE_URL}/round/state`);
        const json = await resp.json();
        if (json && json.success) {
            renderRoundState(json.state);
        }
    } catch (e) {
        // 忽略错误
    }
}

function renderRoundState(state) {
    if (!roundStatusEl || !roundAuxEl) return;
    try {
        if (!state || (!state.enabled && !state.batchActive)) {
            roundStatusEl.textContent = '轮次：--';
            roundStatusEl.className = 'status-badge stopped';
            roundAuxEl.textContent = '';
            return;
        }
        const round = state.currentRound || 1;
        const total = state.totalRounds || 1;
        roundStatusEl.textContent = `轮次：${round}/${total}`;
        if (state.enabled) {
            roundStatusEl.className = 'status-badge running';
        } else {
            roundStatusEl.className = 'status-badge info';
        }
        if (state.waiting && state.nextRoundAt) {
            const dt = new Date(state.nextRoundAt);
            const hh = String(dt.getHours()).padStart(2, '0');
            const mm = String(dt.getMinutes()).padStart(2, '0');
            roundAuxEl.textContent = `下次开始：${hh}:${mm}`;
        } else {
            roundAuxEl.textContent = `运行中：并发${state.running || 0}/${(state.running || 0) + (state.pending || 0)}`;
        }
    } catch (_) {}
}

// 设置事件监听器
function setupEventListeners() {
    // 表单提交
    configForm.addEventListener('submit', handleFormSubmit);
    
    // 下载按钮
    downloadBtn.addEventListener('click', handleDownload);
    
    // 查看内容按钮
    viewContentBtn.addEventListener('click', handleViewContent);
    
    // 启动 RTKRCV 按钮
    startRtkcrvBtn.addEventListener('click', handleStartRtkrcv);
    
    // 关闭预览按钮
    closePreviewBtn.addEventListener('click', () => {
        contentPreview.style.display = 'none';
    });

    // 批量运行
    if (batchRunBtn) batchRunBtn.addEventListener('click', handleBatchRun);
    if (batchClearBtn) batchClearBtn.addEventListener('click', () => {
        batchResults.style.display = 'none';
        batchSummary.innerHTML = '';
        batchTableContainer.innerHTML = '';
    });
    if (batchCancelBtn) batchCancelBtn.addEventListener('click', handleBatchCancel);
    
    // HEX 解析器事件
    const parseHexBtn = document.getElementById('parseHexBtn');
    const clearHexBtn = document.getElementById('clearHexBtn');
    const hexInput = document.getElementById('hexInput');
    
    if (parseHexBtn) parseHexBtn.addEventListener('click', handleParseHex);
    if (clearHexBtn) clearHexBtn.addEventListener('click', handleClearHex);
    
    // 支持按 Enter 键解析
    if (hexInput) {
        hexInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleParseHex();
            }
        });
    }
}

// 处理表单提交
async function handleFormSubmit(e) {
    e.preventDefault();
    
    // 获取表单数据
    const formData = {
        inpstr1: document.getElementById('inpstr1').value.trim(),
        inpstr2: document.getElementById('inpstr2').value.trim(),
        inpstr3: document.getElementById('inpstr3').value.trim(),
        outHeight: document.getElementById('outHeight').value
    };
    
    // 显示加载状态
    const submitBtn = configForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.innerHTML;
    submitBtn.innerHTML = '<span>⏳ 生成中...</span>';
    submitBtn.disabled = true;
    
    try {
        const response = await fetch(`${API_BASE_URL}/generate-config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(formData)
        });
        
        const result = await response.json();
        
        if (result.success) {
            // 保存当前文件信息
            currentFile = {
                fileName: result.fileName,
                content: result.content
            };
            
            // 显示成功消息
            showResult(result.message, 'success');
            
            // 刷新配置文件列表
            await loadConfigList();
            
            // 滚动到结果区域
            resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
            showResult(result.message, 'error');
        }
    } catch (error) {
        console.error('Error:', error);
        showResult('网络错误，请检查服务器是否运行', 'error');
    } finally {
        // 恢复按钮状态
        submitBtn.innerHTML = originalText;
        submitBtn.disabled = false;
    }
}

// 中断批量（清空队列，可选停止正在运行）
async function handleBatchCancel() {
    try {
        const stopRunning = confirm('是否同时停止正在运行的解算进程？\n确定=清空队列并停止正在运行，取消=仅清空队列');
        const btn = batchCancelBtn;
        const original = btn.innerHTML;
        btn.innerHTML = '⏳ 处理中...';
        btn.disabled = true;

        const resp = await fetch(`${API_BASE_URL}/batch/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stopRunning })
        });
        const result = await resp.json();
        if (!result.success) {
            showMessage(`❌ 中断失败：${result.message || '未知错误'}`, 'error');
            return;
        }
        const msg = stopRunning
            ? `✅ 已清空队列(${result.clearedQueued})，并停止 ${result.stoppedRunning}/${result.runningBefore} 个运行中的进程`
            : `✅ 已清空队列(${result.clearedQueued})；正在运行的 ${result.runningBefore} 个将继续直至结束`;
        showMessage(msg, 'success');

        // 刷新进程列表
        await loadProcessList();
    } catch (e) {
        console.error(e);
        showMessage('❌ 中断失败，请检查网络与服务', 'error');
    } finally {
        batchCancelBtn.innerHTML = '⏹ 中断批量';
        batchCancelBtn.disabled = false;
    }
}

// 处理批量运行
async function handleBatchRun() {
    try {
        const base = (batchInpstr1Base.value || '').trim();
        if (!base) {
            showMessage('❌ 请输入公共前缀 inpstr1Base', 'error');
            return;
        }

        // 读取TXT内容：优先文件，其次文本域
        let txtContent = (batchTxtText.value || '').trim();
        const file = batchTxtFile.files && batchTxtFile.files[0];
        if (file) {
            txtContent = await readFileAsText(file);
        }
        if (!txtContent) {
            showMessage('❌ 请上传TXT文件或粘贴TXT内容', 'error');
            return;
        }

        // 构建请求体
        const payload = {
            txtContent,
            inpstr1Base: base
        };
        const v2 = (batchInpstr2.value || '').trim();
        const v3 = (batchInpstr3.value || '').trim();
        if (v2) payload.inpstr2 = v2;
        if (v3) payload.inpstr3 = v3;
        const concVal = parseInt((batchConcurrencyInput && batchConcurrencyInput.value) || '5', 10);
        if (!isNaN(concVal) && concVal > 0) payload.concurrency = concVal;
        // 多轮参数
        const roundsVal = parseInt((batchRoundsInput && batchRoundsInput.value) || '1', 10);
        if (!isNaN(roundsVal) && roundsVal >= 2) {
            payload.rounds = roundsVal;
            const intervalVal = parseInt((batchRoundIntervalInput && batchRoundIntervalInput.value) || '20', 10);
            if (!isNaN(intervalVal) && intervalVal > 0) {
                payload.roundIntervalMinutes = intervalVal;
            }
        }

        // 按钮loading
        const original = batchRunBtn.innerHTML;
        batchRunBtn.innerHTML = '⏳ 执行中...';
        batchRunBtn.disabled = true;

        const resp = await fetch(`${API_BASE_URL}/batch/run-txt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await resp.json();

        if (!result.success) {
            showMessage(`❌ 执行失败：${result.message || '未知错误'}`, 'error');
            return;
        }

        // 展示结果
        renderBatchResults(result);
        showMessage(`✅ 批量执行完成：成功 ${result.started}，失败 ${result.failed}`, 'success');
        // 刷新进程列表
        await loadProcessList();
    } catch (e) {
        console.error(e);
        showMessage('❌ 执行失败，请检查网络与服务', 'error');
    } finally {
        batchRunBtn.innerHTML = '🚀 批量运行';
        batchRunBtn.disabled = false;
    }
}

function renderBatchResults(result) {
    batchResults.style.display = 'block';
    batchSummary.innerHTML = `
        <div class="message message-info">
            共 ${result.total} 个站点；本次立即启动 <strong>${result.started}</strong> 个，失败 <strong>${result.failed}</strong> 个${typeof result.queued === 'number' ? `，已排队 <strong>${result.queued}</strong> 个（并发=${result.concurrency || '-'}，当前运行=${result.running || 0}）` : ''}
        </div>
    `;

    const rowsStarted = (result.results || []).map((r) => {
        if (r.success) {
            return `
                <tr>
                    <td><strong>${r.stationId}</strong></td>
                    <td><span class="status-badge running">成功</span></td>
                    <td>${r.pid || '-'}</td>
                    <td>${r.configFile || '-'}</td>
                    <td>${
                        r.logFile
                        ? `<a href="#" onclick="viewLog('${r.logFile}'); return false;">${r.logFile}</a>`
                        : '-'
                    }</td>
                    <td>-</td>
                </tr>
            `;
        } else {
            return `
                <tr>
                    <td><strong>${r.stationId}</strong></td>
                    <td><span class="status-badge stopped">失败</span></td>
                    <td>-</td>
                    <td>-</td>
                    <td>-</td>
                    <td style="color:#c0392b;">${(r.error || '').replace(/</g,'&lt;')}</td>
                </tr>
            `;
        }
    }).join('');

    // 若有排队数量但没有逐项列表，则给出提示行
    const rowsQueued = (typeof result.queued === 'number' && result.queued > 0)
        ? `<tr><td colspan="6" style="color:#666;">其余 ${result.queued} 个站点已进入队列，达到稳定或进程退出后将自动补位启动</td></tr>`
        : '';

    batchTableContainer.innerHTML = `
        <table class="results-table">
            <thead>
                <tr>
                    <th>站点编号</th>
                    <th>状态</th>
                    <th>PID</th>
                    <th>配置文件</th>
                    <th>日志</th>
                    <th>错误</th>
                </tr>
            </thead>
            <tbody>
                ${rowsStarted}${rowsQueued}
            </tbody>
        </table>
    `;

    batchResults.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = reject;
        reader.readAsText(file);
    });
}

// 显示结果
function showResult(message, type) {
    resultSection.style.display = 'block';
    
    const messageClass = type === 'success' ? 'message-success' : 'message-error';
    resultMessage.innerHTML = `
        <div class="message ${messageClass}">
            ${type === 'success' ? '✅' : '❌'} ${message}
        </div>
    `;
}

// 处理下载
function handleDownload() {
    if (currentFile) {
        window.location.href = `${API_BASE_URL}/download/${currentFile.fileName}`;
    }
}

// 查看内容
function handleViewContent() {
    if (currentFile) {
        configContent.textContent = currentFile.content;
        contentPreview.style.display = 'block';
        contentPreview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

// 预览指定配置文件
async function previewConfigFile(fileName) {
    try {
        const response = await fetch(`${API_BASE_URL}/config/content/${fileName}`);
        const result = await response.json();
        if (result.success) {
            configContent.textContent = result.content || '文件为空';
            contentPreview.style.display = 'block';
            contentPreview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
            showMessage(`❌ 预览失败: ${result.message}`, 'error');
        }
    } catch (error) {
        console.error('Error previewing config:', error);
        showMessage('❌ 预览失败', 'error');
    }
}

// 启动 RTKRCV
async function handleStartRtkrcv() {
    if (!currentFile) return;
    
    const originalText = startRtkcrvBtn.innerHTML;
    startRtkcrvBtn.innerHTML = '<span>⏳ 启动中...</span>';
    startRtkcrvBtn.disabled = true;
    
    try {
        const response = await fetch(`${API_BASE_URL}/rtkrcv/start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                configFile: currentFile.fileName
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showMessage(`✅ ${result.message}`, 'success');
            
            // 从已清除列表中移除（允许接收新数据）
            const stationId = currentFile.fileName.replace('.conf', '');
            clearedStations.delete(stationId);
            console.log(`🔓 站点 ${stationId} 允许接收数据`);
            
            // 更新进程状态
            await updateProcessStatus(currentFile.fileName);
            await loadProcessList();
            
            // 更新按钮状态
            startRtkcrvBtn.innerHTML = '<span>🛑 停止 RTKRCV</span>';
            startRtkcrvBtn.classList.remove('btn-primary');
            startRtkcrvBtn.classList.add('btn-danger');
            startRtkcrvBtn.onclick = handleStopRtkrcv;
            startRtkcrvBtn.disabled = false;
        } else {
            showMessage(`❌ ${result.message}`, 'error');
            startRtkcrvBtn.innerHTML = originalText;
            startRtkcrvBtn.disabled = false;
        }
    } catch (error) {
        console.error('Error:', error);
        showMessage('❌ 启动失败，请检查 RTKRCV 是否已安装', 'error');
        startRtkcrvBtn.innerHTML = originalText;
        startRtkcrvBtn.disabled = false;
    }
}

// 停止 RTKRCV
async function handleStopRtkrcv() {
    if (!currentFile) return;
    
    const originalText = startRtkcrvBtn.innerHTML;
    startRtkcrvBtn.innerHTML = '<span>⏳ 停止中...</span>';
    startRtkcrvBtn.disabled = true;
    
    try {
        const response = await fetch(`${API_BASE_URL}/rtkrcv/stop`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                configFile: currentFile.fileName
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showMessage(`✅ ${result.message}`, 'success');
            
            // 隐藏进程状态
            processStatus.style.display = 'none';
            await loadProcessList();
            
            // 恢复按钮状态
            startRtkcrvBtn.innerHTML = '<span>🚀 启动 RTKRCV</span>';
            startRtkcrvBtn.classList.remove('btn-danger');
            startRtkcrvBtn.classList.add('btn-primary');
            startRtkcrvBtn.onclick = handleStartRtkrcv;
            startRtkcrvBtn.disabled = false;
        } else {
            showMessage(`❌ ${result.message}`, 'error');
            startRtkcrvBtn.innerHTML = originalText;
            startRtkcrvBtn.disabled = false;
        }
    } catch (error) {
        console.error('Error:', error);
        showMessage('❌ 停止失败', 'error');
        startRtkcrvBtn.innerHTML = originalText;
        startRtkcrvBtn.disabled = false;
    }
}

// 更新进程状态显示
async function updateProcessStatus(configFile) {
    try {
        const response = await fetch(`${API_BASE_URL}/rtkrcv/status/${configFile}`);
        const result = await response.json();
        
        if (result.success && result.running) {
            const uptime = formatUptime(result.uptime);
            
            processStatus.innerHTML = `
                <div class="process-status-info">
                    <div class="process-status-item">
                        <span class="process-status-label">状态:</span>
                        <span class="status-badge running">运行中</span>
                    </div>
                    <div class="process-status-item">
                        <span class="process-status-label">进程 PID:</span>
                        <span class="process-status-value">${result.pid}</span>
                    </div>
                    <div class="process-status-item">
                        <span class="process-status-label">运行时间:</span>
                        <span class="process-status-value">${uptime}</span>
                    </div>
                    <div class="process-status-item">
                        <span class="process-status-label">日志文件:</span>
                        <span class="process-status-value">
                            <a href="#" onclick="viewLog('${result.logFile}'); return false;">${result.logFile}</a>
                        </span>
                    </div>
                </div>
            `;
            processStatus.style.display = 'block';
            
            // 更新按钮状态
            startRtkcrvBtn.innerHTML = '<span>🛑 停止 RTKRCV</span>';
            startRtkcrvBtn.classList.remove('btn-primary');
            startRtkcrvBtn.classList.add('btn-danger');
            startRtkcrvBtn.onclick = handleStopRtkrcv;
            startRtkcrvBtn.disabled = false;
        } else {
            processStatus.style.display = 'none';
            
            // 恢复按钮状态
            startRtkcrvBtn.innerHTML = '<span>🚀 启动 RTKRCV</span>';
            startRtkcrvBtn.classList.remove('btn-danger');
            startRtkcrvBtn.classList.add('btn-primary');
            startRtkcrvBtn.onclick = handleStartRtkrcv;
            startRtkcrvBtn.disabled = false;
        }
    } catch (error) {
        console.error('Error updating process status:', error);
    }
}

// 加载配置文件列表
async function loadConfigList() {
    try {
        const response = await fetch(`${API_BASE_URL}/configs`);
        const result = await response.json();
        
        if (result.success) {
            configFilesAll = Array.isArray(result.files) ? result.files : [];
            configPage = 1;
            renderConfigList();
        } else {
            configList.innerHTML = '<p class="empty-state">加载失败</p>';
        }
    } catch (error) {
        console.error('Error loading config list:', error);
        configList.innerHTML = '<p class="empty-state">无法连接到服务器</p>';
    }
}

// 显示配置文件列表
function onConfigSearch(value) {
    configSearch = (value || '').trim();
    configPage = 1;
    renderConfigList();
}

function goToConfigPage(page) {
    configPage = page;
    renderConfigList();
}

function expandAllConfigs() {
    const current = getFilteredPagedConfigFiles();
    current.forEach(f => expandedConfigItems.add(f.name));
    renderConfigList();
}

function collapseAllConfigs() {
    const current = getFilteredPagedConfigFiles();
    current.forEach(f => expandedConfigItems.delete(f.name));
    renderConfigList();
}

function getFilteredPagedConfigFiles() {
    const keyword = configSearch.toLowerCase();
    const filtered = keyword
        ? configFilesAll.filter(file => {
            const name = String(file.name || '').toLowerCase();
            const station = name.endsWith('.conf') ? name.replace(/\.conf$/, '') : name;
            return name.includes(keyword) || station.includes(keyword);
        })
        : configFilesAll.slice();

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / configPageSize));
    if (configPage > totalPages) configPage = totalPages;
    if (configPage < 1) configPage = 1;
    const start = (configPage - 1) * configPageSize;
    return filtered.slice(start, start + configPageSize);
}

function renderConfigList() {
    if (!Array.isArray(configFilesAll) || configFilesAll.length === 0) {
        configList.innerHTML = '<p class="empty-state">📭 还没有生成任何配置文件</p>';
        return;
    }
    // 记录输入框焦点
    const activeEl = document.activeElement;
    const hadFocus = activeEl && activeEl.id === 'configSearchInput';
    let caretPos = null;
    if (hadFocus) {
        try { caretPos = activeEl.selectionStart; } catch (e) {}
    }

    const keyword = configSearch.toLowerCase();
    const filtered = keyword
        ? configFilesAll.filter(file => {
            const name = String(file.name || '').toLowerCase();
            const station = name.endsWith('.conf') ? name.replace(/\.conf$/, '') : name;
            return name.includes(keyword) || station.includes(keyword);
        })
        : configFilesAll.slice();

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / configPageSize));
    if (configPage > totalPages) configPage = totalPages;
    if (configPage < 1) configPage = 1;
    const start = (configPage - 1) * configPageSize;
    const current = filtered.slice(start, start + configPageSize);

    const controls = `
        <div class="config-controls" style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap: wrap; margin-bottom: 10px;">
            <div class="search-box" style="flex:1; min-width:220px;">
                <input id="configSearchInput" type="text" class="input" placeholder="按文件名/站点编号查询" value="${configSearch.replace(/"/g, '&quot;')}" oninput="onConfigSearch(this.value)" style="width:100%; padding:8px 10px;">
            </div>
            <div class="actions" style="display:flex; gap:8px;">
                <button class="btn btn-secondary btn-small" onclick="expandAllConfigs()">全部展开</button>
                <button class="btn btn-secondary btn-small" onclick="collapseAllConfigs()">全部折叠</button>
            </div>
            <div class="pagination" style="display:flex; align-items:center; gap:6px;">
                <button class="btn btn-small" ${configPage===1 ? 'disabled' : ''} onclick="goToConfigPage(${Math.max(1, configPage-1)})">« 上一页</button>
                ${Array.from({length: totalPages}).map((_, idx) => {
                    const p = idx + 1;
                    return `<button class="btn btn-small ${p===configPage ? 'btn-secondary' : ''}" onclick="goToConfigPage(${p})">${p}</button>`;
                }).join('')}
                <button class="btn btn-small" ${configPage===totalPages ? 'disabled' : ''} onclick="goToConfigPage(${Math.min(totalPages, configPage+1)})">下一页 »</button>
                <span style="margin-left:8px; color:#666;">共 ${total} 条，每页 ${configPageSize} 条</span>
            </div>
        </div>
    `;

    const listHtml = current.map(file => {
        const isExpanded = expandedConfigItems.has(file.name);
        const arrow = isExpanded ? '▼' : '▶';
        const expandedClass = isExpanded ? 'expanded' : '';
        const detailsDisplay = isExpanded ? 'block' : 'none';
        return `
        <div class="config-item ${expandedClass}">
            <button class="config-item-header" onclick="toggleConfigItem('${file.name}')">
                <div class="left">
                    <span class="disclosure">${arrow}</span>
                    <span class="config-item-name">📄 ${file.name}</span>
                </div>
                <div class="config-item-date">创建时间: ${formatDate(file.created)}</div>
            </button>
            <div id="configDetails_${file.name}" class="config-item-details" style="display:${detailsDisplay};">
                ${file.logFile ? `
                <div class="config-item-logs" style="margin-bottom:8px;">
                    <span class="log-label">日志:</span>
                    <span class="log-item">
                        <a href="#" onclick="viewLog('${file.logFile}'); return false;">📝 ${file.logFile}</a>
                        <button class="btn-icon" onclick="downloadFile('${file.logFile}'); return false;" title="下载">📥</button>
                        <button class="btn-icon" onclick="deleteLogFile('${file.logFile}'); return false;" title="删除">🗑️</button>
                    </span>
                </div>
                ` : ''}
                <div class="config-item-actions">
                    <button class="btn btn-primary btn-small" onclick="startRtkcrvFromList('${file.name}')">🚀 启动</button>
                    <button class="btn btn-secondary btn-small" onclick="previewConfigFile('${file.name}')">👁️ 预览</button>
                    <button class="btn btn-success btn-small" onclick="downloadFile('${file.name}')">📥 下载</button>
                    <button class="btn btn-danger btn-small" onclick="deleteConfigFile('${file.name}')">🗑️ 删除</button>
                </div>
            </div>
        </div>`;
    }).join('');

    configList.innerHTML = controls + listHtml;

    // 恢复输入框焦点
    const inputEl = document.getElementById('configSearchInput');
    if (inputEl && hadFocus) {
        inputEl.focus();
        const pos = (caretPos != null) ? caretPos : inputEl.value.length;
        try { inputEl.setSelectionRange(pos, pos); } catch (e) {}
    }
}

// 切换配置项折叠/展开
function toggleConfigItem(fileName) {
    const detailsId = `configDetails_${fileName}`;
    const detailsEl = document.getElementById(detailsId);
    if (!detailsEl) return;
    const isHidden = detailsEl.style.display === 'none' || detailsEl.style.display === '';
    if (isHidden) {
        detailsEl.style.display = 'block';
        expandedConfigItems.add(fileName);
    } else {
        detailsEl.style.display = 'none';
        expandedConfigItems.delete(fileName);
    }
    // 同步箭头与外层样式
    const headerEl = detailsEl.previousElementSibling;
    if (headerEl) {
        const icon = headerEl.querySelector('.disclosure');
        if (icon) icon.textContent = isHidden ? '▼' : '▶';
    }
    const rootEl = detailsEl.parentElement;
    if (rootEl && rootEl.classList.contains('config-item')) {
        if (isHidden) rootEl.classList.add('expanded');
        else rootEl.classList.remove('expanded');
    }
}

// 下载指定文件
function downloadFile(fileName) {
    window.location.href = `${API_BASE_URL}/download/${fileName}`;
}

// 从配置列表启动 RTKRCV
async function startRtkcrvFromList(configFile) {
    try {
        const response = await fetch(`${API_BASE_URL}/rtkrcv/start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ configFile })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showMessage(`✅ ${result.message}`, 'success');
            
            // 从已清除列表中移除（允许接收新数据）
            const stationId = configFile.replace('.conf', '');
            clearedStations.delete(stationId);
            console.log(`🔓 站点 ${stationId} 允许接收数据`);
            
            await loadProcessList();
        } else {
            showMessage(`❌ ${result.message}`, 'error');
        }
    } catch (error) {
        console.error('Error:', error);
        showMessage('❌ 启动失败，请检查 RTKRCV 是否已安装', 'error');
    }
}

// 删除配置文件
async function deleteConfigFile(fileName) {
    if (!confirm(`确定要删除配置文件 ${fileName} 吗？此操作无法撤销。`)) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE_URL}/config/delete/${fileName}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (result.success) {
            showMessage(`✅ ${result.message}`, 'success');
            await loadConfigList(); // 刷新列表
        } else {
            showMessage(`❌ ${result.message}`, 'error');
        }
    } catch (error) {
        console.error('Error:', error);
        showMessage('❌ 删除失败', 'error');
    }
}

// 删除日志文件
async function deleteLogFile(fileName) {
    if (!confirm(`确定要删除日志文件 ${fileName} 吗？此操作无法撤销。`)) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE_URL}/log/delete/${fileName}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (result.success) {
            showMessage(`✅ ${result.message}`, 'success');
            await loadConfigList(); // 刷新列表
        } else {
            showMessage(`❌ ${result.message}`, 'error');
        }
    } catch (error) {
        console.error('Error:', error);
        showMessage('❌ 删除日志文件失败', 'error');
    }
}

// 加载进程列表
async function loadProcessList() {
    try {
        const response = await fetch(`${API_BASE_URL}/rtkrcv/status`);
        const result = await response.json();
        
        if (result.success) {
            displayProcessList(result.processes);
        }
    } catch (error) {
        console.error('Error loading process list:', error);
    }
}

// 显示进程列表
function displayProcessList(processes) {
    if (processes.length === 0) {
        processList.innerHTML = '<p class="empty-state">⚡ 暂无运行中的进程</p>';
        return;
    }
    
    processList.innerHTML = processes.map(proc => `
        <div class="process-item">
            <div class="process-item-info">
                <div class="process-item-title">
                    <span class="status-badge running">运行中</span>
                    <span>${proc.configFile}</span>
                </div>
                <div class="process-item-details">
                    <span>🆔 PID: ${proc.pid}</span>
                    <span>⏱️ 运行时间: ${formatUptime(proc.uptime)}</span>
                    <span>📝 <a href="#" onclick="viewLog('${proc.logFile}'); return false;">查看日志</a></span>
                </div>
            </div>
            <div class="process-item-actions">
                <button class="btn btn-danger btn-small" onclick="stopProcess('${proc.configFile}')">
                    🛑 停止
                </button>
            </div>
        </div>
    `).join('');
}

// 停止指定进程
async function stopProcess(configFile) {
    if (!confirm(`确定要停止 ${configFile} 的 RTKRCV 进程吗？`)) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE_URL}/rtkrcv/stop`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ configFile })
        });
        
        const result = await response.json();
        
        if (result.success) {
            showMessage(`✅ ${result.message}`, 'success');
            await loadProcessList();
            
            // 如果停止的是当前文件，更新状态
            if (currentFile && currentFile.fileName === configFile) {
                processStatus.style.display = 'none';
                startRtkcrvBtn.innerHTML = '<span>🚀 启动 RTKRCV</span>';
                startRtkcrvBtn.classList.remove('btn-danger');
                startRtkcrvBtn.classList.add('btn-primary');
                startRtkcrvBtn.onclick = handleStartRtkrcv;
            }
            
            // 启动10分钟清除定时器（手动停止时也触发）
            const stationId = configFile.replace('.conf', '');
            scheduleCardClear(stationId);
        } else {
            alert(`停止失败: ${result.message}`);
        }
    } catch (error) {
        console.error('Error:', error);
        alert('停止失败，请重试');
    }
}

// 查看日志
async function viewLog(logFile) {
    try {
        const response = await fetch(`${API_BASE_URL}/rtkrcv/log/${logFile}`);
        const result = await response.json();
        
        if (result.success) {
            configContent.textContent = result.content || '日志文件为空';
            contentPreview.style.display = 'block';
            contentPreview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
            alert(`无法读取日志: ${result.message}`);
        }
    } catch (error) {
        console.error('Error:', error);
        alert('读取日志失败');
    }
}

// 格式化运行时间
function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    const parts = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0) parts.push(`${minutes}分钟`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}秒`);
    
    return parts.join(' ');
}

// 显示消息提示
function showMessage(message, type) {
    const messageClass = type === 'success' ? 'message-success' : 
                         type === 'info' ? 'message-info' : 'message-error';
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${messageClass}`;
    messageDiv.textContent = message;
    messageDiv.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 9999; min-width: 300px; max-width: 500px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);';
    
    document.body.appendChild(messageDiv);
    
    // 根据类型调整显示时间
    const duration = type === 'info' ? 5000 : 3000;
    
    setTimeout(() => {
        messageDiv.style.opacity = '0';
        messageDiv.style.transition = 'opacity 0.5s';
        setTimeout(() => messageDiv.remove(), 500);
    }, duration);
}

// 格式化日期
function formatDate(dateString) {
    const date = new Date(dateString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// 表单验证辅助函数
function validateNtripPath(path) {
    // 基本格式验证: user:pass@host:port/mountpoint
    const pattern = /^[^:]+:[^@]*@[^:]+:\d+\/.+$/;
    return pattern.test(path);
}

// ========== HEX 配置生成 ==========

// 将字符串转换为十六进制
function stringToHex(str) {
    let hex = '';
    for (let i = 0; i < str.length; i++) {
        const charCode = str.charCodeAt(i);
        const hexValue = charCode.toString(16).toUpperCase().padStart(2, '0');
        hex += hexValue + ' ';
    }
    return hex.trim();
}

// 生成 POLCFGBASE 配置字符串和十六进制
function generatePolcfgbaseHex(lat, lon, height) {
    // 生成配置字符串：$POLCFGBASE,纬度,经度,高度\r\n\r\n
    const configString = `$POLCFGBASE,${lat},${lon},${height}\r\n\r\n`;
    
    // 转换为十六进制
    const hexString = stringToHex(configString);
    
    return {
        string: configString,
        hex: hexString,
        // 去除换行符的显示版本
        displayString: `$POLCFGBASE,${lat},${lon},${height}`
    };
}

// 复制到剪贴板
function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            showMessage('✅ 已复制到剪贴板', 'success');
        }).catch(err => {
            // 降级方案
            fallbackCopyToClipboard(text);
        });
    } else {
        // 降级方案
        fallbackCopyToClipboard(text);
    }
}

// 降级复制方案
function fallbackCopyToClipboard(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.select();
    try {
        document.execCommand('copy');
        showMessage('✅ 已复制到剪贴板', 'success');
    } catch (err) {
        showMessage('❌ 复制失败，请手动复制', 'error');
    }
    document.body.removeChild(textArea);
}

// 显示HEX配置
function showHexConfig(stationId, lat, lon, height) {
    // 生成配置
    const config = generatePolcfgbaseHex(lat, lon, height);
    
    // 格式化输出：站点编号 十六进制 原始字符串
    const formattedOutput = `${stationId} ${config.hex} ${config.displayString}`;
    
    // 获取显示区域
    const hexSection = document.getElementById(`hexConfig_${stationId}`);
    const contentDiv = hexSection.querySelector('.hex-config-content');
    
    // 生成HTML内容
    contentDiv.innerHTML = `
        <div class="hex-line">
            <div class="hex-label">站点编号:</div>
            <div class="hex-value station-id">${stationId}</div>
        </div>
        
        <div class="hex-line">
            <div class="hex-label">十六进制:</div>
            <div class="hex-value hex-code">
                <code>${config.hex}</code>
                <button class="btn btn-small btn-copy" onclick="copyToClipboard('${config.hex}')">
                    📋 复制
                </button>
            </div>
        </div>
        
        <div class="hex-line">
            <div class="hex-label">原始字符串:</div>
            <div class="hex-value config-string">
                <code>${config.displayString}</code>
                <button class="btn btn-small btn-copy" onclick="copyToClipboard('${config.displayString}')">
                    📋 复制
                </button>
            </div>
        </div>
        
        <div class="hex-note">
            <strong>📝 使用说明：</strong>
            <ul>
                <li>十六进制可直接发送到串口设备</li>
                <li>原始字符串为 POLCFGBASE 协议格式</li>
                <li>坐标精度：纬度/经度 9位小数，高度 4位小数</li>
            </ul>
        </div>
    `;
    
    // 显示配置区域
    hexSection.style.display = 'block';
    
    // 平滑滚动到配置区域
    hexSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    
    console.log('Generated HEX config:', formattedOutput);
}

// 隐藏HEX配置
function hideHexConfig(stationId) {
    const hexSection = document.getElementById(`hexConfig_${stationId}`);
    if (hexSection) {
        hexSection.style.display = 'none';
    }
}

// 从历史记录显示HEX配置（模态框）
function showHistoryHexModal(stationId, lat, lon, height) {
    // 生成配置
    const config = generatePolcfgbaseHex(lat, lon, height);
    
    // 格式化输出：站点编号 十六进制 原始字符串
    const formattedOutput = `${stationId} ${config.hex} ${config.displayString}`;
    
    // 获取模态框
    const modal = document.getElementById('hexModal');
    const modalBody = document.getElementById('hexModalBody');
    
    // 生成HTML内容
    modalBody.innerHTML = `
        <div class="hex-modal-content">
            <div class="hex-line">
                <div class="hex-label">站点编号:</div>
                <div class="hex-value station-id">${stationId}</div>
            </div>
            
            <div class="hex-line">
                <div class="hex-label">十六进制:</div>
                <div class="hex-value hex-code">
                    <code>${config.hex}</code>
                    <button class="btn btn-small btn-copy" onclick="copyToClipboard('${config.hex.replace(/'/g, "\\'")}')">
                        📋 复制
                    </button>
                </div>
            </div>
            
            <div class="hex-line">
                <div class="hex-label">原始字符串:</div>
                <div class="hex-value config-string">
                    <code>${config.displayString}</code>
                    <button class="btn btn-small btn-copy" onclick="copyToClipboard('${config.displayString}')">
                        📋 复制
                    </button>
                </div>
            </div>
            
            <div class="hex-note">
                <strong>📝 使用说明：</strong>
                <ul>
                    <li>十六进制可直接发送到串口设备</li>
                    <li>原始字符串为 POLCFGBASE 协议格式</li>
                    <li>坐标来源：历史测量记录</li>
                </ul>
            </div>
        </div>
    `;
    
    // 显示模态框
    modal.style.display = 'flex';
    
    console.log('Generated HEX config from history:', formattedOutput);
}

// 关闭HEX配置模态框
function closeHexModal() {
    const modal = document.getElementById('hexModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// 点击模态框外部关闭
window.addEventListener('click', (event) => {
    const modal = document.getElementById('hexModal');
    if (event.target === modal) {
        closeHexModal();
    }
});

// 添加实时验证
document.getElementById('inpstr1').addEventListener('blur', function() {
    if (this.value && !validateNtripPath(this.value)) {
        this.style.borderColor = 'var(--danger-color)';
    } else {
        this.style.borderColor = '';
    }
});

document.getElementById('inpstr2').addEventListener('blur', function() {
    if (this.value && !validateNtripPath(this.value)) {
        this.style.borderColor = 'var(--danger-color)';
    } else {
        this.style.borderColor = '';
    }
});

document.getElementById('inpstr3').addEventListener('blur', function() {
    if (this.value && !validateNtripPath(this.value)) {
        this.style.borderColor = 'var(--danger-color)';
    } else {
        this.style.borderColor = '';
    }
});

// ========== 实时数据处理 ==========

// 连接 SSE 流
function connectSSE() {
    if (eventSource) {
        eventSource.close();
    }
    
    updateConnectionStatus('connecting');
    
    eventSource = new EventSource(`${API_BASE_URL}/rtkrcv/stream`);
    
    eventSource.onopen = () => {
        console.log('SSE connected');
        updateConnectionStatus('connected');
    };
    
    eventSource.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            handleSSEMessage(message);
        } catch (error) {
            console.error('Error parsing SSE message:', error);
        }
    };
    
    eventSource.onerror = (error) => {
        console.error('SSE error:', error);
        updateConnectionStatus('error');
        
        // 5秒后重连
        setTimeout(() => {
            console.log('Reconnecting SSE...');
            connectSSE();
        }, 5000);
    };
}

// 处理 SSE 消息
function handleSSEMessage(message) {
    if (message.type === 'connected') {
        console.log('SSE client ID:', message.clientId);
    } else if (message.type === 'rtkrcv_data') {
        updateStationData(message.data);
    } else if (message.type === 'station_stable') {
        handleStationStable(message.data);
    } else if (message.type === 'rtkrcv_auto_stopped') {
        handleRtkcrvAutoStopped(message.data);
    } else if (message.type === 'rtkrcv_manual_stopped') {
        handleRtkcrvManualStopped(message.data);
    } else if (message.type === 'round_completed') {
        handleRoundCompleted(message.data);
    } else if (message.type === 'round_started') {
        handleRoundStarted(message.data);
    } else if (message.type === 'stable_results_cleared') {
        handleStableResultsCleared(message.data);
    }
}

// 处理轮次完成：清除本轮所有站点卡片与缓存
function handleRoundCompleted(data) {
    try {
        const round = data && Number.isFinite(data.round) ? data.round : 1;
        const totalRounds = data && Number.isFinite(data.totalRounds) ? data.totalRounds : 1;
        const stationIds = Array.isArray(data && data.stationIds) ? data.stationIds : [];
        const successIds = new Set(Array.isArray(data && data.successIds) ? data.successIds : []);
        const failIds = new Set(Array.isArray(data && data.failIds) ? data.failIds : []);

        // 清除卡片与本地缓存
        stationIds.forEach((sid) => {
            clearStationCard(String(sid));
        });

        // 清空“稳定结果历史记录”以便新一轮开始
        try {
            stableResultsAll = [];
            renderStableResults();
        } catch (_) {}

        renderRealtimeData();
        showMessage(`✅ 轮次 ${round}/${totalRounds} 完成：已清除 ${stationIds.length} 个站点卡片（成功 ${successIds.size}，失败 ${failIds.size}）`, 'success');
    } catch (e) {
        console.warn('handleRoundCompleted error:', e);
    }
}

// 处理轮次开始：更新轮次状态
function handleRoundStarted(data) {
    try {
        const round = data && Number.isFinite(data.round) ? data.round : 1;
        const totalRounds = data && Number.isFinite(data.totalRounds) ? data.totalRounds : 1;

        // 新一轮开始：清空禁止显示集合与清理定时器，确保新数据可显示
        try {
            clearedStations.clear();
            stationClearTimers.forEach((info, sid) => {
                try { clearTimeout(info.timerId); } catch (_) {}
            });
            stationClearTimers.clear();
        } catch (_) {}

        renderRoundState({
            enabled: totalRounds > 1,
            currentRound: round,
            totalRounds: totalRounds,
            waiting: false,
            batchActive: true,
            running: 0,
            pending: data && data.count ? data.count : 0
        });
        showMessage(`🚀 开始第 ${round}/${totalRounds} 轮，站点数：${data && data.count ? data.count : 0}`, 'info');
    } catch (e) {
        console.warn('handleRoundStarted error:', e);
    }
}

// 处理清空稳定结果历史
function handleStableResultsCleared(data) {
    try {
        stableResultsAll = [];
        renderStableResults();
        showMessage('🧹 已清空稳定结果历史记录（新一轮开始前释放空间）', 'info');
    } catch (e) {
        console.warn('handleStableResultsCleared error:', e);
    }
}

// 处理站点达到稳定状态
function handleStationStable(data) {
    console.log(`🎉 站点 ${data.stationId} 达到稳定状态！`, data);
    
    // 更新站点数据（添加稳定标识）
    const stationData = stationDataMap.get(data.stationId);
    if (stationData) {
        stationData.stability = {
            stable: true,
            collecting: false
        };
        stationData.average = data.average;
        stationDataMap.set(data.stationId, stationData);
        renderRealtimeData();
    }
    
    // 显示通知
    showMessage(`🎉 站点 ${data.stationId} 已稳定！收集了 ${data.sampleCount} 个样本，用时 ${data.duration} 秒。RTKRCV 将在 2 秒后自动关闭`, 'success');
    
    // 启动10分钟清除定时器
    scheduleCardClear(data.stationId);
    
    // 保存稳定结果到历史记录
    saveStableResult(data);
}

// 处理 RTKRCV 自动关闭
function handleRtkcrvAutoStopped(data) {
    console.log(`🛑 RTKRCV 自动关闭：`, data);
    
    // 显示通知
    showMessage(`🛑 ${data.message}`, 'info');
    
    // 立即清除站点卡片与缓存，避免占位与视觉残留
    clearStationCard(data.stationId);
    
    // 刷新进程列表
    loadProcessList();
    
    // 如果是当前文件，更新按钮状态
    if (currentFile && currentFile.fileName === data.configFile) {
        processStatus.style.display = 'none';
        startRtkcrvBtn.innerHTML = '<span>🚀 启动 RTKRCV</span>';
        startRtkcrvBtn.classList.remove('btn-danger');
        startRtkcrvBtn.classList.add('btn-primary');
        startRtkcrvBtn.onclick = handleStartRtkrcv;
    }
}

// 处理 RTKRCV 手动关闭
function handleRtkcrvManualStopped(data) {
    console.log(`🛑 RTKRCV 手动关闭：`, data);
    
    // 显示通知
    showMessage(`🛑 ${data.message}`, 'info');
    
    // 立即清除站点卡片和缓存
    clearStationCard(data.stationId);
    
    // 刷新进程列表
    loadProcessList();
    
    // 如果是当前文件，更新按钮状态
    if (currentFile && currentFile.fileName === data.configFile) {
        processStatus.style.display = 'none';
        startRtkcrvBtn.innerHTML = '<span>🚀 启动 RTKRCV</span>';
        startRtkcrvBtn.classList.remove('btn-danger');
        startRtkcrvBtn.classList.add('btn-primary');
        startRtkcrvBtn.onclick = handleStartRtkrcv;
        startRtkcrvBtn.disabled = false;
    }
}

// 立即清除站点卡片（用于手动停止）
function clearStationCard(stationId) {
    console.log(`🗑️ 立即清除站点 ${stationId} 的卡片（手动停止）`);
    
    // 从数据Map中删除
    stationDataMap.delete(stationId);
    
    // 标记为已清除，防止重新出现
    clearedStations.add(stationId);
    
    // 取消清除定时器（如果有）
    cancelCardClear(stationId);
    
    // 重新渲染
    renderRealtimeData();
    
    // 通知后端清理缓存
    notifyServerClearStation(stationId);
}

// 更新连接状态
function updateConnectionStatus(status) {
    if (status === 'connected') {
        connectionStatus.textContent = '已连接';
        connectionStatus.className = 'status-badge running';
    } else if (status === 'connecting') {
        connectionStatus.textContent = '连接中...';
        connectionStatus.className = 'status-badge';
    } else {
        connectionStatus.textContent = '未连接';
        connectionStatus.className = 'status-badge stopped';
    }
}

// 更新站点数据
function updateStationData(data) {
    // 如果站点已被清除，拒绝添加
    if (clearedStations.has(data.stationId)) {
        console.log(`🚫 拒绝已清除站点的数据: ${data.stationId}`);
        return;
    }
    
    // 如果站点已经稳定，则不再更新实时数据
    const existingData = stationDataMap.get(data.stationId);
    if (existingData && existingData.stability && existingData.stability.stable) {
        return; // 已稳定的站点不再接收实时更新
    }
    
    // 取消清除定时器（因为有新数据）
    cancelCardClear(data.stationId);
    
    stationDataMap.set(data.stationId, data);
    renderRealtimeData();
}

// 渲染实时数据
function renderRealtimeData() {
    if (stationDataMap.size === 0) {
        realtimeData.innerHTML = '<p class="empty-state">等待数据...</p>';
        dataCount.textContent = '站点数: 0';
        return;
    }
    
    dataCount.textContent = `站点数: ${stationDataMap.size}`;
    
    let html = '';
    stationDataMap.forEach((data) => {
        const qualityClass = data.quality.status === 1 ? 'fixed' : 'float';
        const badgeClass = data.quality.status === 1 ? 'fixed' : data.quality.status === 2 ? 'float' : 'other';
        
        // 判断稳定状态
        const isStable = data.stability && data.stability.stable;
        const isCollecting = data.stability && data.stability.collecting;
        const cardClass = isStable ? 'stable' : isCollecting ? 'collecting' : '';
        const animationClass = isStable ? '' : 'update-indicator';
        
        html += `
            <div class="station-card ${qualityClass} ${cardClass} ${animationClass}">
                <div class="station-header">
                    <div class="station-id">
                        📍 站点 ${data.stationId}
                        ${isStable ? '<span class="stable-badge">🔒 已稳定</span>' : ''}
                        ${isCollecting ? '<span class="collecting-badge">📊 收集中</span>' : ''}
                    </div>
                    <div class="station-time">${data.dateTime}</div>
                </div>
                
                <div class="station-quality">
                    <span class="quality-badge ${badgeClass}">${data.quality.statusText}</span>
                    <span class="satellites-count">
                        🛰️ ${data.quality.satellites} 颗卫星
                    </span>
                    ${data.quality && data.quality.ambiguity !== undefined && data.quality.ambiguity !== null ? `
                    <span class="ambiguity-value">
                        🔢 模糊度: ${data.quality.ambiguity}
                    </span>
                    ` : ''}
                    ${isCollecting ? `
                        <span class="progress-info">
                            ⏱️ ${data.stability.elapsed.toFixed(0)}s / ${data.stability && data.stability.required ? data.stability.required : 40}s
                            ${data.stability.sampleCount ? `(${data.stability.sampleCount} 样本)` : ''}
                        </span>
                    ` : ''}
                </div>
                
                ${isStable && data.average ? `
                    <!-- 稳定后的平均坐标 -->
                    <div class="average-section">
                        <div class="stable-notice">
                            <strong>✅ 已达到稳定状态</strong>
                            <span>RTKRCV 已自动关闭，以下为 ${data.average.sampleCount} 个样本的平均值</span>
                        </div>
                        <h4 class="average-title">⭐ 平均坐标（基于 ${data.average.sampleCount} 个样本）</h4>
                        ${data.average.filtered ? `
                        <div class="filter-notice">
                            <strong>🔍 智能过滤：</strong>
                            已自动移除误差最大的 ${data.average.removedSampleCount} 个样本
                            （共采集 ${data.average.originalSampleCount} 个，使用 ${data.average.sampleCount} 个计算平均值）
                        </div>
                        ` : ''}
                        <div class="coordinates-grid">
                            <div class="coord-section average-coord">
                                <div class="coord-title">📐 ECEF 平均值</div>
                                <div class="coord-row">
                                    <span class="coord-label">X:</span>
                                    <span class="coord-value">${data.average.ecef.x} m</span>
                                    ${data.average.stdDev ? `<span class="coord-stddev">±${data.average.stdDev.ecef.x}</span>` : ''}
                                </div>
                                <div class="coord-row">
                                    <span class="coord-label">Y:</span>
                                    <span class="coord-value">${data.average.ecef.y} m</span>
                                    ${data.average.stdDev ? `<span class="coord-stddev">±${data.average.stdDev.ecef.y}</span>` : ''}
                                </div>
                                <div class="coord-row">
                                    <span class="coord-label">Z:</span>
                                    <span class="coord-value">${data.average.ecef.z} m</span>
                                    ${data.average.stdDev ? `<span class="coord-stddev">±${data.average.stdDev.ecef.z}</span>` : ''}
                                </div>
                            </div>
                            
                            <div class="coord-section average-coord">
                                <div class="coord-title">🌍 LLH 平均值</div>
                                <div class="coord-row">
                                    <span class="coord-label">纬度:</span>
                                    <span class="coord-value">${data.average.llh.lat}°</span>
                                    ${data.average.stdDev ? `<span class="coord-stddev">±${data.average.stdDev.llh.lat}°</span>` : ''}
                                </div>
                                <div class="coord-row">
                                    <span class="coord-label">经度:</span>
                                    <span class="coord-value">${data.average.llh.lon}°</span>
                                    ${data.average.stdDev ? `<span class="coord-stddev">±${data.average.stdDev.llh.lon}°</span>` : ''}
                                </div>
                                <div class="coord-row">
                                    <span class="coord-label">高度:</span>
                                    <span class="coord-value">${data.average.llh.height} m</span>
                                    ${data.average.stdDev ? `<span class="coord-stddev">±${data.average.stdDev.llh.height}</span>` : ''}
                                </div>
                            </div>
                        </div>
                        <div class="stability-actions">
                            <button class="btn btn-secondary btn-small" onclick="resetStability('${data.stationId}')">
                                🔄 重新收集
                            </button>
                            <button class="btn btn-info btn-small" onclick="showHexConfig('${data.stationId}', '${data.average.llh.lat}', '${data.average.llh.lon}', '${data.average.llh.height}')">
                                📋 生成HEX配置
                            </button>
                        </div>
                        
                        <!-- HEX配置显示区域 -->
                        <div id="hexConfig_${data.stationId}" class="hex-config-section" style="display: none;">
                            <div class="hex-config-header">
                                <h5>📡 设备配置命令</h5>
                                <button class="btn btn-secondary btn-small" onclick="hideHexConfig('${data.stationId}')">
                                    ✕ 关闭
                                </button>
                            </div>
                            <div class="hex-config-content">
                                <!-- 内容将通过 JavaScript 动态填充 -->
                            </div>
                        </div>
                    </div>
                ` : ''}
                
                ${!isStable ? `
                    <!-- 实时坐标（未稳定时显示） -->
                    <div class="coordinates-grid">
                        <div class="coord-section">
                            <div class="coord-title">📐 ECEF 坐标 ${isCollecting ? '(实时)' : ''}</div>
                            <div class="coord-row">
                                <span class="coord-label">X:</span>
                                <span class="coord-value">${data.ecef.x} m</span>
                            </div>
                            <div class="coord-row">
                                <span class="coord-label">Y:</span>
                                <span class="coord-value">${data.ecef.y} m</span>
                            </div>
                            <div class="coord-row">
                                <span class="coord-label">Z:</span>
                                <span class="coord-value">${data.ecef.z} m</span>
                            </div>
                            <div class="coord-row">
                                <span class="coord-label">时间:</span>
                                <span class="coord-value">${data.ecef.dateTime}</span>
                            </div>
                        </div>
                        
                        <div class="coord-section">
                            <div class="coord-title">🌍 LLH 坐标 ${isCollecting ? '(实时)' : ''}</div>
                            <div class="coord-row">
                                <span class="coord-label">纬度:</span>
                                <span class="coord-value">${data.llh.lat}°</span>
                            </div>
                            <div class="coord-row">
                                <span class="coord-label">经度:</span>
                                <span class="coord-value">${data.llh.lon}°</span>
                            </div>
                            <div class="coord-row">
                                <span class="coord-label">高度:</span>
                                <span class="coord-value">${data.llh.height} m</span>
                            </div>
                            <div class="coord-row">
                                <span class="coord-label">时间:</span>
                                <span class="coord-value">${data.dateTime}</span>
                            </div>
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    });
    
    realtimeData.innerHTML = html;
}

// 安排卡片清除（10分钟后）
function scheduleCardClear(stationId) {
    // 清除已有的定时器（如果存在）
    if (stationClearTimers.has(stationId)) {
        const oldTimerInfo = stationClearTimers.get(stationId);
        clearTimeout(oldTimerInfo.timerId);
    }
    
    console.log(`⏱️ 站点 ${stationId} 卡片将在 10 分钟后自动清除`);
    
    // 记录设置时间
    const clearTime = Date.now() + (10 * 60 * 1000);
    
    // 设置10分钟（600000毫秒）后清除卡片
    const timerId = setTimeout(() => {
        console.log(`🗑️ 自动清除站点 ${stationId} 的卡片`);
        stationDataMap.delete(stationId);
        stationClearTimers.delete(stationId);
        clearedStations.add(stationId); // 标记为已清除，防止重新出现
        renderRealtimeData();
        showMessage(`🗑️ 站点 ${stationId} 的数据已自动清除（稳定后10分钟）`, 'info');
        
        // 通知后端清理缓存
        notifyServerClearStation(stationId);
    }, 10 * 60 * 1000); // 10分钟
    
    stationClearTimers.set(stationId, { timerId, clearTime });
}

// 检查并清理过期的稳定站点
function checkAndClearStaleStations() {
    const now = Date.now();
    const stationsToRemove = [];
    
    stationDataMap.forEach((data, stationId) => {
        // 检查是否是已稳定的站点
        if (data.stability && data.stability.stable) {
            // 如果没有设置清除定时器，检查站点数据的时间戳
            if (!stationClearTimers.has(stationId)) {
                // 从数据的时间戳判断是否超过10分钟
                const dataTime = new Date(data.timestamp).getTime();
                const elapsedMinutes = (now - dataTime) / (60 * 1000);
                
                if (elapsedMinutes > 10) {
                    console.log(`🗑️ 发现超过10分钟的稳定站点: ${stationId} (已过 ${elapsedMinutes.toFixed(1)} 分钟)`);
                    stationsToRemove.push(stationId);
                    clearedStations.add(stationId); // 标记为已清除
                } else {
                    // 还没到10分钟，设置剩余时间的定时器
                    const remainingTime = (10 * 60 * 1000) - (now - dataTime);
                    if (remainingTime > 0) {
                        console.log(`⏱️ 为站点 ${stationId} 重新设置清除定时器 (剩余 ${(remainingTime/60000).toFixed(1)} 分钟)`);
                        const timerId = setTimeout(() => {
                            console.log(`🗑️ 自动清除站点 ${stationId} 的卡片`);
                            stationDataMap.delete(stationId);
                            stationClearTimers.delete(stationId);
                            clearedStations.add(stationId); // 标记为已清除
                            renderRealtimeData();
                            showMessage(`🗑️ 站点 ${stationId} 的数据已自动清除（稳定后10分钟）`, 'info');
                            
                            // 通知后端清理缓存
                            notifyServerClearStation(stationId);
                        }, remainingTime);
                        
                        stationClearTimers.set(stationId, { timerId, clearTime: now + remainingTime });
                    }
                }
            } else {
                // 已有定时器，检查是否已过期但定时器没触发
                const timerInfo = stationClearTimers.get(stationId);
                if (timerInfo.clearTime < now) {
                    console.log(`🗑️ 发现过期但未清除的站点: ${stationId}`);
                    stationsToRemove.push(stationId);
                    clearedStations.add(stationId); // 标记为已清除
                    clearTimeout(timerInfo.timerId);
                    stationClearTimers.delete(stationId);
                }
            }
        }
    });
    
    // 清除过期的站点
    if (stationsToRemove.length > 0) {
        stationsToRemove.forEach(stationId => {
            stationDataMap.delete(stationId);
            // 通知后端清理缓存
            notifyServerClearStation(stationId);
        });
        renderRealtimeData();
        showMessage(`🗑️ 已自动清除 ${stationsToRemove.length} 个超时站点的数据`, 'info');
    }
}

// 通知后端清理站点缓存
async function notifyServerClearStation(stationId) {
    try {
        await fetch(`${API_BASE_URL}/rtkrcv/clear-cache/${stationId}`, {
            method: 'POST'
        });
        console.log(`📤 已通知后端清理站点 ${stationId} 的缓存`);
    } catch (error) {
        console.error('通知后端清理缓存失败:', error);
    }
}

// 取消卡片清除定时器
function cancelCardClear(stationId) {
    if (stationClearTimers.has(stationId)) {
        const timerInfo = stationClearTimers.get(stationId);
        clearTimeout(timerInfo.timerId);
        stationClearTimers.delete(stationId);
        console.log(`⏹️ 取消站点 ${stationId} 的卡片清除定时器`);
    }
}

// 重置站点稳定性
async function resetStability(stationId) {
    if (!confirm(`确定要重置站点 ${stationId} 的稳定性吗？这将重新开始收集数据。`)) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE_URL}/rtkrcv/stability/reset/${stationId}`, {
            method: 'POST'
        });
        
        const result = await response.json();
        
        if (result.success) {
            showMessage(`✅ ${result.message}`, 'success');
            
            // 取消清除定时器
            cancelCardClear(stationId);
            
            // 从已清除列表中移除（允许重新显示）
            clearedStations.delete(stationId);
            
            // 更新本地数据
            const stationData = stationDataMap.get(stationId);
            if (stationData) {
                stationData.stability = { stable: false, collecting: false };
                delete stationData.average;
                stationDataMap.set(stationId, stationData);
                renderRealtimeData();
            }
        } else {
            showMessage(`❌ ${result.message}`, 'error');
        }
    } catch (error) {
        console.error('Error:', error);
        showMessage('❌ 重置失败', 'error');
    }
}

// ========== 稳定结果历史记录 ==========

// 稳定结果分页与查询状态
let stableResultsAll = [];
let stableResultsSearch = '';
let stableResultsPage = 1;
const stableResultsPageSize = 5;

// 加载稳定结果历史记录
async function loadStableResults() {
    try {
        const response = await fetch(`${API_BASE_URL}/stable-results`);
        const result = await response.json();
        
        if (result.success) {
            stableResultsAll = Array.isArray(result.results) ? result.results : [];
            
            // 根据已存在的稳定结果，隐藏监控中的对应站点并防止其再次出现（除非重新启动采集）
            try {
                const stableIds = new Set(
                    stableResultsAll
                        .filter(r => r && r.stationId)
                        .map(r => String(r.stationId))
                );
                
                // 将这些站点加入已清除集合，并从实时数据中移除
                stableIds.forEach((sid) => {
                    // 标记为已清除，避免 SSE 新数据再次渲染
                    clearedStations.add(sid);
                    // 取消可能存在的清除定时器
                    cancelCardClear(sid);
                    // 从实时渲染数据中移除
                    if (stationDataMap.has(sid)) {
                        stationDataMap.delete(sid);
                    }
                });
                // 立即刷新监控区 UI
                renderRealtimeData();
            } catch (e) {
                console.warn('同步稳定结果到监控隐藏列表失败:', e);
            }
            
            // 若当前页超出范围，重置为第1页
            stableResultsPage = 1;
            renderStableResults();
        } else {
            document.getElementById('stableResultsTable').innerHTML = '<p class="empty-state">加载失败</p>';
        }
    } catch (error) {
        console.error('Error loading stable results:', error);
        document.getElementById('stableResultsTable').innerHTML = '<p class="empty-state">无法连接到服务器</p>';
    }
}

// 查询输入处理
function onStableResultsSearch(value) {
    stableResultsSearch = (value || '').trim();
    stableResultsPage = 1;
    renderStableResults();
}

// 跳转分页
function goToStableResultsPage(page) {
    stableResultsPage = page;
    renderStableResults();
}

// 渲染稳定结果（含查询与分页）
function renderStableResults() {
    const tableContainer = document.getElementById('stableResultsTable');
    
    if (!Array.isArray(stableResultsAll) || stableResultsAll.length === 0) {
        tableContainer.innerHTML = '<p class="empty-state">📭 还没有稳定的结果记录</p>';
        return;
    }
    
    // 保留输入框焦点与光标位置，避免重渲染导致每次只能输入一个字符
    const activeEl = document.activeElement;
    const hadFocus = activeEl && activeEl.id === 'stableResultsSearchInput';
    let caretPos = null;
    if (hadFocus) {
        try { caretPos = activeEl.selectionStart; } catch (e) {}
    }
    
    // 过滤
    const keyword = stableResultsSearch.toLowerCase();
    const filtered = keyword
        ? stableResultsAll.filter(r => String(r.stationId || '').toLowerCase().includes(keyword))
        : stableResultsAll.slice();

    // 分页
    const total = filtered.length;
    const pageSize = stableResultsPageSize;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (stableResultsPage > totalPages) stableResultsPage = totalPages;
    if (stableResultsPage < 1) stableResultsPage = 1;
    const start = (stableResultsPage - 1) * pageSize;
    const current = filtered.slice(start, start + pageSize);

    // 控件（查询 + 分页）
    let controls = `
        <div class="stable-results-controls" style="display:flex; align-items:center; justify-content:space-between; margin-bottom: 10px; gap: 12px; flex-wrap: wrap;">
            <div class="search-box" style="flex:1; min-width: 220px;">
                <input id="stableResultsSearchInput" type="text" class="input" placeholder="按站点编号查询" value="${stableResultsSearch.replace(/"/g, '&quot;')}" oninput="onStableResultsSearch(this.value)" style="width:100%; padding:8px 10px;">
            </div>
            <div class="pagination" style="display:flex; align-items:center; gap:6px;">
                <button class="btn btn-small" ${stableResultsPage===1 ? 'disabled' : ''} onclick="goToStableResultsPage(${Math.max(1, stableResultsPage-1)})">« 上一页</button>
                ${Array.from({length: totalPages}).map((_, idx) => {
                    const p = idx + 1;
                    return `<button class="btn btn-small ${p===stableResultsPage ? 'btn-secondary' : ''}" onclick="goToStableResultsPage(${p})">${p}</button>`;
                }).join('')}
                <button class="btn btn-small" ${stableResultsPage===totalPages ? 'disabled' : ''} onclick="goToStableResultsPage(${Math.min(totalPages, stableResultsPage+1)})">下一页 »</button>
                <span style="margin-left:8px; color:#666;">共 ${total} 条，每页 ${pageSize} 条</span>
            </div>
        </div>
    `;

    let html = `
        ${controls}
        <table class="results-table">
            <thead>
                <tr>
                    <th>站点编号</th>
                    <th>ECEF X (m)</th>
                    <th>ECEF Y (m)</th>
                    <th>ECEF Z (m)</th>
                    <th>纬度 (°)</th>
                    <th>经度 (°)</th>
                    <th>高度 (m)</th>
                    <th>样本数</th>
                    <th>过滤</th>
                    <th>时间</th>
                    <th>操作</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    current.forEach(result => {
        // 样本信息显示
        let sampleInfo = result.sampleCount;
        if (result.filtered && result.originalSampleCount) {
            sampleInfo = `${result.sampleCount}<br><small style="color: #2196f3;">(${result.originalSampleCount}个采集)</small>`;
        }
        
        // 过滤信息显示
        let filterInfo = result.filtered ? 
            `<span style="color: #2196f3;">✓ 已过滤<br><small>(移除${result.removedSampleCount || 2}个)</small></span>` : 
            '<span style="color: #999;">-</span>';
        
        html += `
            <tr>
                <td><strong>${result.stationId}</strong></td>
                <td>${result.ecef_x}</td>
                <td>${result.ecef_y}</td>
                <td>${result.ecef_z}</td>
                <td>${result.lat}</td>
                <td>${result.lon}</td>
                <td>${result.height}</td>
                <td>${sampleInfo}</td>
                <td>${filterInfo}</td>
                <td>${formatDate(result.timestamp)}</td>
                <td>
                    <button class="btn btn-info btn-small" onclick="showHistoryHexModal('${result.stationId}', '${result.lat}', '${result.lon}', '${result.height}')">
                        📋 HEX
                    </button>
                    <button class="btn btn-danger btn-small" onclick="deleteStableResult('${result.id}')">
                        🗑️ 删除
                    </button>
                </td>
            </tr>
        `;
    });
    
    html += `
            </tbody>
        </table>
    `;
    
    tableContainer.innerHTML = html;
    
    // 重渲染后恢复焦点与光标位置
    const inputEl = document.getElementById('stableResultsSearchInput');
    if (inputEl) {
        if (hadFocus) {
            inputEl.focus();
            const pos = (caretPos != null) ? caretPos : inputEl.value.length;
            try { inputEl.setSelectionRange(pos, pos); } catch (e) {}
        }
    }
}

// 保存稳定结果
async function saveStableResult(data) {
    try {
        const result = {
            stationId: data.stationId,
            ecef_x: data.average.ecef.x,
            ecef_y: data.average.ecef.y,
            ecef_z: data.average.ecef.z,
            lat: data.average.llh.lat,
            lon: data.average.llh.lon,
            height: data.average.llh.height,
            sampleCount: data.sampleCount,
            timestamp: new Date().toISOString(),
            // 添加过滤信息
            filtered: data.average.filtered || false,
            originalSampleCount: data.average.originalSampleCount || data.sampleCount,
            removedSampleCount: data.average.removedSampleCount || 0
        };
        
        const response = await fetch(`${API_BASE_URL}/stable-results`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(result)
        });
        
        const responseData = await response.json();
        
        if (responseData.success) {
            console.log('✅ 稳定结果已保存到历史记录');
            await loadStableResults(); // 刷新表格
        } else {
            console.error('❌ 保存稳定结果失败:', responseData.message);
        }
    } catch (error) {
        console.error('Error saving stable result:', error);
    }
}

// 删除稳定结果
async function deleteStableResult(id) {
    if (!confirm('确定要删除这条记录吗？')) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE_URL}/stable-results/${id}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (result.success) {
            showMessage('✅ 记录已删除', 'success');
            await loadStableResults();
        } else {
            showMessage(`❌ ${result.message}`, 'error');
        }
    } catch (error) {
        console.error('Error:', error);
        showMessage('❌ 删除失败', 'error');
    }
}

// 导出稳定结果为CSV
async function exportStableResults() {
    try {
        const response = await fetch(`${API_BASE_URL}/stable-results`);
        const result = await response.json();
        
        if (!result.success || result.results.length === 0) {
            showMessage('❌ 没有可导出的数据', 'error');
            return;
        }
        
        // 生成CSV内容
        let csv = 'station,ecef_x,ecef_y,ecef_z,lat,lon,height,sample_count,timestamp\n';
        
        result.results.forEach(r => {
            csv += `${r.stationId},${r.ecef_x},${r.ecef_y},${r.ecef_z},${r.lat},${r.lon},${r.height},${r.sampleCount},${r.timestamp}\n`;
        });
        
        // 创建下载链接
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        
        link.setAttribute('href', url);
        link.setAttribute('download', `stable_results_${new Date().toISOString().split('T')[0]}.csv`);
        link.style.visibility = 'hidden';
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        showMessage('✅ CSV文件已导出', 'success');
    } catch (error) {
        console.error('Error:', error);
        showMessage('❌ 导出失败', 'error');
    }
}

// 页面关闭时断开 SSE
window.addEventListener('beforeunload', () => {
    if (eventSource) {
        eventSource.close();
    }
});

