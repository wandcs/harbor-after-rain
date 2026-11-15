# 恢复夹具调整与CDP最小对照结果

日期：2026-11-15。统计读取已移出恢复分支，复验通过。浏览器最小对照中，在线窗健康页最大间隔51.4ms，CDP离线窗193.5ms；异常进一步限定为**与本环境CDP离线条件相关的原生收齐后消息交付延迟**，尚未确定Chrome内部的具体成因。原150ms线和全部历史失败保留，O4没有关闭。

随后按用户选择完成[Windows浏览器连接WSL服务](online-wsl-browser-results.md)两窗：最大健康间隔40/136.5ms，本轮通过原150ms线；离线原生收齐到JS入口仍最多等待约489ms，积压现象未消失。服务/驱动与跨系统链路同时变化，不能把降幅单独归因内核，也不覆盖本页Windows失败或O4失败。

## 1. 范围与改动

按[登记](../artifacts/online-weak-network/20261115/fixture-cdp-control/registration.json)仅执行三个业务窗口，顺序为：现有S3-E2的60Hz短断网候选一次、现有S2-I1 C档在线对照一次、同档离线处理一次。没有增加档位、种子、设备、浏览器开关或通过性重跑，没有新增永久测试编号；累计逻辑测试仍为199项。

生产逻辑、架构、依赖、参数、产物与全部通过线未改。当前仍为protocol9/build cb7ca0d4/rules61500b73；Node24.18.0/npm11.18.0，网络端WSL Ubuntu-26.04/Linux6.18.33.2，浏览器Windows Chrome157.0.8103.78。完整标识、源码哈希、宿主TCP参数和产物检查见[source-audit.json](../artifacts/online-weak-network/20261115/fixture-cdp-control/source-audit.json)。

夹具将qdisc统计改到采样2300—2800ms的断网中段，只读取一次。原故障仍在约2000ms开始，约2900ms恢复；恢复分支只执行原恢复命令、记录时刻和切换标记。若调度错过统计窗口，优先恢复，不在恢复前补读；缺少实际丢包证据仍判验证失败。该快照只证明中段已发生丢包，不再充当整个断网期的最终累计数。

浏览器增加默认关闭的 `--recovery=diagnostic-online`，限制为显式S2-I1 C档。它与既有 `diagnostic-offline` 使用相同两次交火、两页/两个上下文、30Hz同步/30FPS上限、1280×720低画质、稳定运行预热、真实键鼠动作、CDP命令及Default NetLog观测。**唯一故障变量是第一个emulateNetworkConditions调用的offline布尔值**；第二次调用都为false。未改Chrome性能、GPU或后台调度开关。

在线窗显式记录faultInjected=false、无实际离线时长，另断言段内新输入持续送达并执行，不把它计为断网恢复通过。离线窗保留原阻断输入、旧射击停止、新输入真正执行和配对确认等断言；两窗都保留原健康页最大间隔≤150ms线。

## 2. 夹具验证

先对原夹具提取转换分支，用假命令和假时钟复现：恢复目标2901ms时先读统计，模拟5ms耗时后才在2906ms恢复。修改后同一检查在2301ms读统计、2901ms恢复；另核对错过中段采样时不补读、不延迟恢复。该验证没有启动游戏或网络命名空间，记录为fixture-before.json与fixture-after.json。

唯一真实网络窗口保持原loopback、种子4207、2秒预热/8秒采样、900ms全丢目标和无TCP调参，原功能、绝对质量、实际丢包与清理检查通过：

| 观测ms | 实测 |
| --- | ---: |
| 统计读取开始/完成，相对采样起点 | 2304.01 / 2306.52 |
| 统计读取耗时 | 2.51 |
| 统计完成→恢复命令开始 | 596.84 |
| 恢复命令开始/完成，相对采样起点 | 2903.36 / 2906.51 |
| 恢复命令自身耗时 | 3.15 |
| 全丢命令完成→恢复命令完成 | 900.37 |
| 恢复→3个新鲜tick | 744.08 |
| 恢复→新输入实际执行/确认 | 801.71 / 802.81 |

中段netem快照已有21次丢弃，包头采集无丢失，内核RetransSegs增加6、TCPTimeouts增加6。统计读取已远离本轮恢复边界，但TCP退避后的等待仍在。本轮没有参考版配对，不能用它宣称O4相对门槛通过，也不能从单次恢复时长推断固定收益。tc生效仍只界定在命令开始与完成之间。

原始数据见[network/S3-E2-60-interruption](../artifacts/online-weak-network/20261115/fixture-cdp-control/network/S3-E2-60-interruption/report.json)，命令时间和中段统计见同目录kernel.json。

## 3. 浏览器最小对照

两窗均完成原两次交火和真实操作检查，清理后clients=0、roomReleased=true、listening=false，无页面错误。在线对照整体通过，离线处理因健康端193.5ms超150ms线而失败，未追加重跑。下表是健康端在约900ms对照段内的最大值，最大状态间隔另按原断言范围统计，单位ms：

| 观测 | 在线对照 | CDP离线处理 |
| --- | ---: | ---: |
| 对照段实际时长 | 910.96 | 905.73 |
| 原范围内完整状态最大间隔 | **51.40，通过** | **193.50，失败** |
| 段内原生完整快照接收间隔 | 47 | 48 |
| 段内JS入口间隔 | 46.50 | 193.50 |
| 段内原生收齐→JS入口等待 | 5.80 | 512.50 |
| 段内单消息解码工作 | 0.40 | 0.60 |
| 段内单快照处理工作 | 0.20 | 0.30 |
| 段内单次渲染工作 | 6.20 | 6.00 |
| 段内已应用完整快照数 | 27 | 12 |

离线窗最大间隔对应连续快照1076→1077：服务器发送间隔32.43ms、原生收齐间隔32ms、JS入口/应用间隔均193.5ms；两条快照处理各0.2ms。原生收齐→JS入口等待从约95.30增至256.80ms，额外等待161.50ms发生在进入应用之前。离线恢复后，新输入发送30.65ms、实际执行72.67ms、获配对确认97.45ms；24条延迟输入作废，旧射击没有补执行。

两窗的实际启动参数归一化临时日志/用户目录后相同，WebGL均为AMD RX9070XT/D3D11硬件后端，页面API保持visible/focused，观测段无长任务。健康页时钟漂移分别−0.108/−0.039ms，最小映射不确定度约0.19—0.34ms；NetLog分辨率为1ms。继续使用完整帧累计字节覆盖与唯一消息长度序列配对，没有把帧头时刻当作帧体收齐。在线/离线健康连接分别292/290条JS消息完整匹配。

这对样本支持：在同一测试负载与相同CDP调用结构下，开启offline条件才出现显著交付积压；当前证据更指向模拟条件触发的浏览器交付影响，不能将超线直接归为生产解码或正常渲染负载。它不是对所有Chrome调度问题的排除，也没有定位到确切的网络拦截、进程通信或任务队列组件。单对实验不提供普遍统计保证，更不能据此判定实机一定正常。

[Chromium上游的WebSocketInterceptor](https://github.com/chromium/chromium/blob/main/services/network/websocket_interceptor.cc)存在在offline时暂停并回调恢复的帧拦截路径，与“原生收齐后仍可能等待”相容。该源码说明机制可能性，**没有证明本机版本的健康连接命中了同一个拦截器或某个确定缺陷**。本轮仍沿用原CDP API，没有替换协议、模拟器或生产技术。

完整分段、逐快照配对和环境分别见[在线分析](../artifacts/online-weak-network/20261115/fixture-cdp-control/browser-online-analysis.json)、[离线分析](../artifacts/online-weak-network/20261115/fixture-cdp-control/browser-offline-analysis.json)及comparison.json。前轮160.8ms和更早162/186ms失败继续保留。

## 4. 验证、当前结论与复现

既有199项回归通过，无失败/跳过；工程检查96个格式/规则文件、99个运行模块通过。Python语法、夹具前后顺序与迟到路径、诊断入口拒绝非法选择的检查通过。143份运行源码与逻辑测试保持，构建指纹和产物哈希一致，宿主TCP参数前后相同。未重跑未受影响的构建、容量、编码精度、离线与设备检查，未新增发布或Git操作。

夹具修复已取得证据。浏览器归因已从“发送后到应用前”收窄到“与CDP离线条件相关的原生收齐后交付”，暂不因此修改生产逻辑、Chrome参数或150ms门槛。该离线模拟窗本身仍失败；O4相对验收和浏览器质量问题未关闭。到此停止，不自动扩大对照范围或进入S6。

独立复现时OUT须选新目录，浏览器两窗串行运行；它们复用同一用例，不计为新增永久编号：

```powershell
node scripts/s3/run.mjs --case=S3-E2 --hz=60 --profile=interruption --topology=loopback --seed=4207 --trace=tcp-loopback --tcp-tuning=none --user=wandc --out=OUT
node scripts/s2-browser-check.mjs --case=S2-I1 --profile=C --recovery=diagnostic-online --out=OUT
node scripts/s2-browser-check.mjs --case=S2-I1 --profile=C --recovery=diagnostic-offline --out=OUT
```

原始记录、前后源码、回归输出与分析脚本归档在[fixture-cdp-control-evidence.zip](../artifacts/online-weak-network/20261115/fixture-cdp-control-evidence.zip)，不包含依赖目录。分析脚本可直接读取现有结果，不启动业务窗口。
