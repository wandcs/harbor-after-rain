# S1、S2 测试补强执行记录

日期：2026-11-14。依据：[已确认设计](s1-s2-test-design.md)和[开发约定](development-guide.md#8-测试验收与证据)。本轮只实施必要测试和运行工具，不改产品规则，不进入 S3。

## 数量与结果

开始前实测基线 186 项通过。本轮仅新增设计中的 N1、N2、N3 三条永久逻辑用例，其余加强原用例；临时故障探针不计永久用例。最终全量实际执行 **189 项通过，0 失败、0 跳过**。不是由历史数量相加推定结果。

| 独立责任组 | 实际通过数 | 证据目录（下述根目录内） |
| --- | ---: | --- |
| 共用规则 `sim` | 15 | `layers/sim` |
| 服务器 `server` | 13 | `layers/server` |
| 客户端 `client` | 12 | `layers/client` |
| 协议 `protocol` | 2 | `layers/protocol` |
| 工具 `tooling` | 5 | `layers/tooling` |
| 原有离线与表现回归 `legacy` | 142 | `layers/legacy` |
| 累计全量 | 189 | `logic-current` |

Node 输出可能将未匹配文件显示为通过。统一入口依据结构化的逐文件 `test:summary` 统计真实用例，最终以 `Selected results` 和 `summary.json` 为准；本轮三条新用例也分别独立运行，各只计 1 项。匹配错误的 Node 和浏览器选择均实测返回非零码。

浏览器集成单列 **5 次运行**，不加进上述 189 项：

| 场景 | 配置 | 结果与实际平均 FPS | 证据 |
| --- | --- | --- | --- |
| I1 双方交火 | A：60 Hz / 上限 120 FPS | 通过；84.0 / 93.5 | `browser-fresh-fixture/S2-I1-A` |
| I1 双方交火 | B：60 Hz / 上限 30 FPS | 通过；25.6 / 25.6 | `browser-independent/S2-I1-B` |
| I1 双方交火 | C：30 Hz / 上限 30 FPS | 通过；26.2 / 26.0 | `browser-independent/S2-I1-C` |
| I2 另一玩家恢复 | 默认 60 Hz | 通过；真实三秒倒计时，重复恢复不延长 | `browser-independent/S2-I2-A` |
| I3 触摸中断 | 默认 60 Hz | 通过；保持接触时转屏，清理旧接触，新触摸可用 | `browser-independent/S2-I3-A` |

A/B 实际均值 88.7 / 25.6 FPS，确实形成不同渲染节拍；仅调整 `Game.loop` 的回调上限，不修改模拟步长。每次运行自建服务和浏览器，退出后检查最后成员、房间及连接释放。报告包含双方输入确认、生命、阶段、权威事件和状态。

最终离线 HTML 另做一次原有浏览器回归：断网、无服务端，真实键鼠移动、开枪、完整换弹、暂停恢复、退出与重开通过；HTTP 请求和 WebSocket 均为 0，见 `offline-final/report.json`。它与五个联网运行分开计数。

## 覆盖与实施调整

| 设计项 | 实施及直接证据 |
| --- | --- |
| N1 | 默认目标 50，真实 M4 达标击杀；后续角色当步不动作，结束与后续步幂等 |
| N2 | 实际 `collectInput` 的键鼠/触控转换、归一化、边沿消费、视角限幅与协议合法性 |
| N3 | 实际客户端会话、预测和状态接收；本地中断只发 interrupt，明确暂停才发 pause，等待权威恢复 |
| E0 | 原地图对照保留；两个实际 NavGrid 的搜索缓冲、代次和重复路径相互隔离 |
| E1 | 249/250/251 ms 新鲜度边界；固定步 1/7/13 精确三发、27 发余弹及输入来源 |
| E2 | 240 步真实预测/重放；射击后 28/90、换弹后 30/88，反馈不重复；实际配对接收拒绝错序号/错身份，生命切换清理旧输入 |
| E3 | 历史目标在射线上、当前已移走；四种引用变体精确区分历史命中和当前落空；200/250 ms 窗口边界及发送空洞 |
| E4 | 两条真实连接的加入、离场补机器人、重入与最后离场；旧身份/弹药/未来输入不继承，另一角色保留 |
| E5 | 三兼容字段分别拒绝；四类真实错误连接被拒后，正常连接仍可同步时钟、执行输入、收到配对确认 |
| E6 | 实际房间与 Outbox；快慢连接同房、最新完整快照替换、重要消息顺序、未发送样本不可回溯，2000/2001 ms 积压边界 |
| E7 | 两名玩家执行同一操作顺序；分别移动、持续开火、完整换弹。独立小模型按实际消费输入和 700 RPM、30/90、2.3 s 规则计算精确发射 tick、弹药与换弹；不要求不同浏览器睡眠产生相同输入帧数 |

I1 每段初始夹具重新出生双方与机器人，并将机器人放回正常出生区，机器人继续执行真实 AI；双方在真实地图侧舷货道对射，目标初始血量设为 1。移动、开火、伤害、计分、换弹及快照反馈均走真实链路，不以准备状态作为交火证据。逐笔核算包括机器人在内的实际死亡对比分的贡献，并单独要求玩家造成目标一次死亡。I2 未修改恢复时间戳或直接设置 running。

原工程探针用例改名为 `locked checkers reject static violations and unmatched or failing test selections`，保留原静态检查断言，增加嵌套测试的成功、零匹配失败和断言失败传播检查。其余原有名称保留。

## 首轮失败与反证

- 选择入口首轮把 Node 的空文件占位当作通过；TAP 文本解析又受 Windows 特殊临时路径转义影响。改用 Node 的结构化逐文件事件，隔离嵌套运行继承的 `NODE_TEST_CONTEXT`；不继续增加路径转义分支。使用 [Node 官方自定义 reporter 接口](https://nodejs.org/docs/latest-v24.x/api/test.html#custom-reporters)。失败保留于 `tooling-first`、`tooling-diagnosis`、`tooling-fixed`、`tooling-structured`，修复结果为 `tooling-structured-fixed` 及最终工具层。
- I1 首轮错误地只预期玩家加一分，遗漏活动机器人的击杀；第二轮继承上一段机器人位置，玩家换弹期间被击杀并复活，使库存预期失效。分别保留于 `browser-first`、`browser-score-fixed`。改正夹具独立性并核对全部死亡与比分，保留真实玩家击杀、精确弹药和存活要求，没有取消机器人 AI 或放宽预算。
- 临时移除胜利后的角色循环停止条件，N1 检出 C 多打一发；临时取消在线移动归一化，N2 检出斜向速度错误。探针均非零退出，之后按原字节恢复源码，N1/N2 独立复验及各层再次通过。见 `counterexamples.json`、`counterexamples-final` 和对应日志。
- 初轮静态检查发现新测试缺少 `URLSearchParams` 的 Node 导入，补齐后通过。探针采集曾遇到 Python 默认 GBK 解码错误，改用 UTF-8；临时修改仍由 finally 原样恢复。

本轮没有发现需要修改产品实现的缺陷；上述失败涉及测试工具、夹具及预期。产品源码与开工快照逐文件哈希核对一致。

## 环境、产物与证据

Windows；Node.js 24.18.0、npm 11.18.0、Chrome 157.0.8103.78。桌面 1280×720，触摸模拟 844×390 / 390×844，种子 4207。真实 HTTP/WebSocket 与浏览器均以同一桌面用户运行，使用临时端口。分支 `codex/s2-network-slice`，基线提交 `3fb8741a42c09d66372b2fc08190747f1422a44d`，此前 S1/S2 与本轮内容均未提交。

`npm run check` 检查 72 个格式/静态规则文件和 92 个运行模块；完整构建成功。构建标识仍为 `e20855cbf9f6dfb1a31b8575bcf5c1fa35f7f313a3ee9fe67245eaec5f34b0ed`，规则标识仍为 `9223bac1e355ddb1660e3636fa467656e0e784f131b36cda09d847dcce99f51d`。测试和文档不参与产品标识；另以本轮来源清单及 SHA-256 追踪。

证据根目录：[artifacts/s1-s2-test-review/20261114](../artifacts/s1-s2-test-review/20261114/)。含开工来源快照、186 项实测基线、逐文件事件与统计、各层日志、首轮失败、浏览器报告/截图、最终来源和产物清单。归档：[本轮证据包](../artifacts/s1-s2-tests-20261114.zip)，校验见同名 `.sha256` 文件。旧 S1/S2 归档保持不变；其匹配构建的 CLI 启动及静态预览证据按影响复用，不冒充本轮重跑。

## 独立复现

使用 Node.js 24.x、npm 11.x，按锁文件 `npm ci`。在仓库根目录运行；浏览器前先 `npm run build`，需要时设置 `CHROME_PATH`。

```powershell
npm test
npm run check
npm run test:server
npm run test:client
node scripts/run-tests.mjs --case=S2-N1
node scripts/run-tests.mjs --layer=client --case=S2-N2
node scripts/run-tests.mjs --layer=client --case=S2-N3
node scripts/run-tests.mjs --file=tests/net/prediction.test.mjs --case="full save/restore and real M4 replay preserve RNG, recoil, ammo and hit-response state without repeated effects"
node scripts/s2-browser-check.mjs --case=S2-I1 --profile=A
node scripts/s2-browser-check.mjs --case=S2-I1 --profile=B
node scripts/s2-browser-check.mjs --case=S2-I1 --profile=C
node scripts/s2-browser-check.mjs --case=S2-I2
node scripts/s2-browser-check.mjs --case=S2-I3
node scripts/s1-browser-check.mjs --file dist/offline/harbor-after-rain.html --out artifacts/test-runs/offline-new-run
```

不选择浏览器 `--case` 时顺序执行全部五次；I1 单独选择但不指定 profile 时执行三配置，并检查实际渲染对照。其他已补强项按设计文档中的文件与完整名称选择。临时状态、服务、上下文由测试自身建立与关闭，不需手动启动服务器。

## 保留缺口

实机输入、焦点、声音和真实网络体验本轮按用户要求暂缓；真实弱网、容量和长期资源趋势仍属后续阶段。传输替身只证明应用层慢连接策略，CDP 触摸不等于物理设备。S2 自动化通过不等于全部体验验收、集成或发布通过；未进入 S3，未提交、推送或部署。
