# 文档导航

当前阶段和待验项以[分阶段实施计划](online-implementation-plan.md)为准。各次实验记录保留当时的源码、参数、失败与结论；历史页中的“未进入下一阶段”描述当轮状态，不覆盖后续用户授权。文档数量不代表验收覆盖。

## 工作依据与交付

| 文档 | 用途 |
| --- | --- |
| [联网产品设计](online-product-design.md) | 玩家行为、玩法与支持边界 |
| [联网技术方案](online-technical-design.md) | 模块、协议、同步和机制；参数区分已确定与待验证 |
| [分阶段实施计划](online-implementation-plan.md) | S1—S6 范围、当前状态和剩余工作 |
| [开发约定](development-guide.md) | 工程边界、少量高覆盖测试、独立运行与证据要求 |
| [发布与运行约定](release-runbook.md) | 构建、清单、部署门槛及回退 |
| [包内运行说明](../packaging/RUNNING.md) | 解包、安装运行依赖、核验与启动 |
| [GitHub 提交准备](github-handoff.md) | 本地整理范围、Fork 与分支、后续 PR 准备 |
| [测试入口](../tests/README.md) | 分层选择、集成和诊断命令及环境依赖 |

## 阶段测试方案与记录

| 范围 | 方案与覆盖 | 执行证据 |
| --- | --- | --- |
| S1 共用计算与工程检查 | [S1 原方案](s1-test-plan.md)、[S1/S2 覆盖审查](s1-s2-test-design.md) | [S1 当轮结果](s1-test-plan.md)、[补强结果](s1-s2-test-results.md) |
| S2 联网交火 | [S2 原方案](s2-test-plan.md)、[S1/S2 覆盖审查](s1-s2-test-design.md) | [S2 当轮结果](s2-test-plan.md)、[补强结果](s1-s2-test-results.md) |
| S3 同步与弱网 | [S3 方案](s3-test-plan.md) | [实现轮](s3-test-results.md)、[必要测试补强](s3-test-review.md) |
| S4 房间与完整玩法 | [S4 方案](s4-test-plan.md) | [S4 结果](s4-test-results.md) |
| S5 本地容量与资源 | [S5 方案](s5-test-plan.md) | [S5 结果](s5-test-results.md) |
| 独立运行交付包 | [发布约定](release-runbook.md) | [交付包验证](release-package-results.md) |
| 本地启停与回退 | [运行与回退约定](release-runbook.md) | [本地演练](local-runtime-results.md) |

## 带宽与弱网调查

当前保留 O4 未通过结论，进一步性能优化已按用户安排暂缓。下列记录用于追溯，不构成新的执行清单，也不要求上传前重复网络实验。

| 范围 | 方案 | 结果 |
| --- | --- | --- |
| 带宽优化 O1—O4 | [优化设计](online-bandwidth-optimization-plan.md)、[测试设计](online-bandwidth-test-plan.md) | [实现与联合门槛](online-bandwidth-test-results.md) |
| 测量与时钟修正 W1/W2 | [优化候选](online-weak-network-optimization-plan.md)、[测试设计](online-weak-network-test-plan.md) | [前两步结果](online-weak-network-test-results.md) |
| 重传与旧快照积压 | [归因设计](online-weak-network-test-plan.md#后续重传恢复与旧快照归因) | [TCP 归因及压缩等级勘误](online-weak-network-attribution-results.md) |
| RTO 与 ACK 三窗对照 | [候选方案](online-tcp-recovery-optimization-plan.md) | [首轮结果](online-tcp-recovery-test-results.md) |
| O4 退化及操作恢复 | [原测试门槛](online-bandwidth-test-plan.md) | [退化核查](online-o4-regression-review.md) |
| 夹具、TCP、浏览器调度 | [三个诊断窗口及结果](online-three-diagnostics-results.md) | [夹具修正与 CDP 对照](online-fixture-cdp-control-results.md) |
| 修正夹具后的四窗复核 | [四窗登记与结果](online-o4-corrected-pair-results.md) | 同页保留全部四窗，无追加重跑 |
| Windows 浏览器连 WSL | [两窗环境与结果](online-wsl-browser-results.md) | 本轮通过健康页间隔线，不能证明 O4 已通过 |

## 离线版本历史与参考

- [技术评审意见](online-technical-review.md)：2026-11-13 的草案评审，已采纳内容见当前技术方案。
- [1.4 视觉改造记录](visual-upgrade-v1.4.md)、[参考审计摘要](reference-audit.json)：不包含原始参考源码或素材。
- [展示场接口](lab-contract.json)：九模块展示场的自动化接口。
- [1.4.9 离线验证](validation.json)及 [1.4.0](validation-v1.4.0.json)、[1.4.1](validation-v1.4.1.json)、[1.4.2](validation-v1.4.2.json)、[1.4.3](validation-v1.4.3.json)、[1.4.4](validation-v1.4.4.json)、[1.4.5](validation-v1.4.5.json)、[1.4.6](validation-v1.4.6.json)、[1.4.7](validation-v1.4.7.json)、[1.4.8](validation-v1.4.8.json) 历史摘要：对应各自版本，不能作为当前联网实现的验证结果。

## 原始证据在哪里

可审阅的设计、执行摘要与失败结论保存在 `docs/`；原始日志、截图、实验窗口和交付 ZIP 保存在被 Git 忽略的 `artifacts/`。历史文档里的 `../artifacts/…` 链接是本地证据路径，GitHub 源码页面不会自动提供这些文件。

原始证据已在本地保留；上传源码不删除、改写或选择性隐藏失败记录。需要向评审者提供原始数据时，另行核对归档内容、哈希与可访问交付位置，具体公开上传按授权执行。现有源码检查可重新运行；带历史包的回退、图像对照等检查还需要对应归档或参考文件，不能承诺仅克隆仓库就具备全部历史实验条件。
