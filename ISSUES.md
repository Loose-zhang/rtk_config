# 项目问题清单（rtk_config）

整理日期：2026-07-13；修复日期：2026-07-13。除第一节（安全，按约定暂缓）外全部已处理。

## 一、暂不处理（信息泄露 / 安全）⚠️ 待办

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| S1 | NTRIP 账号密码明文落盘 | `generated/last_batch.json`、`generated/last_batch_original.txt` | 含 beidou、ytcors、GA 的账号密码 |
| S2 | MySQL 默认凭据硬编码 | `config.js` | 默认 root/root，未强制走环境变量（.env.example 已提示改密） |
| S3 | API 无鉴权 + CORS `*` | `lib/routes.js` 全部路由 | 删除文件、停止进程等危险接口对外开放 |
| ~~S4~~ | ~~路径遍历漏洞~~ ✅ 已修复 | `lib/store.js` | 防护集中于 `isSafeGeneratedName`/`resolveGeneratedFile`，全部文件接口经由统一解析，实测 `..%2F` 返回 400/404 |

## 二、正确性 / Bug ✅ 已修复

| # | 问题 | 修复方式 |
|---|------|----------|
| B1 | rtkstation.txt 为 UTF-16 编码 | 已转存 UTF-8；`lib/store.js` 的 `readTextFileSmart` 自动识别 UTF-8/UTF-16 BOM |
| B2 | 闰秒硬编码 18 秒（两处重复） | 集中到 `lib/geodesy.js` 的 `GPS_UTC_LEAP_SECONDS` 常量，可用 `GPS_LEAP_SECONDS` 环境变量覆盖 |
| B3 | 站点已成功解算却被误记失败（12-16 批次） | 根因：①`batchSchedulerOnProcessExit` 从未挂接到批量进程 exit 事件；②成功标记依赖停止时进程仍存活；③稳定后 2 秒窗口内可重复产出记录。修复：稳定即标记成功（`stability.js`→`scheduler.markStationSuccess`）；`rtkrcv.js` exit 回调挂接调度器；已成功站点的迟到失败标记被忽略；已稳定站点直接返回不再重置 |
| B4 | rtkrcv 日志无轮转 | `lib/rtkrcv.js` 启动时超过 `MAX_LOG_SIZE_MB`（默认20MB）轮转为 `.log.1` |
| B5 | 模板替换静默失败 | `lib/store.js` 的 `replaceTemplateKey` 缺项即抛错 |
| B6* | `skipFailed`/批量取消的失败集合用对象构建 Set，过滤永不生效 | `lib/routes.js` 改为按 stationId 构建集合（修复中新发现） |
| B7* | TCP 端口占用重试时 `tcpServer` 未复位，重试必然失败 | `lib/tcp-server.js` 重试前置空（修复中新发现） |

## 三、架构 / 可维护性 ✅ 已处理

| # | 问题 | 处理方式 |
|---|------|----------|
| A1 | server.js 单文件 3353 行 | 拆分为 `lib/` 13 个模块，server.js 仅剩装配与启动（约120行），逻辑保持不变 |
| A2 | 无测试 | `test/` 27 个单元测试（node:test，零新依赖），覆盖 geodesy/stats/parser/store，含生产数据交叉验证；`npm test` 运行 |
| A3 | Int38 双实现易不同步 | Java 版移至 `tools/` 并加 README 标注为参考实现 |
| A4 | JSON 全量重写有损坏风险 | `writeJsonAtomic`（tmp+rename）用于所有结果/状态文件 |
| A5 | 同步 IO 阻塞事件循环 | 日志查看接口与 TCP 数据流日志追加改异步；小体量 JSON 保留同步+原子写（见 README 设计说明） |
| A6 | 内存 Map 无淘汰 | `state.js` 缓存清扫器：无进程且空闲超 1 小时（可配）的站点条目自动清除 |

## 四、部署 / 配置 ✅ 已处理

| # | 问题 | 处理方式 |
|---|------|----------|
| D1 | Linux 路径硬编码 | 按约定保留生产默认路径作兜底，新增 `.env.example` 完整覆盖说明 |
| D2 | 缺少 README | 新增 `README.md`（架构、API、TXT 格式、判定流程、部署） |
| D3 | 无进程守护 | 新增 `deploy/rtk-config.service`（systemd）与 `deploy/ecosystem.config.js`（pm2） |

\* B6/B7 为本次修复过程中新发现的问题。

## 五、代码审查（Codex）发现的问题 ✅ 已修复（2026-07-13 第二轮）

| # | 级别 | 问题 | 修复方式 | 验证 |
|---|------|------|----------|------|
| R1 | P1 | rtkrcv spawn 失败（error 事件）不通知调度器，站点卡住占用并发槽 30 分钟 | `lib/rtkrcv.js` error 回调同样调用 exitHandler（与 exit 重复触发时因 running 已删除自动幂等） | 实测 spawn 失败后 `running:[] failCount:1 active:false` |
| R2 | P1 | `TCP_PORT` 未写入生成的配置，outstr 硬编码 60000 | `lib/store.js` 使用 `config.tcpPort` | 实测 TCP_PORT=63137 时生成配置 outstr1/2 均为 63137 |
| R3 | P1 | 多轮任务重启恢复会重复执行已完成轮次（currentList 未清空） | `onBatchCompleted` 轮次完成后清空 `currentList` 再持久化；`disableRounds` 同步清空 | 实测轮次完成后 round_state.json 中 currentList 为 `[]` 且正确等待下一轮 |
| R4 | P2 | 稳定后先补位、2秒后才停旧进程，并发短时突破上限 | 两轮修复。最终方案：补位统一由进程真实 exit 事件驱动（`batchSchedulerOnProcessExit` 对已成功站点也补位）；`kill()` 只发信号不补位，仅进程已不存在时立即补位；新增 SIGTERM 宽限超时（`KILL_GRACE_MS` 默认10s）后 SIGKILL 强杀，防止拒绝退出的进程阻塞队列 | 用忽略 SIGTERM 的假进程实测：宽限期内 B 不启动（无并发突破），SIGKILL 后 A 退出、B 由 exit 回调补位启动 |
| R5 | P2 | `LOG_LEVELS[level] \|\| 1` 把 debug(0) 错误提升为 info，LOG_LEVEL=info 仍刷 DEBUG 日志 | 改用 `??`（该 bug 原代码即存在） | 新增 test/logger.test.js 4 个用例（共 31 个测试通过） |
| R6 | P2 | 手动停止 API（`/api/rtkrcv/stop`）仍在进程退出前补位 | 改用 `killProcessWithTimeout`；清除定时器并移出 running 后不再立即补位，由 exit 事件驱动 | 实测：宽限期内 B 不启动，SIGKILL 后 B 补位 |
| R7 | P1 | `/api/batch/cancel` 遗留 running 记录与 30 分钟超时定时器（可能误杀新批次同名站点），`stopRunning` 仅普通 kill | 取消时无条件清除全部 timeoutTimer 并清空 `batchScheduler.running`；停止进程改用 `killProcessWithTimeout` | 实测：取消后 running 为空，拒绝退出的进程被 SIGKILL 兜底清理 |
| R8 | P1 | 数据库未保存成功时，批次完成仍清空 `stable_results.json`，导致稳定坐标永久丢失 | JSON 改为持久兜底且不再按轮次清空；数据库写入返回明确结果；启动和查询时双向合并并补写缺失记录 | 34 项测试通过；实测调用批次完成钩子前后 JSON 哈希与 10 条记录均保持不变 |

另：config.js 已统一为 LF 并去除行尾空白，`git diff --check` 通过。

## 六、功能变更（2026-07-13 第三轮）✅

| # | 变更 | 说明 |
|---|------|------|
| F1 | 稳定解页面改为数据库读取 | `GET /api/stable-results` 优先 MySQL（`source:"database"`），JSON 作为持久兜底并自动与数据库补齐；删除同步删库；手动保存也写库；旧表自动补 `sample_count/filtered/removed_count` 列；修复 createPool 假成功导致的 500 |
| F2 | 设备文件夹布局 | 新文件位于 `generated/<设备号>/<设备号>.conf\|.log`，兼容旧平铺布局；删除时新旧位置全部清理，空设备文件夹自动移除 |
| F3 | 复测修复 | 新旧文件并存时删除不彻底 → `resolveGeneratedFileAll` 全位置删除；下载接口目录穿越 → 校验集中于 `isSafeGeneratedName`（同时覆盖 S4） |

待办：真实 MySQL 环境的集成验证（沙箱无法安装数据库）。上线后执行 `curl http://localhost:3000/api/stable-results | head` 确认 `source:"database"`。

## 部署注意（本次改动上线时）

1. 行为不变项：API 路径与响应结构、配置模板格式、调度/稳定性参数默认值均未变。
2. 行为修正项：成功站点不会再被误记失败；`skipFailed=true` 现在真正生效（此前失败站点从未被过滤，若依赖旧行为请传 `skipFailed:false`）；日志超 20MB 会轮转。
3. 上线步骤：`git diff` 审查 → 服务器拉取 → `npm test` → 重启服务（断点续传会自动恢复未完成批量）。
