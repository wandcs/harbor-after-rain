# 服务器每局摘要与异常断连日志

日期：2026-11-16。依据[研发约定](development-guide.md#12-日志数据与素材)及用户本轮要求，补齐本地试玩复盘所需的少量日志。只观察既有房间与连接生命周期，不改规则、协议、断连时机、阈值或同步参数，不做性能优化。

## 输出与边界

实际服务入口 `server/main.js` 将结构化 JSON 单行写到 stdout（摘要）或 stderr（异常断连），保留原有启动/停止文字。每条 JSON 带 UTC `timestamp`、进程临时 `runId`、产品、完整构建/协议/规则标识，以及 `snapshotHz/maxRooms/maxConnections` 配置摘要。房间和连接编号只在该进程内有效，重启后的记录用 `runId` 区分。

可测试应用 `createApp({ log })` 接收同步记录回调，默认不输出；入口负责时间戳、运行身份和实际输出，宿主负责采集、轮转和保留。没有新增第三方遥测、管理接口、数据库、日志队列或依赖。目标机的 7 天/100 MB 保留上限仍按[发布约定](release-runbook.md)单独验证；本机 systemd journal 不因此被认定已完成正式日志轮转验收。

不记录逐帧、逐输入、逐快照、逐射击或常规心跳日志；不记录昵称、密码、地址、完整报文、原始错误文本或客户端 close reason。JSON 解析器的错误可能带报文片段，只转成稳定的 `INVALID_MESSAGE` 分类。

## 每局摘要：`match_summary`

每个房间释放前只输出一条，包含正常结算、所有真人离开和计划内服务停止。重复 `pulse`、`end`、`close` 不补发摘要；不复制或修改核心的比分、胜负或阶段。

| 字段 | 含义 |
| --- | --- |
| `level/event/roomId` | `info/match_summary` 和临时房间号 |
| `mode/capacity/snapshotHz` | 玩法、总席位数、同步档位 |
| `endReason/completed/winner/score` | 正常 `time/score` 才标记完成及胜方；`empty` 或 `server_shutdown` 保留当时比分，`completed=false`、`winner=null`，不假装打完 |
| `wallDurationMs` | 房间创建到释放的宿主单调时间，包含暂停和等待 |
| `simulationMs/activeElapsedMs` | 核心已有的模拟时间与活动耗时；不能把三类时间或其差值直接解释成性能、丢包或暂停指标 |
| `humanJoins/peakHumans` | 成功接纳次数、同时真人峰值；重进计新次数，不代表唯一用户数 |
| `humanLeaves/abnormalDisconnects/humansAtEnd` | 实际移除真人次数、在房间内异常断连次数、释放时仍在场真人数；大厅异常不算进房间 |

例如最后一个真人主动离场时，会得到 `endReason=empty` 的一条摘要，没有异常断连警告。自然结算后，连接继续留在大厅，不因结算产生断连日志。

## 异常断连：`connection_abnormal_close`

每个连接的 close 事件最多输出一条 `warn` 记录，含临时 `connectionId/roomId/actorId`、稳定 `reason`、实际 `closeCode`、有界的库错误代码，以及连接寿命、距最后有效 pong 的时间、已有 RTT 和关闭时队列/积压字节。大厅中的 `roomId/actorId` 为 null。

| 原因 | 依据 |
| --- | --- |
| `VERSION_MISMATCH` | 现有版本检查主动拒绝 |
| `BAD_INPUT/RATE_LIMIT/…` | 现有协议校验返回的有界大写错误代码；其他解析文本统一 `INVALID_MESSAGE` |
| `PAYLOAD_TOO_LARGE` | 消息长度限制：锁定 ws 的明确错误代码或相应关闭码；服务端和客户端看到的最终 close code 可能不同 |
| `IMPORTANT_QUEUE_BYTES_LIMIT/IMPORTANT_QUEUE_COUNT_LIMIT` | 发送重要消息前触及原字节/条数上限 |
| `SEND_BACKLOG_TIMEOUT` | 发送积压持续超过原期限 |
| `HEARTBEAT_TIMEOUT` | 距最后有效 pong 超过原连接期限；边界仍按现有逻辑处理 |
| `SOCKET_ERROR` | 实际 socket error，附库错误代码，不附原错误文本 |
| `ABNORMAL_CLOSE` | 无更明确服务器原因的异常关闭；只描述观察结果，不能据此断言网线、浏览器、内核或 TCP 的具体故障 |

正常 1000/1001/1005 关闭、主动 `leave` 后关闭及计划内服务停止不输出警告。计划停止仍为存活房间各记一条摘要。正常加入失败（例如密码错误、房满）不关闭连接，也不额外输出本类日志。先有明确服务器终止原因时，记录该原因，避免被最后的通用关闭码掩盖。

日志量随房间结束和异常连接数增长，不随模拟帧数增长。原始运行记录仍按宿主上限保留；这些摘要不能替代逐局帧率、真实延迟、命中正确性、容量或实机体验验收。

## 覆盖设计与数量控制

复用现有用例，永久数量保持 199，不新增测试文件或编号：

| 原用例 | 本次补强 |
| --- | --- |
| S4-R1 | 带密码/昵称的真实接纳与失败分支；服务停止仅一条摘要，人数正确，不泄露秘密 |
| S4-R2 | 空房、自然到时、重复结算、连接复用、计划停止；把既有被动断线步骤改为真实传输中断，验证关联、计数与每房一次 |
| 应用生命周期用例 | 正常离场/关闭不误报；心跳在 6000 ms 边界不关闭，6001 ms 关闭并仅记录一次 |
| 真实连接版本/消息/容量限制用例 | 已有版本、输入、长度、速率检查；补两段必要动作，验证畸形报文内容不泄露，以及实际队列终止原因传到日志。原健康连接持续推进，常规消息不产生日志 |
| 原 Outbox 积压及条数/字节边界用例 | 直接断言终止原因，保留原快照替换、上限、恢复、隔离和清理断言 |
| 原独立启动检查 | 运行实际构建入口，核对 JSON 公共字段及一次真实建房/离场摘要；不扩展浏览器或弱网矩阵 |

新增动作覆盖本轮明确的日志隐私和跨模块原因传递需求，没有另建长时间等待、虚假核心或性能用例。先在旧实现运行应用用例，新日志断言失败；首轮实现中长度错误被泛化为 socket error，依据锁定 ws 的实际错误码修正分类，原负例和首轮失败记录均保留。

独立运行方式：

```sh
node scripts/run-tests.mjs --file=tests/server/app.test.mjs
node scripts/run-tests.mjs --case=S4-R1
node scripts/run-tests.mjs --case=S4-R2
node scripts/run-tests.mjs --file=tests/server/outbox.test.mjs
npm test
npm run check
npm run build
node scripts/s2-launch-check.mjs --out=新的输出目录
```

本轮源码、测试和运行证据写入 `artifacts/server-logging/20261116/`。本地试玩版本的切换需使用新的完整包，先检查无人对局；不能在运行目录直接替换 JS，不能从旧一局补造这些新日志。

## 本轮执行记录

服务器组 17 项通过；累计 199 项通过、0 失败、0 跳过，工程检查的 102 个格式/规则文件和 100 个运行模块通过，完整构建通过。原应用用例在旧实现下为 1 通过、2 失败，证明新日志断言有效；首轮服务器组为 16 通过、1 失败，修正 ws 长度错误分类后 17 项全过，所有报告保留，不靠重跑掩盖失败。

复用独立启动用例后，实际入口输出恰好一条 `endReason=empty` 摘要；完整 JSON 为 695 字节，构建/产品/配置、UTC 时间和运行 UUID 均核对，正常建房、离场及关闭无异常警告。摘要之外保留原启停文字，没有新增帧日志。协议仍为 9，规则哈希未变；本轮未跑容量、O4、真实丢包或设备体验矩阵。
