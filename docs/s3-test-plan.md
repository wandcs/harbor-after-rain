# S3 弱网与同步实验方案

日期：2026-11-14。状态：实现及本轮自动化完成，设备与体验验收待补；实际配置、首轮失败和参数结论见[执行记录](s3-test-results.md)。依据：[阶段计划](online-implementation-plan.md#5-s3弱网与同步验证)、[技术方案](online-technical-design.md#10-两档同步配置与通信边界)和[测试约定](development-guide.md#8-测试验收与证据)。

用户在 S1/S2 自动化通过后明确要求继续 S3。沿用实机暂缓决定，先执行 S3 自动化；S2 双设备、S3 主观手感及设备体验仍待验，不能由同机结果替代。本轮不进入 S4、不发布、不改变 60 Hz 模拟及 60/30 Hz 两档合同。

## 最小实验集合

复用现有 189 条逻辑用例及 S2 浏览器交火；不新增一套武器或暂停用例。新增两个可独立选择的实验入口，各参数运行分别计数，不计入 189 项永久逻辑测试。

| 编号 | 责任、必要性与方法 | 独立预期 |
| --- | --- | --- |
| S3-E1 编码 | 协议实验。现有 JSON 单测没有完整实际消息的编码成本对照；从实际房间采集公共+本人配对快照、元数据、输入和事件，比较 JSON 与简单自包含二进制 | 字段完整逐值往返相等；数字使用 float64，不量化，因此坐标、头部、楼梯、高台及掩体精度误差为零。计入字典/头部和所有消息，不以部分公共状态冒充完整出网。分别记录字节、编码/解码耗时，不把同实现相等当作游戏规则正确 |
| S3-E2 传输 | 服务器/客户端集成。现有出口替身不覆盖 TCP 重传。实际应用、WebSocket、OnlineSession、Prediction 和显示采样在隔离 Linux 网络中运行 | 输入确认不倒退；生命/阶段有效；射击与输入编号关联；预测、输入、历史与发送队列有界；中断停止沿用、恢复不集中补步；受损连接不阻止健康连接推进；记录限制，不预设所有弱网都可玩 |

E2 每档先跑 RTT 0/50/100/150 ms 四点，再跑 100 ms RTT 加双向 ±15 ms 抖动、100 ms RTT 加双向 1% 独立丢包，共 **12 个配置运行**。各运行预热 2 秒、采样 8 秒，固定种子 4207。另做输入/网络中断和单慢连接轨迹，两档分别运行，共 **4 个故障配置运行**。总计 16 个传输配置，避免无目的笛卡尔积；真实丢包样本中须观察到内核丢包和 TCP 重传，否则标记证据不足。

首轮限速的 `ws.bufferedAmount` 始终为 0，仅触发存活超时，无法证明真实发送积压路径。为这个明确缺口追加 `backlog` 负载：在实际房间中准备六名机器人的合法死亡状态，产生包含完整尸体姿态的较大快照，真实限速下要求实际积压超过阈值、服务端按积压持续时间终止该连接、健康连接继续推进。死亡准备只作为负载夹具，不算真人击杀证据；复活计时和出站算法保持真实执行。

S4 扩展后的工具用 8v8、14 名机器人合法死亡姿态作为 backlog 负载；原 4v4 负载只短暂越过阈值便先触发存活超时。配置数量及生产阈值不变，修订依据与首轮失败见 [S4 记录](s4-test-results.md)。本节六名机器人的数据保留为 S3 历史证据。

后续带宽优化使消息更小，14 尸体流量也可能先被内核发送缓冲吸收而只触发存活超时。backlog 夹具现只把受损服务器 TCP socket 的 SO_SNDBUF 请求为16384 B（Linux 实际32768 B）：普通应用进程将该 socket 描述符复制给短命 Python 子进程设置，保留真实 TCP/Outbox，健康 socket 不变；不修改宿主或命名空间 sysctl、玩法、生产积压/心跳阈值。依据与通过证据见[优化记录](online-bandwidth-test-results.md)。这是背压分支夹具，不是设备网络或真人击杀证明。

起初试图在两档分别强求该分支；30 Hz 的流量更低，在产生应用层积压前先按 6 秒存活规则处置，首轮“必须积压”的断言因此失败。重新审视目标后，选择用 **60 Hz 的一次真实积压 + 共用 Outbox 的确定性边界**证明同一发送算法，30 Hz 继续由实际 slow 场景证明隔离与失效处置。相比调整其他超时以迫使分支触发，这一组合以更少变体验证实际合同。保留该失败记录，移除缺乏独立需求的 30 Hz 积压要求。最终追加 **1 个必要参数变体**，E2 共 **17 个配置**，永久 Node 用例仍不增加。

## 隔离与测量

- Linux `unshare --net` 创建临时命名空间，运行结束自动销毁；只配置该空间的 lo，端口过滤仅影响选定实验连接。不得修改 Windows 或 WSL 现有网卡、全局路由、现有 qdisc。内核工具需要 Linux root，应用与测试本身降为桌面用户对应的普通 Linux 用户运行。
- 使用 Node.js 24.x；WSL 默认 Node 22 不用于本阶段合格结果。可在仓库忽略的工具目录下载官方 Node 24 Linux 运行时，验证官方 SHA-256，不更换系统默认版本。
- 延迟/抖动/丢包作用于真实 TCP 数据包，不丢弃 WebSocket 消息。保存 tc 配置、队列统计和 TCP 重传计数；固定 seed 不代表真实时间调度逐毫秒一致。TCP 分段/合并影响记录为环境限制，注入设定与实际 RTT 分开报告。方法参照 [iproute2 netem 文档](https://github.com/iproute2/iproute2/blob/main/man/man8/tc-netem.8)。
- 连续按住移动/射击和一次换弹使用实际会话帧，服务端仍执行真实机器人；客户端逻辑实验不需要 DOM，不以无渲染性能推断浏览器性能。每次独立服务、连接、状态、时钟和输出；单配置最多 30 秒，完整矩阵有总时限，失败保留证据并清理资源。
- 记录实际负载字节和 TCP socket 字节、RTT、接收间隔、预测校正幅度、输入确认/作废、历史回退原因、模拟步进耗时及调度落后、事件循环延迟、内存与队列峰值。TCP 字节不含 IP/链路头与重传流量；内核统计另列，不将两者相加伪造真实线速。

## 判断与收敛

先验证规则与隔离约束；退出、超时、缺环境均不算通过。不将 p95 校正或接收间隔事后放宽为成功。上述指标用于比较同机条件下相对基线的退化；玩法是否可接受仍需真人移动目标与掩体交火观察，当前不凭空制定体验保证。

编码先作为实验候选，不接入生产协议。仅当完整数据、浏览器可实现性、字节和 CPU 成本具有明确净收益时，再决定是否替换 JSON；否则保留可读基线并明确限制。缓冲、回溯、新鲜度与积压参数仅根据实测调整，保持两档固定，不添加自动降档、差量、压缩或新传输。

首轮实际传输已暴露三个时间边界问题，复用两条现有会话用例补反证：旧包持续到达时权威状态仍需超时，失败通知不等待 TCP 关闭；150 ms RTT 下固定三步提前量不足；显示缓冲应计入单程交付时间。先保留失败，再修复并完整回归。

最终浏览器回归又触发了共用 AI 的第三次卡住后重选路线分支：调用缺少规则随机源导致服务崩溃。复用原无设备 AI 用例设置可复现的卡住状态，验证真实 think/选路链路先失败、修复后通过；未新增永久用例。浏览器检查器也增加异步异常归档与资源清理，并用临时故障探针验证。规则及构建标识改变后，重新运行完整矩阵，不沿用旧构建结果。

重新审视的目标是验证可用的网络机制，而非把既有初值维持不变。修正显示后，150 ms RTT 的实际射击引用年龄为 204–211 ms，原 200 ms 初值全部回退。比较减少缓冲、改变迟到输入消费规则和调整实验窗口，选择保留前两者，将 60 Hz 回溯初值改为 225 ms：150 ms RTT + 33.3 ms 缓冲 + 约 25 ms 目标步等待余量 + 一个 16.7 ms 调度余量。30 Hz 经矩阵观察保留 250 ms；这些仍是待体验确认的实验值。窗口外仍按当前状态判定，不扩大历史存储或容许旧生命引用。

每次保留开工来源清单、构建标识、精确命令、环境、首轮失败和最终结果。先完成本方案及工具，再运行实验，最后更新阶段状态；实机和主观体验未执行时不得宣布 S3 全部验收通过。

## 独立运行与环境准备

### 常规回归补强设计（2026-11-14）

用户要求按规范继续补齐 S3 必要测试。先审查既有 189 条逻辑用例与两个实验入口，决定新增 **2 条永久用例**，其余加强原用例；原真实网络矩阵按实际影响复用，不重复建设。客户端与服务器分别独立运行，新用例不依赖浏览器、WSL 或人工启动服务。

| 功能 / 责任 | 现有证据与缺口 | 决定与独立预期 |
| --- | --- | --- |
| 上行积压及终止后的事件隔离 / 客户端 | slow 实验证明旧状态超时；现有会话单测替换 close，未检查真实 connect 事件处理、65536 字节上行边界和清理链路 | 新增 `S3-C1 upstream backlog ends once and isolates delayed transport events`。只替换传输和页面地址；实际连接处理、编解码、发送、失败和关闭逻辑运行。65536 可发送，65537 拒绝；立即通知一次退出，清理自己的时钟/缓冲，迟到 error/close/message 不继续通知或应用状态 |
| 追赶、突发输入与过期作废 / 服务器 | 队列单测与核心连射已有直接证据；没有将实际 app.pulse 调度器与成批输入及时间跳跃组合验证 | 新增 `S3-S1 application catchup stays bounded and expires queued fire`。自建真实服务和协议连接，关闭自动定时器、注入单调时间。一次 1 秒跳跃最多追赶 3 步，保留积压有界；相同时间反复 pulse 后不继续推进。再前进 20 ms 时累计 7 步、M4 在 1/7 步各一发；250 ms 外的排队输入作废确认，不补射 |
| 预测等待与新鲜度 / 客户端 | 已有 busy-render 与权威年龄 6000/6001 ms 检查；接收间隔与权威年龄未分别隔离，未来窗口缺精确两侧边界 | 加强原第一条会话用例；每种独立夹具检查 5999/6000/6001 ms，补充目标步等于 30 与超过 30、恢复后的连续序号，等待期间不占用输入编号 |
| 时钟、目标步与显示引用 / 客户端 | 四档 RTT 目标步有检查，但直接赋值 RTT/offset；真实 clock 响应计算及非零时钟偏移未覆盖，显示缓冲只测默认档 | 加强原第二条会话用例；实际 clock/receive 得到 RTT=150 ms、offset=4825 ms，未知/重复应答不变；目标步、显示引用和两档缓冲以独立时间预期验证 |
| 同步预设 / 服务器 | 历史窗口边界用 config 推导预期，无法单独发现默认值意外退回 200 ms | 加强原 config 用例，明确断言 60/30 Hz 对应 33.3/66.7 ms 缓冲、225/250 ms 回溯。新增一个频率变体，不新增用例 |
| 编码、回溯、AI、真实丢包与积压 / 对应责任层 | 已有协议、历史边界、真实 AI 恢复及 E1/E2 证据 | 复用，不新增另一套编码或枪战测试 |

参数增量单列：超时由原权威年龄两点扩为两个独立时间来源各三点，共 6 个变体；显示由默认档扩为两档，配置由仅 30 Hz 扩为两档；新增未来窗口边界轨迹和一次非零时钟响应轨迹。它们不另算独立通过项。新增 C1、S1 分别属于不同的客户端/服务器责任，现有长生命周期用例无法合理承载，单独保留以便定位。

本轮证据写入 `artifacts/s3-test-review/20261114/`，先保存基线和首轮失败，再执行独立单条、责任层和全量回归。新增案例支持 `node scripts/run-tests.mjs --case=S3-C1` 和 `--case=S3-S1`；名称/编号未匹配仍须失败。实际结果另记，设计本身不表示通过。

### 环境准备与命令

Windows 开发环境使用 Node.js 24.x、npm 11.x，`npm ci` 后先 `npm run build`。E1 不需要 WSL。E2 当前统一入口面向本仓库的 Windows + WSL Ubuntu-26.04，要求已有 `ip`、`tc`、`unshare`、`python3` 和普通用户；实验不会代为安装系统工具。

在仓库根目录执行以下一次性准备，运行时只写入忽略的 `artifacts/toolchains`，不替换系统 Node。下载和校验来源为 [Node.js 官方 24.18.0](https://nodejs.org/dist/v24.18.0/SHASUMS256.txt)：

```powershell
wsl.exe -d Ubuntu-26.04 -- sh -lc 'set -eu; cd /mnt/c/repos/harbor-after-rain; mkdir -p artifacts/toolchains; cd artifacts/toolchains; curl --fail --location --max-time 60 -o node-v24.18.0-linux-x64.tar.xz https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz; printf "%s  %s\n" 55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742 node-v24.18.0-linux-x64.tar.xz | sha256sum -c -; tar -xJf node-v24.18.0-linux-x64.tar.xz node-v24.18.0-linux-x64/bin/node node-v24.18.0-linux-x64/LICENSE'
```

按仓库身份约定，WSL 命令与真实本地网络实验使用桌面用户在沙箱外执行；无需 Windows 管理员。使用新的输出目录，已有结果不覆盖：

```powershell
node scripts/s3/run.mjs --case=S3-E1 --out=artifacts/online-s3/encoding-new-run
node scripts/s3/run.mjs --case=S3-E2 --hz=60 --profile=rtt150 --out=artifacts/online-s3/latency-new-run
node scripts/s3/run.mjs --case=S3-E2 --hz=30 --profile=loss --out=artifacts/online-s3/loss-new-run
node scripts/s3/run.mjs --case=S3-E2 --hz=60 --profile=interruption --out=artifacts/online-s3/outage-new-run
node scripts/s3/run.mjs --case=S3-E2 --hz=30 --profile=slow --out=artifacts/online-s3/slow-new-run
npm run test:s3
```

profile 可选 `rtt0/rtt50/rtt100/rtt150/jitter/loss/interruption/slow`，另有仅 60 Hz 的 `backlog`；不指定 hz/profile 就执行这 17 个配置。显式选择不支持的组合会失败，不算通过或跳过。用户名默认当前桌面用户名，可用 `--user=Linux普通用户名` 指定已有账户。E2 明确校验应用 UID 非零及当前网络命名空间不同于系统初始命名空间；在宿主网络中直接运行 `netem.py` 会拒绝。

2026-11-15增补测量：所有E2配置需要同包iproute2中的`ss`记录有限TCP观测，仍只在临时命名空间运行；不需要抓包权限或tcpdump。新增可选`--topology=ingress --seed=4207`，使用接收侧IFB、MTU1500并关闭GRO/GSO/TSO，额外需要内核IFB及已有ethtool。默认`loopback`、种子4207，原矩阵数量与通过线不变；两种拓扑的性能数据分开报告。每次完整提交留下原始观测及observations.json，测量定义、独立手算校核和实际局限见[前两步测试设计](online-weak-network-test-plan.md)与[结果](online-weak-network-test-results.md)。例如：

```powershell
node scripts/s3/run.mjs --case=S3-E2 --hz=60 --profile=loss --topology=ingress --seed=4207 --user=wandc --out=artifacts/online-s3/ingress-new-run
```

Linux底层入口对应`--topology ingress --seed 4207`；与原命令一样要求新的输出目录，工具不会代为安装依赖或修改宿主网络。

归因观测可在显式`S3-E2/hz/profile/ingress`选择上加`--trace=tcp`（Linux底层为`--trace tcp`），限rtt0/loss/interruption。默认none，无额外包头捕获；tcp模式用Python标准库AF_PACKET，仅保存临时命名空间端口45931的TCP头元数据，检查捕获零丢包与时钟换算。它增加有界观测，不改变原动作、产品协议或通过线；方法、四窗结果和原始记录见[重传与积压归因](online-weak-network-attribution-results.md)。

已具备相同依赖的原生 Linux 可直接在仓库根目录执行底层独立配置（统一调度入口当前仍面向 WSL）：

```sh
sudo unshare --net -- python3 scripts/s3/netem.py --node "$PWD/artifacts/toolchains/node-v24.18.0-linux-x64/bin/node" --user "$USER" --out "$PWD/artifacts/online-s3/linux-new-run" --hz 60 --profile loss
```

真实 TCP 实验与编码小样本只回答各自责任；loopback 的分段/合并、计时及 TCP 发送队列机制与公网不同，不能由本轮吞吐或短样本推定目标服务器容量。编码控制消息为协议样本，房间状态和事件来自实际核心；输入按双连接 60 Hz 采集，逐包成本包含公共与本人状态，CPU 数值是完整单包成本，不冒充线上公共编码复用后的整房间成本。
