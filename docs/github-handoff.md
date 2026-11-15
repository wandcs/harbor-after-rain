# GitHub 提交准备

日期：2026-11-16。完成本地源码、测试和文档整理后，用户已授权创建个人 Fork、配置远程、整理提交并推送功能分支；不提 PR，不部署。源码上传与正式发布是不同操作，当前仍有明确待验项。提交及推送结果以功能分支历史与远端引用为准。

## 仓库与分支

上游为 [minarry/harbor-after-rain](https://github.com/minarry/harbor-after-rain)，默认分支 `main`。本轮通过 GitHub API 确认为公开仓库、允许 Fork；桌面账号 `wandcs` 只有读取权限，没有直接推送权限。

已创建 [wandcs/harbor-after-rain](https://github.com/wandcs/harbor-after-rain)，API 已核实其父仓库为 `minarry/harbor-after-rain`。保留现有提交历史，已从原工作分支创建并切换到 `codex/online-multiplayer`。未来可从该分支向上游 `main` 提 PR；个人 Fork 的 `main` 用于跟随上游。

| 远程 | 已配置目标 | 用途 |
| --- | --- | --- |
| `origin` | `https://github.com/wandcs/harbor-after-rain.git` | 保存和推送自己的开发分支 |
| `upstream` | `https://github.com/minarry/harbor-after-rain.git` | 跟踪原仓库、准备 PR |

仓库级 `remote.pushDefault` 已设为 `origin`；只推送该 Fork 的功能分支。Fork 适合保留上游关联并提交 PR；公开仓库的 Fork 也公开，不能当成私有备份。机制见 [GitHub Fork 文档](https://docs.github.com/en/pull-requests/reference/forks)和[远程配置说明](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/configuring-a-remote-repository-for-a-fork)。

本次同步发现上游 `main` 已从 `3fb8741` 前进到 `0316165`（1.5.0，陀螺仪与轻点开火）。功能分支保留已验证的 `3fb8741` / 1.4.9 开发基线；本轮不合入新功能、不改写上游或 Fork 的 `main`。后续准备 PR 时应审查并集成这项上游变化，不能把本分支描述为已包含最新上游功能。

## 目录与提交范围

本次保留已有源码、测试路径与历史证据，收拢 README、增加[文档导航](README.md)和[测试入口](../tests/README.md)，修正技术方案与 S1/S2 页首的过期状态，并补充本机配置和 Python 缓存的忽略规则。不更改生产逻辑、网络参数、测试门槛或永久用例数量。

| 内容 | 处理 |
| --- | --- |
| `src/`、`server/` | 提交实现；共用规则、协议、客户端和服务器继续按职责分层 |
| `tests/`、`scripts/` | 提交用例、固定样本、驱动和诊断工具；历史对照工具保留并说明依赖 |
| `docs/`、`AGENTS.md`、README | 提交设计、规范、结果摘要与导航；历史失败保留 |
| `packaging/`、两份锁文件、构建与检查配置 | 提交可复现构建和独立运行所需文件 |
| `offline/` 三个已有 HTML | 原样保留，不替换为本次开发构建 |
| `node_modules/`、`dist/`、`artifacts/`、工具链与原始参考文件 | 本地保留，忽略提交；不用删除证据换取“干净”状态 |
| 本机 `.npmrc`、`.env`、凭据/代理配置及 Python 缓存 | 忽略提交；允许未来显式提交无秘密的 `.env.example` / `.env.sample` |

首次盘点有 259 个候选文件，约 6 MB；超过 1 MiB 的只有三个已有离线 HTML，没有发现新增大体积交付包。新增的导航和本说明计入后续清单。GitHub token、AWS access key ID 和私钥头的定向格式扫描未命中；这是有限检查，不代表对任意敏感数据的完整保证。

整理前后的文件清单、源码哈希、忽略规则核对、文档链接与检查输出保存在本地 `artifacts/github-readiness/20261116/`。由于 `artifacts/` 被忽略，上传源码后历史原始证据不会自动可访问；应按[文档导航的证据说明](README.md#原始证据在哪里)另行交付需要的归档。

后续换机检查发现并修复了 Windows Git 的 CRLF 检出与 LF 格式检查冲突；具体环境准备和 O4 决策摘要见[续接指南](development-continuation.md)。按用户 2026-11-16 的决定，旧 O4 冻结源码与回退包不再要求迁移，不作为日常开发的前置依赖；历史原始记录仍只是本机材料，未来发布另按当次要求准备。

## 上传与未来 PR 的边界

- 此前 S1—S5 等工作尚未形成阶段提交。本轮按“运行实现、测试与工具”和“产品技术设计、规范与验证文档”两组整理：代码、测试及构建运行依赖一起提交，再提交设计与结果文档；不根据最终源码虚构曾独立验收的 S1—S5 提交历史。推送前核对完整差异和提交清单，保留现有共同历史。
- 个人 Fork 可保存完整开发工作。未来上游 PR 应围绕原维护者接受的范围整理；联网实现相对原离线项目跨度较大，适合先明确范围，再按依赖分成可独立审阅、可验证的变更。
- `AGENTS.md` 与开发约定含当前用户的 Windows 沙箱、GitHub 账号和作者约定。保留本地已确认规范；向上游提 PR 前单独审查其适用性，不把个人身份约定直接当成所有贡献者的要求。
- 保留原作者、参考归属和依赖许可。当前根目录未见项目许可文件，API 也未识别项目许可；不自行替原作者添加或更换授权。
- 上传前运行 `npm test`、`npm run check`、`npm run build` 并记录结果；浏览器和网络按实际改动选择，不为目录整理重跑已经冻结的弱网窗口。

## 本轮验证

本轮使用 Node.js 24.18.0、npm 11.18.0，重新执行 `npm test`（199 通过，0 失败、0 跳过）、`npm run check`（102 个格式/静态规则文件、100 个运行模块）和 `npm run build`，均通过。未新增永久用例，也未重跑浏览器或弱网实验。

文档核对覆盖全部候选 Markdown 的相对文件与标题链接，区分本地 `artifacts/` 证据路径；核对源码包/运行包命令、文档索引完整性与忽略规则。112 个生产构建输入与整理前已有清单逐项哈希一致。本轮临时命令核对最初误将包内 `verify` 当作源码命令，已核对两份包清单并修正检查范围，首轮报告一并保留。

目标服务器、真实双设备、网络体验和正式干净来源构建仍待验；O4 相对弱网未通过项保持。已有本地包和启停/回退验证不能代替这些条件，源码推送也不表示可以发布或已部署。
