# 独立运行包

本目录包含在线页面、服务端、离线单文件、必要许可、运行依赖清单与锁文件。需要 Node.js 24.x、npm 11.x；不需要开发仓库或全局安装的模块。

在解包后的目录执行：

```sh
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
npm run verify
npm start
```

安装需要可用的 npm registry 或已有缓存。`npm ci` 按锁文件安装，清单不匹配时失败；`--ignore-scripts` 禁止安装时执行依赖脚本，显式的 `npm start` 仍可运行。依据：[npm ci 文档](https://docs.npmjs.com/cli/v11/commands/npm-ci/)。运行时仅外置 `ws`，Three.js 和 fflate 已随构建打包，许可在 `licenses/`。

默认打开 `http://127.0.0.1:4173/`。一个进程提供页面和 `/ws`，`/health` 只证明基础服务状态。前台按 Ctrl+C 停止，停止或重启会结束全部内存对局，不保留席位。

可通过环境变量设置 `HOST`、`PORT`、`SNAPSHOT_HZ`、`MAX_ROOMS`、`MAX_CONNECTIONS`。默认值与有限队列配置写在 `release.json` 的 `configuration.defaults` 中；同步频率仅支持 60 或 30。清单记录构建时的默认配置，实际运行的覆盖值须另记。开发默认容量不代表目标服务器容量，当前目标范围为一房 10 真人，或最多两房合计 10 真人以内，真实设备与目标服务器仍待验。

离线玩法直接打开 `offline/harbor-after-rain.html`，无需 Node.js、网络或服务器。在线与离线来自同一次构建；旧页面遇到版本不匹配需刷新。

`release.json` 记录产品、源码、构建、协议、规则、工具链、依赖与文件校验信息，不包含自身校验值。交付 ZIP 旁的 `SHA256SUMS` 另记 ZIP 和该清单的校验值；解包前应从可信交付记录核对它们。`npm run verify` 可检查目录完整性，也能在安装依赖前使用 `node verify.mjs`。

`build.kind=local` 是本地验证包，来源可能有未提交内容，不能作为正式发布来源。正式来源包要求干净 Git 工作区，但仍需完整体验、目标机、启停与回退验收，以及明确发布授权。本次工具不安装系统服务、不改防火墙、不连接目标服务器，也不部署。目标机的进程管理、自启动、日志轮转和回退命令仍须按实际环境验证。

## 本地启停、重启与回退

本地前台运行可直接使用 `node server/main.js`，与 `npm start` 的实际入口一致。前台 Ctrl+C 请求停止；Linux/WSL 中也可向此次启动的确切 Node PID 发送 `SIGTERM`。当前入口收到停止请求后输出 `Stopping`，释放房间、WebSocket、HTTP 和定时任务后输出 `Stopped`，正常退出码为 0；现有退出兜底为 5 秒。强杀不算优雅退出。Windows 的子进程 `kill` 不等价于真实 POSIX 信号，依据见 [Node.js 信号说明](https://nodejs.org/docs/latest-v24.x/api/process.html#signal-events)。

重启前确认旧进程已退出且端口已释放，再从同一完整目录执行校验和启动。重启结束旧内存对局，重新进入后回到空房间列表，不恢复原席位或比赛。

切换版本时，各版本保持独立目录、锁定依赖和配套环境配置。先准备、安装并校验候选版本；失败时保留旧服务。准备成功后停止旧服务、确认释放端口，再启动候选版本。需要回退时按相同顺序恢复旧完整目录及旧配置，不能只换页面、服务端文件或沿用未核对的新配置。`/health` 的构建、协议、规则和产品信息须与该目录清单匹配；较旧版本缺产品字段时，产品版本以其归档清单为准。缓存的异版页面必须被版本检查拒绝。

首次联网发布没有上一正式联网版本时，还须演练停止联网进程并恢复归档的原静态入口。静态回退只提供离线机器人玩法，不保留联机房间，也不应提供 `/ws`。本地仓库工具可用 `scripts/serve.mjs --file=归档HTML路径` 重现该入口；它不是生产托管或自动回退工具。

本地独立端口演练复用仓库中的 `scripts/s2-launch-check.mjs --lifecycle`；要求显式提供候选 ZIP、旧 ZIP 和归档静态 HTML，需在 Linux/WSL 中运行以验证真实信号。测试脚本属于研发工具，未装入运行包。目标服务器的服务管理器、自启动和长期日志轮转仍须另行验证；本地成功不代表已部署。
