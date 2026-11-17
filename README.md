# RTKRCV 基站批量解算与监控服务

对一批 GNSS 基站自动执行：生成 rtkrcv 配置 → 启动 rtkrcv 子进程解算 → 通过 TCP 回收解算结果 → 判定固定解稳定性 → 对稳定样本剔除异常后取平均，得到基站精确坐标 → 写入 JSON 与 MySQL，并通过 SSE 实时推送到网页监控界面。

## 快速开始

```bash
npm install
npm start          # 默认 http://localhost:3000，TCP 数据端口 60000
npm test           # 运行单元测试（node:test，无额外依赖）
```

依赖：Node.js >= 18（生产建议 22），rtkrcv（RTKLIB demo5）可执行文件。

## 目录结构

```
server.js            入口（express 装配、启动、优雅关闭）
config.js            配置（全部支持环境变量覆盖，见 .env.example）
bbb.conf             rtkrcv 配置模板（demo5 静态解）
rtkstation.txt       站点列表（UTF-8，格式：stationId outHeight）
lib/
  logger.js          日志
  state.js           共享运行时状态 + 缓存清扫器
  geodesy.js         GPS时间/LLH→ECEF 转换（纯函数，闰秒常量集中于此）
  stats.js           均值/标准差/异常值剔除（纯函数）
  parser.js          rtkrcv 输出解析
  store.js           文件存取（JSON 原子写入、模板替换校验、TXT 编码容错）
  db.js              MySQL（可选）
  sse.js             SSE 广播（按站点限频）
  rtkrcv.js          子进程管理（日志轮转、退出回调）
  stability.js       稳定性判定与结果保存
  scheduler.js       批量调度、多轮管理、断点续传
  tcp-server.js      TCP 数据接收
  routes.js          全部 HTTP API
test/                单元测试
tools/               辅助工具（Int38Parser.java 等，非运行时依赖）
deploy/              systemd / pm2 部署示例
public/              前端页面
generated/           运行时产物（配置、日志、结果，已 gitignore）
```

## 站点 TXT 格式

每行 `stationId outHeight`，空白分隔；支持 `#` 与 `//` 注释行。文件编码支持 UTF-8 / UTF-16（自动识别 BOM），推荐使用 UTF-8。

```
6539837 1
6539840 0
```

## 主要 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/generate-config | 生成单站配置（inpstr1/2/3、outHeight） |
| POST | /api/batch/run-txt | 新建批量（默认重新计算提交的全部站点；txtPath 或 txtContent；concurrency 并发；rounds/roundIntervalMinutes 多轮） |
| POST | /api/batch/resume | 断点续传上次批量（按 last_batch.json 与已成功结果计算剩余） |
| GET  | /api/batch/status | 调度器状态（运行中/排队/成功/失败/冷却） |
| GET  | /api/batch/summary | 输出 last_success/failed/remaining.txt 并返回统计 |
| POST | /api/batch/cancel | 取消批量（stopRunning 可选停止运行中进程） |
| GET  | /api/batch/failures | 失败站点列表 |
| GET  | /api/round/state | 多轮调度状态 |
| POST | /api/rtkrcv/start,stop | 手动启停单个 rtkrcv |
| GET  | /api/rtkrcv/status[/:configFile] | 进程状态 |
| GET  | /api/rtkrcv/stream | SSE 实时数据流 |
| GET  | /api/rtkrcv/latest[/:stationId] | 最新解算数据 |
| GET  | /api/rtkrcv/stability | 稳定性收集进度 |
| GET  | /api/stable-results | 稳定结果（平均坐标）列表 |
| GET  | /health | 健康检查 |
| POST | /api/base-config/check-connection | 检测连接：连接 1~3 个 NTRIP 挂载点约 10 秒，返回连接状态与 RTCM 消息类型统计 |
| POST | /api/base-config/rtcm1005/start | 启动 1005 校验任务（单独接收设备 RTCM，连续 N 次与期望 ECEF 一致即通过） |
| GET  | /api/base-config/rtcm1005/:jobId | 1005 校验进度/结果 |
| POST | /api/base-config/rtcm1005/:jobId/stop | 停止 1005 校验 |

## 解算与稳定性判定流程

1. 以 `bbb.conf` 为模板替换 `inpstr1/2/3-path`、`out-height`，输出流固定指向本服务 TCP 端口（默认 60000）。模板缺少任一配置项会直接报错而不是静默生成错误配置。
2. 调度器按并发数（默认 5）启动 rtkrcv，每完成 15 站冷却 5 分钟，单站 30 分钟未固定判失败；重新提交相同列表或启用多轮时，每次都会重新计算全部站点；支持多轮循环与服务重启后断点续传（`generated/round_state.json`）。
3. 稳定性判定（可配）：连续固定解累计 `STABILITY_REQUIRED_SECONDS` 秒且样本数达 `STABILITY_REQUIRED_SAMPLES`，容忍 `NON_FIXED_TOLERANCE_SECONDS` 秒内短暂掉固定。
4. 达到稳定后剔除误差最大的 2 个样本再取平均，结果先持久写入 `generated/stable_results.json`（原子写入），再写入 MySQL `stable_results` 表，并立即向调度器标记成功。数据库写入失败时 JSON 记录会保留并等待补写。
5. 每个设备一个文件夹：配置与日志位于 `generated/<设备号>/<设备号>.conf|.log`（兼容旧的平铺布局）；日志超过 `MAX_LOG_SIZE_MB`（默认 20MB）在进程启动时轮转为 `.log.1`。

## 稳定结果的数据来源

网页"稳定解"列表（`GET /api/stable-results`）优先从 MySQL 读取；`generated/stable_results.json` 是持久兜底副本，轮次完成后不会清空。数据库缺少部分记录时，接口会合并 JSON 结果并自动补写数据库（`source: "database+json"`）；数据库完全不可用时返回 JSON（`source: "json-fallback"`）。服务启动时也会执行一次 JSON → MySQL 补写。删除操作会同步删除数据库与 JSON 中的记录。旧版数据库表会在启动时自动补充 `sample_count/filtered/removed_count` 三列。

## 部署

配置优先级：环境变量 > config.js 默认值。Linux 默认路径为 `/root/ppp_station_monitor/rtk_config/...`（与现有生产部署一致）；迁移新机器时通过环境变量覆盖，参考 `.env.example`。

systemd（推荐）：

```bash
cp deploy/rtk-config.service /etc/systemd/system/
# 按需修改 WorkingDirectory / Environment
systemctl daemon-reload && systemctl enable --now rtk-config
```

pm2：

```bash
pm2 start deploy/ecosystem.config.js
pm2 save
```

服务崩溃或重启后，多轮批量任务会依据 `round_state.json` 自动恢复。

## 设计说明

- 小体量 JSON（结果、状态文件）使用同步 IO + 原子写入（tmp+rename），避免写入中断损坏文件；大文件读取（日志查看接口）为异步，TCP 数据流日志追加为异步，避免阻塞事件循环。
- 内存中的站点缓存（latestData/stationStability/sseLastSent）由清扫器周期回收：无运行进程且空闲超过 `CACHE_MAX_IDLE_MS`（默认 1 小时）的条目被清除。
- GPS-UTC 闰秒集中在 `lib/geodesy.js`（`GPS_LEAP_SECONDS` 可覆盖），IERS 公布新闰秒时只需改一处。
- `tools/Int38Parser.java` 是 RTCM 1005 报文 38 位 ECEF 坐标解析的参考实现，运行时逻辑在 `public/app.js` 的 `parseInt38`，两者需保持一致。

## 已知待办（安全，暂缓处理）

见 `ISSUES.md` 第一节：API 鉴权、CORS 收紧、下载/日志接口路径遍历校验、凭据管理。内网部署时风险可控，公网部署前必须处理。

## 配置基站（security-monitor 联动）

security-monitor「设备参数」中的 G510 设备有「配置基站」按钮。点击后 security-monitor 会：把设备类型改为基准站并清空其基站编号（parentid）、临时开启 NtripCaster 推送、下发「开启 RTCM / 关闭 4065 / RTCM MSM4 / 保存」指令（设备离线时排队，下次 D3F0 上线补发），然后带一次性 token 打开本页面（`#baseConfig=...`，参数只在 URL 片段中，不会发到服务器）。

本页面顶部出现「配置基站」面板，数据流 1 挂载点自动改为该设备号，之后：

1. **检测连接**：连接数据流 1/2/3，确认能收到设备观测数据（MSM）；通过后自动生成 `<设备号>.conf` 并启动 RTKRCV。
2. **等待稳定解**：沿用现有稳定性判定；面板默认使用大地高（可改为椭球高）。
3. **下发基站坐标**：页面只把稳定解 BLH 提交给 security-monitor，由其生成 `$POLCFGBASE,纬度,经度,高度`（9/9/4 位小数）和保存指令下发设备。
4. **1005 校验**：本服务单独连接设备挂载点解析 RTCM 1005，连续 3 次与稳定解 ECEF 偏差 ≤ 允许值（默认 0.05 m）即通过；旧坐标的 1005 会被自动跳过。
5. **写入 ECEF 并断开**：1005 坐标提交给 security-monitor，服务端再按已下发坐标复核偏差后写入设备 `ecefx/ecefy/ecefz`，随后关闭会话，并默认关闭该设备的 NtripCaster 推送（中途断开则只撤销本流程临时开启的推送）。

页面关闭时会通知 security-monitor 在 15 秒后关闭会话（刷新页面可由心跳恢复）；页面无心跳 3 分钟后会话也会自动关闭。相关代码：`lib/base-config.js`、`lib/ntrip-client.js`、`lib/rtcm3.js`、`public/base-config.js`。

security-monitor 端配置（`sec-beidou/src/main/resources/application.properties`）：

| 配置项 | 说明 |
|--------|------|
| `base-config.rtk-config-url` | 本页面地址；留空时为 `http://<security-monitor 主机>:3000/` |
| `base-config.ntrip-prefix` | 设备挂载点前缀（`user:pass@host:port/`）；留空时使用本页面「批量运行」中的公共前缀 |
| `base-config.ecef-tolerance-m` | 1005 与下发坐标的允许偏差，默认 0.05 m |

