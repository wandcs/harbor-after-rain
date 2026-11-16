# 本地启停、重启与回退演练

日期：2026-11-16。按用户要求完成本地演练，依据[发布与运行约定](release-runbook.md#5-部署与启动)及[测试约定](development-guide.md#8-测试验收与证据)。本轮没有部署、推送或安装常驻服务。使用本地验证包，不把结果写成正式来源、目标机或完整发布验收通过。

## 实现与覆盖设计

复用 `scripts/s2-launch-check.mjs`，增加 `--lifecycle` 变体；其归档读取、文件白名单、校验、依赖安装、启动和房间检查抽到共用辅助模块，原启动变体继续使用同一实现。补强原应用生命周期和静态预览用例，永久 Node 用例数仍为 199。事前设计保存在 `artifacts/local-runtime/20261116/plan.json`。

服务端健康响应补齐仅含名称和版本的 `product`，实际入口从所在目录的包清单读取；停止时记录 `Stopping/Stopped`，沿用 5 秒退出兜底。未增加管理接口、进程守护平台或测试专用生产控制通道。静态预览支持 `--file` 指定单 HTML，只开放该入口，并增加相同的有界停止处理。

显式提供当前候选 ZIP、已验旧 ZIP 和原归档静态 HTML。两个包按各自清单和外部校验值核验，分别安装到仓库外目录；旧包按自身记录核验，不要求其源码哈希等于当前工作树。一次演练使用新建 npm 缓存，两个目录各自安装锁定依赖，不借用仓库模块。

本轮旧包为 [ca870488bf30](../artifacts/release-package/20261115/package/harbor-after-rain-v1.4.9-ca870488bf30-local.zip)，候选为 [1df08e957596](../artifacts/local-runtime/20261116/package/harbor-after-rain-v1.4.9-1df08e957596-local.zip)，均为产品 1.4.9、协议 9、本地来源。旧配置使用 60 Hz，候选显式选择既有 30 Hz 档，回退恢复 60 Hz；这只是核对各版本配套配置的演练选择，没有修改生产默认或通过线。实际配置、标识及端口见 `lifecycle-final/version-configurations.json`。

## 最终结果

| 检查 | 实际结果 |
| --- | --- |
| 旧包启动、同版本重启、候选切换、旧包回退 | 四次在线启动均通过健康/清单标识和配置核对，初始大厅为空；真实输入获配对确认，移动和开火生效，随后暂停对局 |
| 重启内存边界 | 原暂停对局和角色战绩不恢复；新建对局的射击计数从 0 开始，操作后为 1 |
| 候选准备失败 | 临时副本损坏被校验器拒绝，原服务健康标识不变，原 WebSocket 时钟请求仍可应答 |
| 非法配置 | 45 Hz 被明确拒绝、进程非零退出，原服务连接继续可用 |
| 版本边界 | 切换后旧构建客户端、回退后新构建客户端均收到 1008 / `VERSION_MISMATCH` |
| 停止与端口 | 五次真实 `SIGTERM/SIGINT` 停止均退出码 0、信号退出标记为空，均低于现有 5 秒限；每次均实际重新绑定同一端口，确认已释放 |
| 原静态入口 | 停止联网进程后，同端口提供归档 v1.4.9 HTML；字节与归档一致，`/health`、`/ws` 返回 404，WebSocket 握手不可用；随后静态进程正常停止 |
| 归档与清理 | 两个输入 ZIP 哈希不变；全部测试进程退出，临时目录删除，没有触发强杀兜底 |

最终同一临时端口为 45317。在线服务沿用既有关闭策略终止 WebSocket，客户端关闭码为 1006；进程正常退出和端口释放均取得独立证据。静态回退 HTML 为 1,200,231 字节，SHA-256 为 `69d2382fc63f8b603e3c1a048f857cce54d053d6a5b1383267f73307809a1a6f`。本地预览工具重现了原 HTML 入口，没有操作原公开托管服务，也没有重新声明旧版全部体验验收。

环境：Ubuntu-26.04 / WSL2、普通 UID 1000、Linux `6.18.33.2-microsoft-standard-WSL2`、Node.js 24.18.0、npm 11.16.0。真实信号演练在 Linux 完成。Windows 的 `child.kill` 会强制结束目标进程，不能作为优雅退出证据，依据为 [Node.js 信号说明](https://nodejs.org/docs/latest-v24.x/api/process.html#signal-events)；工具在 Windows 明确拒绝生命周期变体。Windows 独立包启动和静态预览回归另行通过，其清理不计入上述五次优雅停止。

## 回归与失败记录

- 原累计 199 项通过，0 失败、0 跳过；补强后的原应用生命周期用例也独立通过。
- 工程检查为 102 个格式/静态规则文件、100 个运行模块，通过；全量构建和候选 ZIP 生成通过。
- Windows 原独立包启动检查通过，包括损坏/缺失文件拒绝、健康产品版本、握手、建房退出和清理；原默认静态预览的内容与路径限制通过。
- 离线 HTML 与上一已验产物逐字节相同；在线页面替换构建标识后逐字节相同，规则标识未变，按 `client-equivalence.json` 复用对应浏览器与玩法证据。本轮没有扩大浏览器或弱网矩阵。

首轮失败均保留，没有用最终通过覆盖历史：

| 记录 | 原因与处理 |
| --- | --- |
| `health-red` | 测试补丁命中相同的准备代码，预期变量作用域错误；纠正补丁位置 |
| `health-red-corrected` | 真实复现健康产品版本缺失；补齐两个公开字段后，`health-green` 独立通过 |
| `lifecycle-first` | 新增实际输入步骤沿用 JSON 控制消息发送，被既有协议以 `BINARY_REQUIRED` 拒绝；驱动改为调用共用 `encodeMessage`，服务器校验保持 |
| `lifecycle-corrected` | 45 Hz 已被正确拒绝，夹具预期了另一个配置分支的错误文案；按已有档位合同修正文案断言，保留非零退出及原服务继续的检查 |
| `lifecycle-final` | 固定范围全流程通过；未修改退出限、版本边界、输入执行或恢复条件 |

生命周期共运行三轮：两轮夹具失败、一轮最终通过。它们和独立选择、Windows 变体均不叠加进 199 项逻辑通过数。失败轮也完成了进程和临时目录清理。每个进程的 stdout/stderr 在工具中各限制为 64 KiB，分阶段日志随证据保留；目标机的长期日志采集与轮转尚未验收。

## 复现与剩余事项

需要 Node.js 24/npm 11，以及显式选定的两个完整 ZIP 和旁边的 `release.json`、`SHA256SUMS`。候选源码输入须与当前工作树匹配；每次使用新输出目录。本轮 Windows 发起 WSL 的实际入口如下，输出目录示例改为新路径以免覆盖记录：

```powershell
wsl.exe -d Ubuntu-26.04 -- sh -lc 'set -eu; cd /mnt/c/repos/harbor-after-rain; ./artifacts/toolchains/node-v24.18.0-linux-x64/bin/node scripts/s2-launch-check.mjs --lifecycle --package=artifacts/local-runtime/20261116/package/harbor-after-rain-v1.4.9-1df08e957596-local.zip --rollback-package=artifacts/release-package/20261115/package/harbor-after-rain-v1.4.9-ca870488bf30-local.zip --static-file=offline/harbor-after-rain-v1.4.9.html --out=artifacts/local-runtime/new-run'
```

构建新的候选时先使用 `node scripts/package-release.mjs --out=新交付目录`，再把其 ZIP 路径传给同一演练入口。手工前台启停和版本准备顺序见[运行说明](../packaging/RUNNING.md#本地启停重启与回退)；实际服务管理器必须管理真实 Node 进程，本轮未安装管理器、自启动、定时任务或后台常驻服务。

本地范围已完成。正式干净来源包、目标服务器容量及 IP 路径、真实设备、目标机上的运行/回退与长期日志轮转仍待；O4 未通过项保留，生产网络参数和通过线不变，未进入完整发布验收。新候选仍标为本地验证包，没有提交、推送或部署。

后续已完成[干净提交的正式来源包正向验证](release-package-results.md#2026-11-16干净提交的正式来源包正向验证)，上段“正式干净来源包仍待”是本轮结束时的历史状态。新包的 Windows/WSL 独立安装启动和清理通过，未重复本页旧包回退矩阵；目标机、设备、日志与 O4 等待验项保持。

证据：[目录](../artifacts/local-runtime/20261116/)、[归档](../artifacts/local-runtime-evidence-20261116.zip)及同名 `.sha256`。包含事前设计、所有失败与最终运行、版本/配置、输出日志、前后源码和产物、两个完整包与原静态输入副本及校验值。
