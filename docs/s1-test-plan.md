# S1 测试方案与执行记录

日期：2026-11-13。状态：实现完成、验证通过。S1 必需项已完成；尚未提交、合并或发布。

本文保留 S1 当轮方案与证据。后续按新版测试规范完成了[覆盖审查与补强设计](s1-s2-test-design.md)及[执行验证](s1-s2-test-results.md)；当前阶段状态见[分阶段实施计划](online-implementation-plan.md)，不以本页历史状态判断后续进度。

## 目标与范围

按[实施计划 S1](online-implementation-plan.md#3-s1共用交火链路与工程检查)提取共用地图、移动、武器、射击姿态、骨骼命中及伤害计算，保留 M4 真实交火和必要机器人链路。原离线入口使用提取后的计算，`npm start` 保持静态预览。联网协议与服务属于 S2，本阶段不实现。

## 对照与判断方法

开始改动前保留原源码和构建到 `artifacts/online-s1/baseline/`，记录来源、未提交差异及工具版本。用原实现生成地图碰撞、移动序列、武器状态、骨骼姿态和射击起点/方向的对照样本；样本包含生成脚本、种子及场景，不能由新实现重新生成后覆盖原样本。

固定步长为 1/60 秒，规则随机使用可重现种子。碰撞定义、弹药、阶段和事件数量要求相同；位置、方向、骨骼矩阵等双精度计算对照容差为 `1e-9`。现有 GPU 几何测试沿用原有精度。截图用于目视检查，不以逐像素相同或截图 FPS 判断规则和性能。

原样本生成时发现 Three.js 对象 UUID 也消耗全局随机数，因此进一步显式固定步态初始相位和武器模式种子，再为操作序列设置规则随机源。生成器及来源校验见 [fixtures 说明](../tests/fixtures/README.md)；所有预期仍由原提交源码生成，未使用新核心重录预期。新增运行核心将规则随机与视觉随机分开，姿态及 AI 查询缓冲归各实例，静态规则表冻结。

| 编号 | 测试与场景 | 通过条件与证据 |
| --- | --- | --- |
| T1 | 原有逻辑与构建基线 | 保存完整 `npm test`、`npm run build` 日志及构建校验值 |
| T2 | 检查入口 | 嵌套目录临时失败用例令测试命令失败；格式、静态规则、越界导入和循环违规能使检查失败；恢复后通过 |
| T3 | 共用地图与移动 | 原地图碰撞定义、出生点、通道、楼梯、高台、下蹲跳跃及真实导航路径与原样本一致；不同房间查询工作缓冲独立 |
| T4 | 命中与射击姿态 | 头胸四肢、移动、蹲跳、换弹、后坐及受击骨骼与原样本一致；CPU 姿态无需材质或模型；本人射击起点/方向与原镜头计算一致，零时间查询不额外推进弹簧 |
| T5 | 武器、弹道与伤害 | M4 连射、弹药、换弹和切枪；散布与后坐种子可重现；穿透、遮挡、出生保护、护甲、队伤、死亡状态与计分；实际 AI 可在无设备环境移动并开枪 |
| T6 | Node.js 实际链路 | 不提供 `document/window`、渲染器、材质或声音对象，实例化实际地图、角色、姿态和 AI，在宿主提供的时间与随机源下步进真实交火 |
| T7 | 浏览器原入口 | 用真实键鼠移动、瞄准、连射、换弹、受击、暂停/恢复与重开；检查渲染和运行错误，保留前后截图与状态；配套原有场景回归覆盖变更影响 |
| T8 | 离线最终产物 | `file:` 打开新单 HTML，浏览器断网并拒绝外部请求，完整启动、移动、射击和暂停恢复；不发起服务器连接 |
| T9 | 累计回归与审阅 | `npm test`、`npm run check`、`npm run build` 和必要浏览器场景通过；单独检查最终差异与模块导入图；更新实际命令和边界说明 |

浏览器记录 Chrome 精确版本、Windows 版本、1440×900 桌面视口、键鼠方式、受测构建和地址。触屏与转屏受影响时补浏览器触控回归；模拟不标为真机。浏览器配置使用 `CHROME_PATH` 与明确的受测地址，脚本自行释放创建的浏览器和临时服务。

工程检查使用锁定版本的 Prettier 和 ESLint；格式覆盖新文件与小型适配层，大型旧文件只做本次局部修改并检查语法，迁移外的旧代码不宣称完成全仓规范化。新 `sim/protocol/net/client/server` 导入边界与循环检查覆盖完整本地依赖链，不允许经旧模块绕回表现层。

## 退出条件与记录

T1～T9 的必需项全部通过且有可访问证据，才更新 S1 为通过。失败记录保留根因、修正及相同场景复验结果；未执行项明确列出。原始证据写入 `artifacts/online-s1/`，最终摘要补在本节并同步[阶段状态](online-implementation-plan.md#9-状态与交付记录)。

工具使用依据：[ESLint 配置](https://eslint.org/docs/latest/use/configure/configuration-files)、[Prettier API](https://prettier.io/docs/api)、[Node.js 24 测试运行器](https://nodejs.org/docs/latest-v24.x/api/test.html)。

## 工具依赖决定

在线审计确认 ESLint 10.14.0 的 minimatch 10.x 依赖链受 [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) 影响。审计建议的 ESLint 9.39.5 虽不触发该告警，但[官方支持表](https://eslint.org/version-support/)列明 9.x 已结束维护，因此最终保留受维护的 10.14.0，并仅在其依赖子树将 minimatch 覆盖为修补版 11.0.1。

修改前检查了官方发布包：ESLint 与 `@eslint/config-array` 实际使用 `Minimatch` 构造器、`match()` 和 `pattern`，未使用 [11.x 删除的接口](https://github.com/isaacs/minimatch/blob/main/changelog.md)。兼容性通过真实仓库检查、规则与路径匹配用例、合法及违规模块测试验证；干净安装及在线审计另有原始记录。该覆盖只影响开发检查，后续 ESLint 自身支持无告警依赖版本时，删除覆盖并复跑相同检查。

## S1 最终结果

来源：`codex/s1-shared-combat` 工作区，起点为 `3fb8741a42c09d66372b2fc08190747f1422a44d`。本轮保留了起点已有的未提交文档。最终源码文件指纹、构建与证据索引见 `artifacts/online-s1/summary.json` 和 `source-manifest.json`。

环境：Windows 10.0.26300.0，Node.js 24.18.0，npm 11.18.0，Chrome 157.0.8103.78。桌面浏览器为 1440×900 键鼠；移动端使用浏览器触屏与方向模拟，不标记为手机真机或原生方向锁定验收。

| 检查 | 实际结果与证据（相对 `artifacts/online-s1/`） |
| --- | --- |
| 干净安装 | `npm ci --no-audit --no-fund` 成功，见 `npm-ci.log`；esbuild 安装脚本有 npm 信任提示，当前平台预编译包可正常测试及构建，未更改全局信任配置 |
| 累计自动化 | `npm test`：158/158 通过，0 失败、0 跳过，见 `test.log`；其中新增 11 项实际核心测试和 5 项检查工具测试 |
| 原实现对照 | 447 个碰撞体及地图元数据相同；七武器骨骼、移动、M4 状态和本人射击姿态在 `1e-9` 容差内通过；无设备 AI 与 M4 命中/伤害/击杀/计分链路通过 |
| 检查入口 | `npm run check` 通过：35 个文件执行格式与静态规则，72 个运行模块检查语法、边界和循环，见 `check.log` |
| 负例验证 | 嵌套临时失败用例确实令测试退出非零，违规模块确实被格式、设备 API 和越界检查拒绝，见 `discovery-negative.log`、`check-negative.log`；临时违规文件已删除，最终检查通过 |
| 构建 | `npm run build` 成功，最终 HTML 为 1,199,063 字节，SHA-256 为 `9da960ce590efa65e0a3dea14a630dfe76b78ce786b255a5b233e257d97f68a7`，见 `build.log` |
| 断网原入口 | `node scripts/s1-browser-check.mjs --file dist/index.html --out artifacts/online-s1/offline` 通过真实键鼠移动、连射、换弹、暂停恢复、退出及重开中继争夺；外部请求和 WebSocket 均为零，见 `offline/report.json` |
| 浏览器实战与完整对局 | 在 `TEST_URL` 指向最终构建 `file:` 地址的配置下，`test:browser`、`test:arena`、`test:menu` 通过；覆盖实际渲染、受击/死亡/复活、低血量、声音图、通道楼梯高台和两玩法完整流程，见 `browser.json`、`arena.json`、`menu/menu-match-check.json` |
| 触控与转屏 | 相同构建上 `test:mobile` 六组双拇指场景和 `test:landscape` 五组方向场景通过，见 `mobile/mobile-controls-report.json`、`landscape/mobile-landscape-report.json` |
| 展示场 | `test:lab` 九模块、战术子测试、离线和移动布局通过，见 `lab.json`；截图与详细输出另归档 |
| HTTP 预览 | `npm run test:preview` 在同一桌面身份启动临时回环服务，从临时目录启动仍返回正确 HTML，校验值相同；越界路径返回 403，进程已释放，见 `preview.json` |
| 依赖审计 | 最终 `npm audit --json` 报告已知漏洞总数为零，见 `npm-audit-resolved.json`；最初告警、调查与修正记录保留，未以离线审计的空结果替代在线证据 |
| 差异与文档 | 已单独审阅状态所有权、表现适配、射击/伤害调用方、资源和导入边界；本地文档链接、标题锚点及空白检查见 `doc-check.json` |

核心实现扩大到了共用计算所需的其他现有武器和 AI 方法，以保持单一规则来源；首轮联网样例仍按 S2 使用 M4，不据此提前宣称全部联网玩法完成。完整离线对局装配、UI 和浏览器输入继续保留在原模块；根目录兼容导出暂时保留，避免无关搬迁。

S1 必需验证没有未执行项。真人联网、实际手机系统能力、双设备交火、真实弱网、服务器容量和发布验收属于后续阶段，尚未执行。
