# 独立运行交付包与清单验证

日期：2026-11-15—16。用户要求实现独立运行交付包和完整发布清单，复用既有用例，先不部署。依据为[发布与运行约定](release-runbook.md#3-构建与产物)和[研发约定](development-guide.md#8-测试验收与证据)。本轮完成该范围的软件与本地验证，不代表 S5 或 S6 整体验收完成。

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

后续已按用户安排完成[本地启停与回退演练](local-runtime-results.md)，并补齐健康产品版本与退出日志。上段属于本轮结束时的历史缺口；目前仍待正式干净来源正向验收、目标机、实机、目标服务管理器与长期日志轮转等验证。本地演练没有部署或关闭 O4 未通过项。

原始证据：[目录](../artifacts/release-package/20261115/)、[归档](../artifacts/release-package-evidence-20261115.zip)及同名 `.sha256`。归档包含事前设计、首次失败、不同构建与操作日志、前后工具源码、最终清单/ZIP/校验值、两端运行及清理报告。
