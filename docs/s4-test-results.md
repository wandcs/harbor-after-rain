# S4 实现与自动化记录

日期：2026-11-14。依据：[S4 方案](s4-test-plan.md)、[产品设计](online-product-design.md)、[研发约定](development-guide.md#8-测试验收与证据)。按用户明确要求进入 S4，继续实机暂缓、优先实现与自动化的安排。软件实现与本轮自动化完成；未进入 S5，未提交、推送或部署。

## 交付行为

- 页面直接展示房间列表；可选玩法、4v4/5v5/8v8、昵称、主武器及可选密码，创建后立即开始。列表显示真人数、容量、剩余时间、暂停状态与密码标记，不发送密码。
- 服务器管理多个独立房间，原子接纳、均衡真人分队和替换机器人；密码错误、满员及结束返回可重试原因，不关闭列表连接。创建者无额外权限；离场、断线补位和最后真人释放沿用核心所有权。
- 四种主武器、手枪、刀、手雷、换弹与切换接入真实 Actor 链路；主武器可在出生区即时调整，区外复活生效。投出后离场的手雷保留轻量原归属，不能把击杀转给替补。
- 中继计数、占领、争夺、遮挡、保护与轮换在共用计算中运行；刀和手雷计算也与离线入口共用。在线预测重放这些动作，但不在客户端提交伤害或计分。
- 暂停显示暂停者、恢复倒计时；配装、后台、失焦与竖屏只中断本人输入。结算展示当前在场角色战绩、释放房间，返回列表后复用同一连接，可再次创建或加入。

协议版本升为 **2**，不保留自动进入样例房间的旧语义。增加 list/create/join/loadout、rooms/rejected/result/left；输入允许受限的 sw 与 altPressed，沿用输入时释放这些边沿。加入、离开和结果重置本房间序号、缓冲与事件去重；已结束房间的在途操作忽略，不能因此关闭列表连接。构建清单从协议模块读取版本。

房间数与连接数启动上限分别为 MAX_ROOMS=8、MAX_CONNECTIONS=64，可在 1–32、1–256 内显式设置。这是有限的开发初值，未测定目标服务器容量；没有新增依赖、服务或持久化数据。

## 数量与通过证据

新增 **6 条永久 Node 用例**，复用并加强协议、输入及原回归，累计 **197 项通过，0 失败、0 跳过**。六条新用例均已分别按编号独立运行。另新增 S4-I1 一个浏览器场景、两玩法变体；团队竞技变体补一次真实投掷展示与爆炸轨迹，不计为新增独立用例。

| 检查 | 结果 | 证据根目录内位置 |
| --- | --- | --- |
| 房间分块 | 原服务器组及 S4-R1/R2 共 16 项通过 | `rooms-verified`；最终完整状态以累计回归为准 |
| 共用规则分块 | 17 项通过；M2 后续补两玩法完整逻辑对局及实际遮挡/保护，独立通过 | `rules-first`、`full-matches-current` |
| 客户端分块 | 15 项通过，含 S4-C1/C2；完整武器重放无重复副作用 | `client-first`、`independent`、累计回归 |
| 累计逻辑 | 197 项通过；新增 6 项独立选择均通过 | `logic-delivery`、`independent/S4-*` |
| 工程与构建 | 84 个格式/静态规则文件、95 个运行模块；在线/离线/服务端构建通过 | `check-complete.log`、`build-current.log`、`final-dist` |
| S4 浏览器 | 两玩法流程通过，团队竞技真实投掷物可见、爆炸及移除通过 | `product-current/relay`、`grenade-current/tdm`；`product-current/tdm` 保留投掷补强前的有效结果 |
| 原交火与输入回归 | A/B/C、暂停恢复、原生浏览器触摸共 5 个运行通过 | `browser-regression-current` |
| 编码与真实网络 | E1 两档无损往返；E2 两档 RTT、抖动、真实丢包、中断、慢连接及一次持续积压，共 17 个配置通过 | `matrix-current` |
| 离线浏览器 | 断网单 HTML：移动、射击、换弹、暂停、两玩法重开；0 HTTP 请求、0 WebSocket | `offline-current` |
| 实际构建入口 | 发布清单匹配握手、在线/离线页面、实际创建和离开中继房间通过 | `launch-current` |

E1 两档、E2 的 17 个配置和浏览器运行分别计数，不加进 197 项逻辑通过数。完整逻辑对局是受控时间的无渲染计算，不代表实时性能；同机浏览器与触摸注入不代表物理设备验收。

## 首轮失败与处理

| 证据 | 原因与处理 |
| --- | --- |
| `browser-first` | 构建清单把协议写死为 1，新页面使用 2 导致握手失败；改为引用唯一协议定义，最终流程与构建入口通过 |
| `browser-third` | 在线 simulate 没有消费 KeyB，配装打不开；接入本地菜单操作，真实 KeyB/选择/关闭已复验 |
| `browser-fourth` | 结算释放房间后，在途输入触发 NOT_JOINED 并关闭连接，冲掉结果；服务器忽略无房间的迟到操作，S4-R2 和浏览器结果返回/复用连接通过 |
| `rooms-first` / `rooms-final` | 客户端关闭事件早于服务端释放；改为等待服务端关闭事件。一次补丁未命中，失败记录保留；`rooms-verified` 及最终回归通过 |
| `browser-second` / `logic-final` | 测试误要求未创建的 player 必为 null；配装夹具在角色死后要求即时生效。分别改为检查无角色、通过真实 spawn 准备存活角色，未改变生产规则 |
| `combat-final/S2-I1-C` | 非参测机器人击杀了换弹中的射手；在双真人预算场景准备空弹药机器人，保留其真实 AI/移动，枪战预算与真人命中断言不变。AI 开火由原核心与 E2 验证，最终五个浏览器运行通过 |
| `network-final` | 原 4v4 负载峰值 262582 字节，短暂过阈后先按 6 秒存活规则关闭，不能证明持续积压分支；改用产品支持的 8v8、14 名机器人真实死亡姿态负载，不改复活、超时或发送阈值。最终积压 273908 字节、持续约 2029 ms，由服务器处置；健康玩家继续推进 |

各首轮日志和清理结果均保留，最终通过没有抹去失败。研发检查中新脚本浏览器全局及 Node performance 导入缺失也已修正并复验。

最终夹具审查为服务器请求加入有序 clock 应答屏障，避免残留快照使断言早于动作处理；握手也设置两秒上限。修改后再次完成累计回归及工程检查。新浏览器入口的未知选择已反证为非零退出。

## 复现、来源与限制

```sh
npm test
npm run check
npm run build
node scripts/run-tests.mjs --case=S4-R1 --layer=server
node scripts/run-tests.mjs --case=S4-M1 --layer=sim
node scripts/run-tests.mjs --case=S4-C1 --layer=client
node scripts/s4-browser-check.mjs --case=S4-I1 --mode=tdm --out=artifacts/online-s4/new-browser
node scripts/s3/run.mjs --out=artifacts/online-s4/new-network
```

S4-R2/M2/C2 同样支持独立选择；`npm run test:s4:browser` 默认运行两玩法，未知编号或玩法会失败。逻辑服务自建自关，无需人工准备。真实网络需要已配置的 WSL，环境准备沿用 [S3 说明](s3-test-plan.md#环境准备与命令)；所有 Windows 本地网络、WSL 和浏览器测试按身份约定使用桌面用户在沙箱外运行。

环境：Windows、Node.js 24.18.0、npm 11.18.0、Chrome 157.0.8103.78；WSL Ubuntu-26.04 / Linux Node.js 24.18.0。规则种子 4207。构建 `e1a4d5f1a34682013bbe97d7055c0d70a5487af36c9a096899a4d750f0911de7`，规则 `61500b73538f3c1093eaab62395eadd486597b89197af0a78a94d03f10ee0c80`，协议 2 / JSON。

证据：[目录](../artifacts/online-s4/20261114/)、[ZIP 归档](../artifacts/online-s4-evidence-20261114.zip)及同名 `.sha256`。包含开工快照、最终源码与任务差异、结构化结果、首次失败、原始网络记录、截图和发布清单文件；此前 S1–S3 证据保持不变。

实机双设备、系统声音/焦点/旋转和主观弱网体验继续待验；目标服务器容量、长期负载与正式发布条件未验。当前状态为 S4 软件实现与自动化完成，不能描述为全部体验验收通过，也未进入 S5。

## 2026-11-15：统一规则配置收口

按用户要求补齐产品方案中的统一规则配置，[补强设计](s4-test-plan.md#2026-11-15统一规则配置补强)复用既有用例。新增 `src/sim/match-rules.js`，在线权威、离线对局、大厅剩余时间与浏览器展示共用最长 180 秒、提前目标 50、常规机器人难度。武器定义和中继计算沿用已有共用实现。移除离线分数、难度选择，删除旧本地设置的 `goal/diff` 并持久化；玩法、人数、离线阵营、主武器、画面与操作偏好保留。

| 检查 | 实际结果 | 本轮证据目录内位置 |
| --- | --- | --- |
| 缺陷复现 | 补强后的原菜单用例在旧构建失败，仍存在 2 个自定义规则控件；旧存储准备为 `goal=100/diff=hell` | `menu-red.log`、`before/` |
| 共用规则独立选择 | `S4-M2` 1 项通过；3 个空文件占位未计数，配置字面值、不可变和默认机器人难度通过 | `rules-case/` |
| 累计回归与工程检查 | 199 项通过、0 失败、0 跳过；97 个格式/静态规则文件、100 个运行模块通过 | `tests/`、`tests.log`、`check.log` |
| 离线菜单与结算 | 旧字段及入口移除、其他偏好保留；两玩法真实开局 180 秒/50 分/常规机器人，时间截止和 50 分提前结算通过；桌面与移动布局、键盘、暂停重开及原离线变体通过 | `menu-green/` |
| 在线产品流程 | S4-I1 两玩法通过，包含旧设置清理与双方规则一致；原武器、暂停恢复、退出、结算和连接复用继续通过 | `online-browser/` |
| 离线实际操作 | 最终单 HTML 在断网下移动、射击、换弹、暂停恢复及两玩法重开通过，HTTP 请求 0、WebSocket 0、页面错误 0 | `offline-operations/` |
| 受影响旧浏览器入口 | 原 `browser-check` 的 100 分 UI 操作改为仅该轮换夹具设置目标，继续验证原 75 秒轮换；执行通过、页面错误 0；保留两条着色器警告，未改渲染 | `legacy-browser-run/artifacts/`、`legacy-browser.log` |
| 构建与打包启动 | 全量构建及四份清单的版本、范围、字节和哈希通过，打包服务页面、握手、建房退出通过 | `build.log`、`launch/`、`launch.log` |

菜单用例的三分钟计时窗口沿用原夹具，临时抬高该轮目标，避免提前胜利截断计时路径；正常开局的 50 分规则与两玩法从 49 到 50 的实际提前结算分别断言。旧 `browser-check` 的 100 分也只用于隔离轮换检查，不作为产品可选规则。

未新增永久用例。浏览器场景和逻辑快进不计入 199 项，也不代表真实设备或性能验收。在线两玩法清理均为 clients=0、rooms=0、listening=false，浏览器和启动检查的临时进程均已退出。未追加性能实验，网络架构、生产网络参数和通过线保持；O4 未通过项与实机、目标服务器缺口保留，未进入 S6，未提交、推送或部署。

环境为 Windows、Node.js 24.18.0、npm 11.18.0、Chrome 157.0.8103.78；协议仍为 9，构建为 `d06e10a13d85689a3d620b5d8122717c9b14aed665be94acc6b7f1b934a62c11`，规则标识为 `6b3516d0f2cbe33c4a9fd45f408e0a6b53f49ceff0930a6187dffd11772b3d50`。规则源码收口使规则标识更新，已有网络实验仍保留各自原始来源，未改判。

复现时从仓库根目录使用新输出目录；菜单检查使用离线入口，示例为本轮 Windows 路径：

```powershell
npm run build
npm run check
node scripts/run-tests.mjs --case=S4-M2 --layer=sim --out=artifacts/shared-rules/new-rules
node scripts/run-tests.mjs --out=artifacts/shared-rules/new-tests
$env:TEST_URL = 'file:///C:/repos/harbor-after-rain/dist/offline/harbor-after-rain.html'
node scripts/menu-match-check.mjs --out artifacts/shared-rules/new-menu
Remove-Item Env:TEST_URL
node scripts/s4-browser-check.mjs --case=S4-I1 --out=artifacts/shared-rules/new-online
node scripts/s1-browser-check.mjs --file dist/offline/harbor-after-rain.html --out artifacts/shared-rules/new-offline
node scripts/s2-launch-check.mjs --out=artifacts/shared-rules/new-launch
```

证据：[本轮目录](../artifacts/shared-rules/20261115/)、[归档](../artifacts/shared-rules-evidence-20261115.zip)及同名 `.sha256`；包含事前覆盖设计、原始失败、前后源码和产物、全部检查结果与截图。
