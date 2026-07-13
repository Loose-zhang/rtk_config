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
| POST | /api/batch/run-txt | 批量启动（txtPath 或 txtContent；concurrency 并发；rounds/roundIntervalMinutes 多轮） |
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

## 解算与稳定性判定流程

1. 以 `bbb.conf` 为模板替换 `inpstr1/2/3-path`、`out-height`，输出流固定指向本服务 TCP 端口（默认 60000）。模板缺少任一配置项会直接报错而不是静默生成错误配置。
2. 调度器按并发数（默认 5）启动 rtkrcv，每完成 15 站冷却 5 分钟，单站 30 分钟未固定判失败；支持多轮循环与服务重启后断点续传（`generated/round_state.json`）。
3. 稳定性判定（可配）：连续固定解累计 `STABILITY_REQUIRED_SECONDS` 秒且样本数达 `STABILITY_REQUIRED_SAMPLES`，容忍 `NON_FIXED_TOLERANCE_SECONDS` 秒内短暂掉固定。
4. 达到稳定后剔除误差最大的 2 个样本再取平均，结果写入 `generated/stable_results.json`（原子写入）与 MySQL `stable_results` 表，并立即向调度器标记成功。
5. 每个设备一个文件夹：配置与日志位于 `generated/<设备号>/<设备号>.conf|.log`（兼容旧的平铺布局）；日志超过 `MAX_LOG_SIZE_MB`（默认 20MB）在进程启动时轮转为 `.log.1`。

## 稳定结果的数据来源

网页"稳定解"列表（`GET /api/stable-results`）优先从 MySQL 读取（持久来源，响应中 `source: "database"`）；`generated/stable_results.json` 每轮完成后会被清空，仅在数据库不可用时作回退（`source: "json-fallback"`）。删除操作会同步删除数据库与 JSON 中的记录。旧版数据库表会在启动时自动补充 `sample_count/filtered/removed_count` 三列。

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
