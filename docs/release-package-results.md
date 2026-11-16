# 独立运行交付包与清单验证

日期：2026-11-15—16。用户要求实现独立运行交付包和完整发布清单，复用既有用例，先不部署。依据为[发布与运行约定](release-runbook.md#3-构建与产物)和[研发约定](development-guide.md#8-测试验收与证据)。本轮完成该范围的软件与本地验证，不代表 S5 或 S6 整体验收完成。

2026-11-16 后续已完成[干净提交的正式来源包正向验证](#2026-11-16干净提交的正式来源包正向验证)：同一 ZIP 在 Windows 和 WSL/Linux 独立目录启动通过。下文旧轮中的未提交来源与待验状态保留历史，当前目标机、实机和完整发布门槛仍待满足。

## 范围与交付

- `npm run build` 生成独立运行目录：在线、离线、服务端、三份分目标清单、必要许可，以及运行 `package.json`、锁文件、`verify.mjs`、`RUNNING.md` 和完整 `release.json`。
- 运行依赖仅 `ws 8.23.0`，使用 npm 生成的独立锁文件；构建时核对它与源码锁的版本及完整性。Three.js 和 fflate 已随产物打包，保留原许可。不打包开发工具、全局模块、源码、参考原文件或本机配置。
- `npm run package` 全量构建后仅按明确白名单生成 ZIP、旁置清单和 `SHA256SUMS`。全量清单记录产品版本、源码提交与构建相关本地差异摘要、实际输入哈希、构建/协议/规则标识、带时区时间、精确工具链、构建配置与哈希、源码和运行锁的哈希、依赖信息、默认有限运行配置及各文件字节数/哈希。清单不校验自身，外部校验值覆盖清单和 ZIP。
- 默认本地包记录 `build.kind=local` 和真实脏状态；`package:release` 要求完整生产构建及干净 Git 来源。没有 Git 元数据也不能伪装为正式来源。干净来源标记不代替设备、容量、运行验收或发布授权。

本轮最终产物为 [ZIP](../artifacts/release-package/20261115/package/harbor-after-rain-v1.4.9-ca870488bf30-local.zip)、[完整清单](../artifacts/release-package/20261115/package/release.json)和[校验值](../artifacts/release-package/20261115/package/SHA256SUMS)。产品版本 1.4.9，协议 9，构建前缀为 `ca870488bf30`，完整构建标识见清单。规则标识沿用 `6b3516d0f2cbe33c4a9fd45f408e0a6b53f49ceff0930a6187dffd11772b3d50`。当前来源有未提交内容，未生成正式来源包。

## 覆盖设计与结果

复用并加强 `scripts/s2-launch-check.mjs`，不新增永久用例。该入口既可验证完整构建目录，也可验证 ZIP 和旁置校验值；都将文件放到仓库外空目录，使用空 npm 缓存执行 `npm ci --omit=dev --ignore-scripts`，检查依赖确实位于交付目录，再运行包内服务端入口。`npm start` 脚本内容也校验为同一 `node server/main.js`；本轮没有以 npm 进程作为服务管理器进行正式启停演练。

| 需求与责任 | 复用及补强 | 本轮结果 |
| --- | --- | --- |
| 完整清单 → 工具 | 既有启动检查增加 schema、产品、源码输入、默认配置、白名单、运行锁和哈希检查 | 旧清单缺完整 schema 时先失败，见 `red.log`；最终目录和 ZIP 通过 |
| 错误产物拒绝 → 工具 | 同一入口在其临时副本中分别损坏、删除在线文件，运行包内校验器后恢复 | 两种错误均被拒绝，原始日志保留；没有修改最终 ZIP |
| 独立目录 → 集成 | Windows 桌面普通用户，仓库外空目录/空缓存安装并启动 | `ws` 实际解析到该临时目录的 `node_modules`；页面、健康信息、握手、建房退出和清理通过 |
| 实际 ZIP → 集成 | 同一入口分别在 Windows 和 WSL/Linux 使用同一最终 ZIP | 两端按独立锁文件各安装 1 个包，运行通过；所有测试进程和临时目录已清理 |
| ZIP 格式 → 工具 | Windows 原生解压器解开最终 ZIP，再运行包内校验 | 14 个列入清单的文件及清单自身通过 |
| 单目标隔离 → 工具 | 复用既有单目标核查，记录其他文件的哈希与修改时间 | offline/online/server 三种均通过；分别有 12/13/10 个无关文件保持不变 |
| 构建配置 → 工具 | 既有构建核查补在线 `--dev` 边界 | 开发配置改变构建标识、保留规则标识，不更新完整清单；混合产物被完整校验拒绝，随后全量重新生成最终包 |
| 来源边界 → 工具 | 对当前脏工作区执行 `--release` | 明确拒绝，未伪造干净来源，未提交现有工作区 |
| 累计与工程 → 既有入口 | 原 199 项及工程检查 | 199 项通过、0 失败、0 跳过；最终工程结果见证据 |

事前覆盖与数量决定保存在 `artifacts/release-package/20261115/plan.json`。目录、ZIP、系统变体和错误分支不是新增 Node 用例，不加入 199 项通过数。没有追加性能实验或扩大弱网矩阵。

本轮只改交付工具，未改游戏运行源码和网络参数。逐字节对照证明离线 HTML 与规则统一后的已验产物完全相同，在线页面和服务端替换构建标识后逐字节相同；因此复用此前真实浏览器流程与断网离线操作证据，未为相同运行逻辑重跑整套浏览器矩阵。证明见 `runtime-equivalence.json`，原证据见[规则统一记录](s4-test-results.md#2026-11-15统一规则配置收口)。

Windows：Node.js 24.18.0、npm 11.18.0。WSL：Ubuntu-26.04、普通 UID 1000、官方 Linux Node.js 24.18.0、随官方归档提供的 npm 11.16.0；仅在既有忽略的工具链目录补齐 npm，未全局安装。两种 OS 使用独立空缓存安装，未借用仓库 `node_modules`。WSL 本地验证不代表目标服务器或公网验收。

首个 `npm run package -- --out=...` 在当前 Windows PowerShell/npm 组合中把 `--out` 当作 npm 配置，包仍生成在默认目录，警告与产物保留；直接 Node 入口随后正确使用指定目录。README 因此明确自定义参数使用直接入口，不修改宿主 npm 包装器。

## 复现与剩余事项

从仓库根目录执行；每轮使用新的输出目录：

```sh
npm test
npm run check
node scripts/package-release.mjs --out=artifacts/releases/new-package
node scripts/s2-launch-check.mjs --out=artifacts/releases/new-directory-check
node scripts/s2-launch-check.mjs --package=artifacts/releases/new-package/实际文件名.zip --out=artifacts/releases/new-zip-check
```

WSL 使用同一 ZIP 和检查入口，需要 Node.js 24/npm 11；本轮可用工具链为 `artifacts/toolchains/node-v24.18.0-linux-x64/bin/node`。解包运行命令见包内说明或[源码说明](../packaging/RUNNING.md)。

尚未完成的原门槛继续保留：干净提交上的正式来源包正向验收、目标机容量与 IP 访问、真实设备体验、健康响应产品版本字段、服务管理器/日志轮转及停止重启/回退演练。O4 未通过项未关闭；没有采购、提交、推送、部署或安装常驻服务。本轮包可用于独立本地验证，不能标为已发布或正式验收完成。

后续已按用户安排完成[本地启停与回退演练](local-runtime-results.md)，并补齐健康产品版本与退出日志。上段属于本轮结束时的历史缺口；正式干净来源正向验收已由下节补齐，目标机、实机、目标服务管理器与长期日志轮转等验证仍待完成。本地验证没有部署或关闭 O4 未通过项。

原始证据：[目录](../artifacts/release-package/20261115/)、[归档](../artifacts/release-package-evidence-20261115.zip)及同名 `.sha256`。归档包含事前设计、首次失败、不同构建与操作日志、前后工具源码、最终清单/ZIP/校验值、两端运行及清理报告。

## 2026-11-16：干净提交的正式来源包正向验证

用户授权范围为干净提交生成完整包、复用现有启动用例在独立目录安装和运行、补充结果；不部署、不新增永久用例、不依赖旧回退包、不重跑 O4。此次未改运行代码、测试代码、依赖、参数或通过线，累计用例仍为 199。

### 来源、产物与完整性

- 来源提交：`cfafe1a1a0778d8a6b313faf2bbaf3abca57ddaf`，分支 `codex/online-multiplayer`。打包前后工作区均干净；112 个构建输入哈希与清单逐项一致。
- 产品 `harbor-after-rain` 1.4.9，协议 9；构建 `6d72408554abae6f33b07022bef2dbf1fc73c0c04983083ab74dfbdaba64dbae`，规则 `6b3516d0f2cbe33c4a9fd45f408e0a6b53f49ceff0930a6187dffd11772b3d50`。
- 构建使用 Node.js 24.18.0、npm 11.18.0、esbuild 0.28.2，Windows x64。`build.kind=release`、`source.dirty=false`，包名没有 `-local`；该标记证明来源条件，不代表已发布或整体验收通过。
- [独立 ZIP](../artifacts/clean-source-package/20261116/package/harbor-after-rain-v1.4.9-6d72408554ab.zip)、[旁置清单](../artifacts/clean-source-package/20261116/package/release.json)、[SHA256SUMS](../artifacts/clean-source-package/20261116/package/SHA256SUMS)。ZIP SHA-256：`088cc18d68e28bdf267cb58edca64f8183583a823403ffa53efaba692f836af0`；清单 SHA-256：`e24341a2aa501c54442ec50ac356de639f920a1f168324cc15d9d0deff5c8ea7`。
- ZIP 严格包含同一前缀下的 14 个运行文件和 `release.json`，包括在线、离线、服务端、三个分目标清单、许可、运行包清单/锁文件、核验器与运行说明。外部 ZIP/清单校验、内部白名单与每文件大小/哈希均通过；两端运行后原 ZIP 哈希未变。

### 复用的检查与实际结果

打包前 `npm test` 为 199 通过、0 失败、0 跳过；`npm run check` 检查 102 个格式/静态规则文件和 100 个运行模块，通过。打包入口执行完整构建并调用现有核验器，本轮没有另增测试编号。

两端使用同一个 `scripts/s2-launch-check.mjs --package=...` 入口与同一个 ZIP。它从 ZIP 解出运行文件到仓库外随机临时目录，在该目录核验并以新 npm 缓存、空用户/全局 npm 配置执行 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`，只安装锁定的 `ws 8.23.0`。模块解析确认来自各自的包内 `node_modules`，没有借用仓库依赖；安装前后完整性均通过。

| 检查 | Windows | WSL/Linux |
| --- | --- | --- |
| 环境 | Node 24.18.0、npm 11.18.0、Windows x64 | Ubuntu-26.04 / Linux 6.18.33.2，UID 1000，Node 24.18.0、npm 11.16.0 |
| 独立位置 | 桌面用户临时目录下的 `harbor-release-…/package` | `/tmp/harbor-release-…/package` |
| 包内核验、空缓存安装、依赖解析 | 通过 | 通过 |
| 损坏/缺失页面拒绝 | 两项均通过，恢复原文件后才启动 | 同左 |
| 在线/离线页面、健康产品版本及完整构建身份 | 通过 | 通过 |
| WebSocket 握手、空大厅、创建中继 4v4 房间、60 Hz 配套配置及完整快照、主动离场和关闭连接 | 通过 | 通过 |
| 服务停止与端口 | SIGTERM 结束进程，约 5.80 ms；端口 13377 释放并可重新监听 | 真实 SIGTERM，退出码 0、无终止信号，约 6.74 ms；端口 46221 释放并可重新监听 |
| 最终清理 | 子进程退出、临时目录与新缓存移除，无兜底强杀 | 同左 |

Windows 的子进程信号终止不记为优雅退出；Linux 满足现有 5 秒退出限。本轮启动变体只核对上述包内真实连接链路，没有将握手、建房或快照当作实际交火、设备手感或容量验收。没有重复历史重启/回退矩阵，也没有安装服务管理器、自启动或常驻后台服务。

### 精确入口与证据

本次从干净提交执行以下命令。第一条是 `npm run package:release` 的直接 Node 等价入口，另指定新输出目录以避免 Windows npm 参数转发差异；第二条在 Windows 桌面用户上下文执行：

```sh
node scripts/package-release.mjs --release --out=artifacts/clean-source-package/20261116/package
node scripts/s2-launch-check.mjs --package=artifacts/clean-source-package/20261116/package/harbor-after-rain-v1.4.9-6d72408554ab.zip --out=artifacts/clean-source-package/20261116/launch-windows
```

Linux 对同一包执行相同第二条入口，输出为 `launch-linux`；实际命令在 WSL 普通用户中将已有 Node 24 工具链加入 PATH，并将用户/全局 npm 配置指向本轮空文件。发行版、工具链路径与账户须按[续接指南](development-continuation.md)和 [S3 环境说明](s3-test-plan.md#独立运行与环境准备)核对，不为本次校验安装新系统工具。

若要对上述归档逐字节重验，先检出清单中的来源提交 `cfafe1a`；原启动工具会核对当前 HEAD、源锁文件和全部构建输入。只改文档后的新提交也不冒充原包来源。若要为后续提交生成新包，保持该提交干净并重新执行打包入口，使用新的输出目录；构建时间和提交会更新，不承诺 ZIP 自身哈希相同。

事前范围、来源/包审计、两端报告及完整日志保存在[本轮目录](../artifacts/clean-source-package/20261116/)；[Windows 报告](../artifacts/clean-source-package/20261116/launch-windows/report.json)和 [Linux 报告](../artifacts/clean-source-package/20261116/launch-linux/report.json)分别记录安装位置、负例、房间、停止与清理。临时汇总最初在 Linux 进程仍运行时读取报告得到 ENOENT；等待该进程正常完成后汇总通过，没有重跑启动用例或改产品。

本轮范围已验证通过，补齐“干净提交上的正式来源包正向验收”这一缺口。目标服务器/IP 路径、真实双设备体验、目标服务管理器、长期日志轮转及目标环境运行/回退仍待验，O4 未通过结论继续保留；不将本轮记为 S5/S6 整体通过，也没有部署或创建 PR。
