# S3 必要测试补强记录

日期：2026-11-14。依据：[开发约定](development-guide.md#8-测试验收与证据)及[补强设计](s3-test-plan.md#常规回归补强设计2026-11-14)。本轮补齐常规回归缺口，新增 **2 条永久用例**、加强 **3 条现有用例**；累计 **191 项通过，0 失败、0 跳过**。S3 实机与主观网络体验继续暂缓，未进入 S4。

## 覆盖与数量

| 处理 | 责任与直接证据 | 新增的覆盖 |
| --- | --- | --- |
| 新增 S3-C1 | 客户端；实际 OnlineSession 事件、编解码、发送与终止链路，传输使用 EventTarget 替身 | 上行积压 65536 字节仍可发送、65537 拒绝；立即通知一次退出；清理自己的计时器、时钟请求与快照；迟到 error/close/message 不再改变终止状态 |
| 新增 S3-S1 | 服务器；自建真实 HTTP/WebSocket 服务，实际 app.pulse、输入队列和 M4 核心，注入单调时间 | 突发输入后跳跃 1 秒，单次最多追赶 3 步、剩余积压有界；相同时间不能无限推进；累计第 1/7 步各开一发，250 ms 外的排队/沿用输入作废确认，不集中补射；退出释放房间与服务 |
| 加强原 busy-render 用例 | 客户端 | 分别隔离接收间隔与权威状态年龄，各查 5999/6000/6001 ms；目标步 30 可用、31 等待且不占输入编号，收到新状态后连续恢复 |
| 加强原 display-citations 用例 | 客户端 | 实际 clock/receive 得到 RTT 150 ms、非零 offset 4825 ms；未知及重复应答不变；目标步独立期望；两档实际缓冲采样 alpha 分别为 2/3、1/3 |
| 加强原 config/input-queue 用例 | 服务器 | 独立数值期望固定 60/30 Hz、33.3/66.7 ms 显示缓冲和 225/250 ms 回溯，避免用配置本身推导预期掩盖退回旧值 |

新增依据与原证据的不足已在方案中先行记录。两个新用例分属客户端和服务器、各有主要目标；其余边界复用原用例，没有再建编码、历史或枪战套件。参数变体另列于方案，不充作新增独立通过项。

## 发现与反证

S3-C1 首轮失败：会话因上行积压结束后，迟到的 socket error 仍触发“连接失败”提示。修改 [session.js](../src/net/session.js) 的 error 回调，使终止后的事件不再通知。该回归先失败、修复后通过；这是本轮唯一运行时代码改动。

S3-S1 原实现通过。为确认其能发现关键退化，临时移除 app.pulse 的积压保留上限；用例在“丢弃过多积压而非重放整秒”的断言失败，退出码为 1。探针以 finally 按字节恢复源码，恢复后的独立用例及累计回归通过。探针只保留证据，不新增永久用例。

## 实际检查

| 本轮执行 | 结果 | 证据目录或日志 |
| --- | --- | --- |
| 开工基线 | 189 项通过 | `baseline`、`baseline.log` |
| S3-C1 / S3-S1 独立选择 | 各 1 项通过；其他文件占位结果不计数 | `C1-final`、`S1-final` |
| 客户端 / 服务器组 | 13 / 14 项通过 | `client-first`、`server-final` |
| 累计回归 | 191 项通过，0 失败、0 跳过 | `all-final`、`all-final.log` |
| 工程检查 | 77 个格式/静态规则文件、92 个运行模块通过 | `check.log` |
| 完整构建 | 在线、离线、服务端、许可和发布清单成功 | `build.log`、`final-dist` |
| 当前构建真实 TCP slow 回归 | 60 Hz 通过，失效连接处置及健康连接隔离；最终连接 0、房间释放、监听关闭 | `network-current/S3-E2-60-slow` |
| 当前构建浏览器 S2-I2 | 暂停/恢复会话链路通过 | `browser-current` |
| 缺陷及故障反证 | C1 原缺陷失败；服务器取消追赶上限失败；均已恢复并复验 | `C1-first`、`S1-counterexample` 及同名日志 |

本轮没有重复执行前轮 E1 两档与 E2 全部 17 个配置，也没有将它们计为当前构建的新通过项。原始结果见[前轮记录](s3-test-results.md)：共用规则、配置、编解码、服务端传输和实验工具均未改动，继续作为这些责任的已有证据；本轮对客户端终止事件的改动由新回归、实际 slow 及浏览器会话检查覆盖。实机手感、容量与长期稳定性仍未取得新证据。

## 独立运行与归档

Node.js 24.18.0、npm 11.18.0。逻辑测试无需人工启动服务、浏览器或 WSL；服务器用例自行分配端口并在 finally 清理。Windows 本地网络测试遵循仓库约定，使用桌面用户在沙箱外运行。

```sh
node scripts/run-tests.mjs --layer=client --case=S3-C1
node scripts/run-tests.mjs --layer=server --case=S3-S1
npm run test:client
npm run test:server
npm test
npm run check
npm run build
```

统一入口已支持 S3 稳定编号；未匹配的显式选择仍会失败。支持 `--out=新目录` 保存单次证据。真实网络及浏览器复验命令分别为：

```sh
node scripts/s3/run.mjs --case=S3-E2 --hz=60 --profile=slow --out=artifacts/s3-test-review/new-network
node scripts/s2-browser-check.mjs --case=S2-I2 --out=artifacts/s3-test-review/new-browser
```

网络实验的 WSL、普通 Linux 用户和工具准备见[环境说明](s3-test-plan.md#环境准备与命令)。临时网络命名空间内注入，应用使用普通用户；不更改宿主网络。浏览器自动创建和关闭自己的服务，支持 CHROME_PATH。

构建标识：`9e8d4a3d339f74ab0df1943ff88c1ccd2c19bc6bd9171e83b3c68e33a1b73707`。规则标识保持 `71a9624e025b19459567091bc99a4f37a818fcbacda29befbffc825296684450`，生产协议仍为版本 1 / JSON。

证据：[本轮目录](../artifacts/s3-test-review/20261114/)、[归档 ZIP](../artifacts/s3-test-review-20261114.zip)及同名 `.sha256`。包含开工来源快照、最终源码与差异、构建、结构化结果和反证日志。前轮归档保持不变；工作区尚未提交、推送或部署。
