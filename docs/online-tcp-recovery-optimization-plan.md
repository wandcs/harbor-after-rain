# 重传恢复与ACK等待：优化候选方案

日期：2026-11-15。状态：首轮三个30Hz对照已执行，生产参数保持；结果见[执行记录](online-tcp-recovery-test-results.md)。用户已决定现阶段不做发送窗口；本方案不重新启动该分支。依据[归因记录](online-weak-network-attribution-results.md)、当前代码和下列上游资料。

建议先研究**服务器单连接RTO下限**，把**接收端ACK延迟上限**作为归因对照。两者先在原临时命名空间验证，不能直接写为生产默认。浏览器端的TCP权限、上行也会退避、目标服务器尚未选定，是当前可落地范围的主要边界。

## 1. 要改善什么

短断网在链路恢复后仍约594/617ms等下一次缺口重发；首个完整状态之后，60Hz约16ms排空，30Hz约50ms，其中约43ms等ACK推进。丢包下缺口恢复约100—117ms，随后另有0—45ms发送等待和正常约50ms单程交付。

分别观察：链路恢复到首个新鲜状态、到新输入真正执行、双向缺口补齐与ACK推进、真实状态年龄。只改善下行读数、同时让上行操作仍等退避，不算完整操作恢复。既有60/30Hz、60Hz输入、225/250ms回溯、未来30步、6秒退出和原O4门槛保持；不通过扩大缓冲、放宽超时或补执行旧射击改善数字。

这约43ms来自Linux Node/ws协议客户端的一个真实TCP样本。它不是已确认的浏览器通病，也不是任何客户端固定的ACK延迟。

## 2. 当前已有能力与控制方向

只读检查结果留在[观测记录](../artifacts/online-weak-network/20261115/recovery-research/read-only-observations.json)。WSL为Linux6.18.33.2，SACK=1、RACK配置tcp_recovery=1、TLP配置tcp_early_retrans=3；RTO下限200000us、最大120000ms，拥塞控制cubic。RACK/TLP已经配置启用，不把“打开现代重传”当作新增优化。全丢包时探测也会丢，进入RTO后仍会退避。[Linux6.18参数](https://www.kernel.org/doc/html/v6.18/networking/ip-sysctl.html)、[RACK-TLP](https://www.rfc-editor.org/info/rfc8985/)

本地ws8.23.0在setSocket中已调用setNoDelay；发送帧头和载荷时也在同一调用中cork/uncork。没有证据要求再攒快照、重复设置NODELAY或拆开发送。Node的setNoDelay针对Nagle，不等于设置对端ACK策略。[Node24接口](https://raw.githubusercontent.com/nodejs/node/v24.18.0/doc/api/net.md)

| 想控制的行为 | 实际由谁控制 | 当前产品边界 |
| --- | --- | --- |
| 服务器向浏览器重发状态 | 服务器所在TCP栈 | Linux目标机可以研究发送端参数；当前没有目标机结论 |
| 浏览器确认已收到的状态 | 浏览器所在设备TCP栈 | 页面不能设置TCP_QUICKACK、RTO或延迟ACK上限 |
| 浏览器向服务器重发操作 | 客户端TCP栈 | 服务端参数不能直接重设客户端退避 |
| 服务器确认已收到的操作 | 服务器TCP栈 | 接收端参数可能影响上行ACK；不能据此声称下行ACK已优化 |

浏览器WebSocket不暴露底层socket配置，也没有脚本可调用的协议级ping/pong接口；只能使用现有应用消息，或由服务器发协议ping。[WebSocket标准](https://websockets.spec.whatwg.org/#the-websocket-interface)、[Ping/Pong边界](https://websockets.spec.whatwg.org/#ping-and-pong-frames)

## 3. 常见手段的筛选

| 手段 | 对我们的判断 | 进入条件或不采用原因 |
| --- | --- | --- |
| 保留SACK/RACK/TLP，核对实际部署路径 | 作为运行基线 | 已启用；未来若加TLS终止或代理，应分清每条TCP连接和ACK端点，不能把直连WSL结果直接套过去 |
| 适度降低发送端RTO下限 | 优先小范围实验 | 可能减少部分RTO等待，也可能因退避相位改变而更慢；先单连接、单方向 |
| TCP_DELACK_MAX_US或QUICKACK | ACK归因对照 | Linux接收端可研究；QUICKACK不是永久模式，浏览器页面无法设置。不是现成的浏览器修复 |
| 恢复后用现有消息促使返回数据/携带ACK | 低优先级备选 | 反向TCP也可能被堵，send不等于马上上网；先证明真实浏览器存在同类等待且反向可发送 |
| thin-stream线性重传 | 当前不选 | Linux条件要求packets_out<4等；本轮退避时未确认包约8/9个，不能用cwnd=1推断满足thin条件 |
| 限制最大RTO | 当前不针对本问题 | Linux6.18该选项最小合法值为1000ms；本轮实际RTO约832ms，设成1000ms不会压低它 |
| 调低TCP_USER_TIMEOUT、重试次数或加keepalive | 不作提速方案 | 主要改变结束/探测策略；USER_TIMEOUT不改变重发时刻，当前已有明确退出合同 |
| 高频ping、填充、重复快照、强拆TCP包 | 当前不选 | 不能越过同流缺口，也会改变带宽和恢复节奏；cwnd不足时不能保证额外数据立即发出 |
| 换BBR、扩大或缩小socket缓冲 | 缺乏针对性 | 当前是全丢包/随机丢包证据；队列、拥塞控制与重传计时分开处理，不当作通用开关 |
| 主动断线重连 | 不进入本轮 | 当前不恢复旧席位/战绩，不能用改变断线和身份合同绕过恢复指标 |
| 可过期状态数据报 | 保留长期路线 | 能改变旧状态必须按序补齐的约束，但部署、兼容、基准及反馈成本显著；不能只换可靠流就宣称解决 |

thin条件和定时行为按具体版本源码核对：[Linux6.18 tcp.h](https://raw.githubusercontent.com/torvalds/linux/v6.18/include/net/tcp.h)、[tcp_timer.c](https://raw.githubusercontent.com/torvalds/linux/v6.18/net/ipv4/tcp_timer.c)。QUICKACK与USER_TIMEOUT的边界见[Linux TCP手册](https://www.man7.org/linux/man-pages/man7/tcp.7.html)。WebTransport同时包含可靠与不可靠能力，应单独核对实际传输模式，而非仅依据API名称。[WebTransport规范](https://www.w3.org/TR/webtransport/)

## 4. 候选A：服务器单连接RTO下限

首个候选取当前200ms对照100ms，**只是实验初值**。RTO下限不是固定重发周期；实际计时仍受RTT、方差、退避和内核调度影响，不预期把约600ms直接砍半。

退避还存在相位问题。仅为说明数学关系，假设首次RTO分别200/100ms且每次翻倍、忽略其他机制，重试会出现在200/600/1400ms与100/300/700/1500ms。若链路900ms恢复，后者反而多等100ms。这个例子不预测真实Linux结果；它说明不能只挑一个恢复时刻证明参数普遍更好。[RTO退避规则](https://www.rfc-editor.org/rfc/rfc6298.html#section-5)

实现实验时，优先复用现有S3受损socket传递给Python的小型夹具，只对**服务器连接**设置TCP_RTO_MIN_US。客户端和健康连接不变。若只能改同一netns全局值，将同时影响两个端点，不能标成服务器单方向实验；本方案不默认采用这种替代。

方案制定时只完成getsockopt读取，值200000us；后续首轮已验证单socket setter及实际RTO生效，结果见[执行记录](online-tcp-recovery-test-results.md)。每次实验仍须在预热前设置、读回，并用实际RTO/包头确认有效；路由参数可能覆盖socket设置。无权限、不支持或实际未生效均单列，不能当通过。Linux6.18提供该选项，Node24公开net接口没有通用setsockopt入口；实验复用夹具不等于生产已具备接口。[Linux参数优先级](https://www.kernel.org/doc/html/v6.18/networking/ip-sysctl.html)、[socket选项实现](https://raw.githubusercontent.com/torvalds/linux/v6.18/net/ipv4/tcp.c)

只有出现一致的端到端收益，才讨论生产采用方式。目标OS、单连接控制、运维方式和回退未定前，不增加原生addon、常驻Python或部署隔离服务，也不修改整台宿主参数。若生产路径只能以明显新增依赖或运维成本实现，要把实测收益和替代方案先提交讨论。

## 5. 候选B：接收端ACK延迟上限

只作诊断时，首个候选为受损Linux客户端单连接TCP_DELACK_MAX_US=10000us（10ms），其他参数不变；对照保持原设置。当前getsockopt读到200000us，这是上限，**不是实际每次延迟200ms**，不能与已观察的约43ms混为一谈。具体上限与适配ACK逻辑由内核决定，实验以实际包头为准。Linux6.18定义和实现见[UAPI](https://raw.githubusercontent.com/torvalds/linux/v6.18/include/uapi/linux/tcp.h)、[tcp.c](https://raw.githubusercontent.com/torvalds/linux/v6.18/net/ipv4/tcp.c)。

目标是验证：约43ms这段是否缩短、是否连带改善完整状态/真实输入恢复，以及ACK包量和CPU代价。它不会消除前面的RTO等待。若受控Linux接收端有效，只能说明这段等待对ACK策略敏感，不能直接交付给浏览器用户。

真实浏览器的同类证据应单独建立。现有浏览器入口选择Windows Chrome/Edge；WSL用户PATH未找到对应Linux浏览器。不能把Node/ws客户端当浏览器，也不能加一个TCP代理后仍当作原端到端连接。后续优先复用已有可控浏览器环境；需要额外安装、采集权限或新的测试框架时，先明确必要成本，不在本轮隐式添加。

只有浏览器侧确实反复出现显著ACK等待，才研究应用层的低成本候选：首个长间隔后的完整配对状态提交后，调整下一次现有clock的发送时机。它是反馈调度假设，不是发送窗口或新snapshotAck；不能提高常态频率、挤占8份未完成请求预算导致更早退出，也不能把业务clock回复当TCP ACK。触发阈值和限频需在该候选进入前另行登记。

此备选当前不优先：原30Hz样本首状态在3529.66ms应用，上行同一654字节数据2861.01ms重发后直到3757.01ms才再发。由此推断，恢复后新写一条clock也可能堵在反向TCP后面，不能保证提前ACK。仅把1秒心跳改成高频，或在同流中多写ping，也不能重置缺口的重传定时器。

## 6. 最少验证与停止条件

本节保留实验设计与进入条件。首轮三窗已执行，结果见[执行记录](online-tcp-recovery-test-results.md)；后续矩阵未执行。复用S3-E2、原普通用户、临时netns、原8秒动作、包头与应用映射，不新增永久用例。

首轮只用最能暴露两段等待的30Hz短断网，固定种子4207：基线、仅服务器RTO下限100ms、仅客户端ACK上限10ms，共3窗。两候选独立，不先组合；新基线与候选同一工具和时段，旧归因结果只作定位参考。

| 检查 | 必需判断 |
| --- | --- |
| 作用范围 | 指定端点/连接有效、健康端与另一方向未被一起调参；设置值与实际行为一致 |
| 重传恢复 | tc实际恢复→下一次缺口重发→首个完整/新鲜状态；保留每次重试时间和双向ACK进度 |
| 操作进展 | 恢复后新输入真正执行、确认，旧射击不补执行；不能只改善下行年龄 |
| ACK等待 | 首个完整状态→ACK推进，区分纯ACK、数据携带ACK与应用send后仍未发出 |
| 副作用 | 重传/重复字节、ACK包量、实际字节、CPU、同步率与健康端；配置读取成功不等于优化成功 |
| 清理与合同 | 原队列、恢复/退出和生命周期断言全部保留；实验退出销毁作用域 |

没有可解释的净收益就停止该候选，不继续调一串数值。若RTO候选有收益，才补恢复相位0.7/1.1秒的成对对照，防止只撞中0.9秒重试相位；这是定时参数变更的必要临时变体，不增加产品支持承诺。通过后再补原60Hz短断网、60Hz丢包、150ms RTT，验证默认档和高延迟边界；如要正式采用，再细化受影响的两档与10真人容量复核，不自动铺全矩阵。

ACK候选若只在受控Linux客户端生效，停在诊断结论；浏览器落地路径不成立时不写入产品。任何回归、过度重传/ACK或只能靠改玩法/阈值取得收益的候选均不采用。最多3组成对窗口的规则继续适用，补采前登记种子、顺序、数量，不反复跑挑成功。

原O4的相对年龄和绝对门槛均保持；新的恢复分解是补充证据。实验初值不是新验收阈值，也不承诺覆盖所有浏览器和公网条件。

## 7. 当前建议

保留已有SACK/RACK/TLP与NODELAY基线。首轮三窗中RTO候选没有净收益，ACK候选停在受控Linux客户端诊断结论，不自动扩展实验。现阶段不直接修改业务消息、心跳频率、系统默认或传输架构。

如果服务器侧小范围调参仍不能稳定改善两向操作恢复，应保留结果并停止继续堆TCP参数；届时再讨论可过期状态传输或目标调整。目标服务器、实机和浏览器能力未证实前，不把本机方案标成生产优化完成。

## 8. 首轮执行登记

2026-11-15用户已授权只执行首轮三个30Hz短断网对照，生产参数保持。固定ingress、trace=tcp、种子4207、原2秒预热/8秒采样、约0.9秒双向全丢包，顺序为baseline→server-rto100→client-ack10；不组合、不新增永久用例、不自动进入后续矩阵。

实验夹具在预热前以普通应用用户访问四个已连接socket的副本，一次读取基线与改后值：受损服务器、健康服务器、受损客户端、健康客户端。baseline只读；RTO组仅受损服务器TCP_RTO_MIN_US=100000；ACK组仅受损客户端TCP_DELACK_MAX_US=10000。核对其余选项及sysctl不变，读回失败或作用域不符则实验无效，不扩大到netns全局设置。接口读回与包头/ss实际效果分开报告。

沿用原绝对年龄/间隔、活动、队列、恢复和清理断言。每组保留原始报告、包头、实际故障时刻和参数记录，比较恢复到首状态/3个新鲜tick、新输入真正执行/确认、ACK推进、重传、字节与CPU。单轮差值只作筛选；候选失败也保留，并继续能独立完成的另一候选。本轮证据根目录：`artifacts/online-weak-network/20261115/tcp-controls/`。

执行中核实：当前内核CONFIG_HZ=250，延迟ACK选项按jiffy保存，请求10000us会向上取整为12000us。夹具改为从只读内核配置推导应读回值，仍逐项校核四个socket；没有改成另一个请求值。首次ACK窗口在预热/采样前因原严格相等校验失败而停止，保留原记录，仅补跑该无效窗口。最终须同时报告请求10ms、有效12ms，不标为精确10ms。[Linux6.18设置与读取实现](https://raw.githubusercontent.com/torvalds/linux/v6.18/net/ipv4/tcp.c)

首轮结论已记录：RTO组新鲜状态恢复比本轮基线慢214.16ms，未满足继续实验的净收益条件；ACK组等待少28.03ms、新鲜状态早28.70ms，但新输入执行没有改善，且只有受控Linux客户端接口。按停止条件保留生产基线，不自动进入后续矩阵；完整数据、失败与限制见[执行记录](online-tcp-recovery-test-results.md)。
