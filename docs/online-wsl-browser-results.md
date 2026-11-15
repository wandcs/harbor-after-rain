# Windows浏览器连接WSL服务的对照结果

日期：2026-11-15。按用户确认，将既有S2-I1 C档的服务与测试驱动放到WSL，Chrome继续运行在Windows，仅新增在线/离线两窗。**本轮健康页最大间隔40/136.5ms，均通过原150ms线；离线时原生收齐到JS入口仍最多等待约489ms，交付积压现象没有消失。** 不能据此宣布内核已解决问题或O4通过。

## 1. 范围与实际运行位置

前面的[O4四窗](online-o4-corrected-pair-results.md)中，服务器和Node/ws协议客户端已经都运行在WSL/Linux，Windows只负责启动。此前[浏览器最小对照](online-fixture-cdp-control-results.md)的服务和驱动才在Windows。用户本次明确选择“Windows浏览器连接WSL服务”，本轮没有重跑60Hz真实丢包或短断网。

[事前登记](../artifacts/online-weak-network/20261115/wsl-browser-kernel/registration.json)只含两窗：S2-I1 C档在线对照、同档CDP离线处理，各一次，顺序固定。仍是30Hz同步、30FPS上限、种子4207、两次真实交火、约900ms片段、原输入/恢复断言和健康端150ms线；没有新增永久用例编号、扩展档位或追加重跑。

| 组件 | 实际环境与证据 |
| --- | --- |
| 服务与测试驱动 | WSL Ubuntu-26.04，Linux6.18.33.2，Node24.18.0，UID1000；两窗Linux PID638/675 |
| 浏览器 | 原生Windows Chrome157.0.8103.78，1280×720低画质，AMD RX9070XT/D3D11硬件后端 |
| 构建 | protocol9/build cb7ca0d4/rules61500b73，运行源码、参数和产物保持 |
| 测试控制 | 同一锁定Playwright1.63.0，Windows使用launchServer，WSL使用connect；默认路径仍本地launch |
| 游戏链路 | Chrome直接请求WSL回环服务，经已启用的mirrored网络；无新增TCP代理、exposeNetwork、端口代理或防火墙修改 |

测试入口只新增默认关闭的 `--browser-server=本次拥有的浏览器就绪文件`，限制为显式S2-I1 C档诊断模式，端点必须为本机回环且Playwright版本匹配。测试准备和服务器断言继续调用原app/room/match，游戏使用原输入、协议和权威逻辑。Windows启动参数归一化临时目录/日志路径后，与原两窗完全相同，没有增加Chrome性能或后台调度开关。[Playwright官方连接接口](https://playwright.dev/docs/api/class-browsertype#browser-type-connect)

每窗在准备页面前记录Linux内核、进程、UID与ss监听；Windows侧另访问该服务的health并核对身份。在线服务监听127.0.0.1:45511，离线服务监听127.0.0.1:44645，均由对应Linux PID持有。不是只在Windows中执行了一条WSL启动命令而未核实服务位置。

## 2. 结果与旧Windows服务对照

旧Windows两窗复用原始记录，本轮新增的只有两条WSL记录。单位ms；最大状态间隔按原断言范围，发布间隔按整个故障检查范围，原生到JS等待按约900ms片段内的健康快照：

| 服务/驱动宿主 | 片段 | 健康页最大状态间隔 | 服务器最大发布间隔 | 原生收齐→JS最大等待 | 原150ms线 |
| --- | --- | ---: | ---: | ---: | --- |
| Windows，既有 | 在线 | 51.40 | 48.89 | 5.80 | 通过 |
| Windows，既有 | CDP离线 | 193.50 | 48.01 | 512.50 | **失败，保留** |
| WSL，本轮 | 在线 | 40.00 | 36.85 | 6.40 | 通过 |
| WSL，本轮 | CDP离线 | 136.50 | 36.95 | 488.60 | 通过 |

本轮两窗都完成原两次交火、权威移动/伤害与计分、换弹、预测反馈及恢复片段检查，没有页面错误。离线窗真实新输入发送40.39ms、实际执行88.79ms、配对确认89.79ms，27条迟到输入作废，旧射击没有补执行；在线窗显式无故障，不计作断网恢复。

离线窗最大健康间隔对应连续快照983→984：服务器发送间隔32.65ms、Chrome原生收齐间隔33ms、JS入口与完整应用间隔136.5ms。对应原生收齐→入口等待从约196.60增至300.10ms，两条处理耗时0.10/0.20ms。离线片段的健康快照原生最大接收间隔37ms，但只应用12份；在线片段应用27份。其形态与Windows服务时的“原生持续接收、JS交付落后”一致。

WSL离线片段健康页解码/快照处理最大均0.20ms，单次渲染最大3.60ms，无观测到的长任务；页面API均保持visible/focused。实际渲染节奏本轮约30FPS，原在线Windows记录约26FPS，虽然上限相同，实际运行负载与调度也不能视为完全相同。

继续使用NetLog帧长累计到socket读取覆盖帧尾的完整性校验，未以帧头替代完整接收；健康端在线/离线分别290/288条JS消息唯一匹配。健康页时钟映射不确定度约0.42—0.49ms，前后漂移约+0.005/−0.086ms，NetLog分辨率1ms。

完整数据见[comparison.json](../artifacts/online-weak-network/20261115/wsl-browser-kernel/comparison.json)，逐快照与阶段结果见同目录browser-online-analysis.json、browser-offline-analysis.json和各report.json。

## 3. 解释与边界

本轮服务发布和健康页最大间隔更平稳，原150ms线如实判通过。但Linux服务下仍有CDP离线时约0.5秒的原生到JS交付落后，**现有证据不支持把积压归因于Windows版服务进程独有行为**；没有依据继续仅针对服务端解码或TCP参数修复这个浏览器现象。

这不是内核单变量因果实验：服务与驱动一起从Windows迁到WSL，跨系统网络/控制路径和同机调度负载也发生变化；两环境各只有一对窗口，片段实际长度也不同。不能把193.5→136.5ms的降幅全部归给Linux内核，不能据一次过线断言长期稳定改善，也不能用新记录覆盖旧失败。

CDP离线继续是浏览器内排队模拟，不是内核真实丢包。原O4的60Hz参考/候选本来就在Linux，短断网p95/p99多出113.52/114.48ms的失败没有被本轮重新验证或关闭。架构、生产逻辑、参数与通过线保持，未进入S6。

## 4. 夹具计时、检查与清理

1000ms预热请求实测999.92/999.98ms，约900ms片段实测899.46/898.69ms，原值保留，未按名义时长重算。原离线分析脚本因要求实际预热≥1000ms中断；改为核对其实际目的：故障前900ms完整窗口必须在两页均已进入running之后。本轮两个窗口的起点分别晚于该running标记367.38/373.40ms，因此没有倒计时污染。只修正本轮离线分析的前置验证方式，保留初始分析日志，不重跑游戏，也没有修改原150ms质量线。

工程检查96个格式/静态规则文件、99个运行模块通过；远程诊断选择的非法参数在创建服务/浏览器前被拒绝。运行源码和逻辑测试143份未变，既有199项回归与未受影响的构建、精度、容量、离线证据按源码/产物哈希复用，没有扩大检查矩阵。

两窗清理后clients=0、roomReleased=true、listening=false；Linux PID638/675均退出，Windows Chrome PID16692/23728均退出码0，宿主TCP参数前后一致。测试服务已经清理，不作为常驻部署保留。审计见[source-audit.json](../artifacts/online-weak-network/20261115/wsl-browser-kernel/source-audit.json)。

本轮执行与分析脚本、就绪/监听证明、NetLog、原始报告、前后测试源码和审计归档在[wsl-browser-kernel-evidence.zip](../artifacts/online-weak-network/20261115/wsl-browser-kernel-evidence.zip)，不包含依赖目录。执行脚本有已启动保护；后续复现须用新输出目录登记，不原地覆盖本轮数据。
