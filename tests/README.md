# 测试与诊断入口

先复用现有用例，只有明确需求、缺陷回归或已确认需求中的关键覆盖缺口才新增。用例独立建立状态并清理资源，服务器和客户端按责任分别验证。完整要求见[开发约定第 8 节](../docs/development-guide.md#8-测试验收与证据)，需求映射及历史结果见[文档导航](../docs/README.md)。本次目录整理不增加测试用例。

## 基础检查

在仓库根目录使用 Node.js 24.x、npm 11.x：

```sh
npm ci
npm test
npm run check
npm run build
```

`npm test` 递归发现 `tests/` 下的 `.test.mjs`。`npm run check` 覆盖格式、静态规则、语法、循环与模块边界；实际格式治理列表见 [check.mjs](../scripts/check.mjs)，大型旧表现模块尚未统一格式化。构建不自动执行浏览器、真实网络或设备验收。

## 按责任选择逻辑用例

| 责任 | 文件位置 | 独立入口 |
| --- | --- | --- |
| 共用规则 | `tests/sim/`，另含历史位置的 `tests/server/combat.test.mjs` | `npm run test:sim` |
| 协议契约 | `tests/protocol/` | `npm run test:protocol` |
| 服务器 | `tests/server/`，上述共用规则例外除外 | `npm run test:server` |
| 客户端 | `tests/client/`、`tests/net/` | `npm run test:client` |
| 工程工具 | `tests/tooling/` | `npm run test:tooling` |
| 旧离线逻辑、几何与表现 | `tests/` 根目录 | `node scripts/run-tests.mjs --layer=legacy` |
| 基线样本 | `tests/fixtures/` | [来源与重现说明](fixtures/README.md)，不是另一组测试 |

文件层级沿用既有结构，实际责任映射以 [run-tests.mjs](../scripts/run-tests.mjs) 为准。服务器测试按需创建临时服务；客户端逻辑由可控消息驱动，无需人工启动服务器或浏览器。

```sh
node scripts/run-tests.mjs --case=S2-N1
node scripts/run-tests.mjs --layer=client --case=O3-C1
node scripts/run-tests.mjs --layer=server --case=S4-R1
node scripts/run-tests.mjs --file=tests/server/app.test.mjs
```

`--case` 接受稳定编号或完整名称，`--out=目录` 指定证据目录；默认目录带运行编号。选择未命中会失败，空文件占位不计入通过数，以 `Selected results` 和 `summary.json` 为准。自定义参数直接传给 Node 入口，避免 Windows npm 参数转发差异。

## 必要集成检查

| 范围 | 入口 | 环境与前置条件 |
| --- | --- | --- |
| 默认离线预览与资源清理 | `npm run test:preview` | 先全量构建；自建自关预览，无需浏览器 |
| S1 实际交火及单文件 | `npm run test:s1:browser` | Chrome/Edge；支持 `--file=dist/index.html`，见 [S1 记录](../docs/s1-test-plan.md) |
| S2 交火、暂停、原生触摸 | `npm run test:s2:browser` | Chrome/Edge；自建临时服务，见 [S1/S2 设计](../docs/s1-s2-test-design.md) |
| S4 双玩法房间流程 | `npm run test:s4:browser` | Chrome/Edge；自建临时服务，见 [S4 方案](../docs/s4-test-plan.md) |
| 独立目录/ZIP 启动 | `node scripts/s2-launch-check.mjs --out=artifacts/build-launch-check` | 先全量构建、npm registry 可达；空缓存安装运行依赖；目录用新路径，见 [交付包记录](../docs/release-package-results.md) |
| 本地真实信号与回退 | 同一启动检查追加 `--lifecycle` | WSL/Linux、候选包、旧包、原静态 HTML；完整参数见 [本地演练](../docs/local-runtime-results.md) |

浏览器脚本通过 `CHROME_PATH` 指定 Chrome/Edge；未指定时探测常见路径，缺失会明确报错。源码入口自建服务的检查与旧离线回归使用不同准备方式，不把正在运行的联网大厅当作离线页面测试。

```sh
node scripts/s2-browser-check.mjs --case=S2-I1 --profile=B
node scripts/s2-browser-check.mjs --case=S2-I2
node scripts/s2-browser-check.mjs --case=S2-I3
node scripts/s4-browser-check.mjs --case=S4-I1 --mode=tdm
```

浏览器模拟触摸、同机交火和进程启动均不能替代真实双设备体验。

## 定向实验与诊断

这些入口按任务选择，不属于每次提交必须全跑的默认套件。旧弱网失败与停止条件保持，先核对方案中的参数、历史来源和输出目录。

| 范围 | 入口 | 依据与依赖 |
| --- | --- | --- |
| S3 编码对照 | `npm run test:s3:encoding` | [S3 方案](../docs/s3-test-plan.md)，Node.js |
| S3 丢包、短断网及积压 | `node scripts/s3/run.mjs --case=S3-E2 --hz=60 --profile=loss` | [S3 方案](../docs/s3-test-plan.md)，WSL/Linux、tc/ip/python3 与校验过的 Node.js；隔离网络配置需相应权限 |
| 弱网测量与 TCP 归因 | 上述入口显式选择 `--topology=ingress`、`--trace=tcp` 等 | [弱网设计](../docs/online-weak-network-test-plan.md)、[归因记录](../docs/online-weak-network-attribution-results.md)；另需 IFB、ethtool 等对应能力 |
| S5 容量 | `npm run test:s5:capacity` | [S5 方案](../docs/s5-test-plan.md)、[当前带宽门槛](../docs/online-bandwidth-test-plan.md)，临时本地服务，无需浏览器/WSL |
| S5 资源回收 | `npm run test:s5:resources` | 同上，分进程真实服务与协议，自动清理 |

当前性能验收范围是单房最多 10 真人，或最多两房合计 10 真人以内；旧 16/32 真人是历史探索。正式持续负载使用 `--sample-ms=60000 --warmup-ms=5000`，例如：

```sh
node scripts/s5/run.mjs --case=S5-E1 --hz=60 --humans-per-room=10 --sample-ms=60000 --warmup-ms=5000 --out=artifacts/online-bandwidth/new-run
```

两房可显式选 `--humans-per-room=5,5`、`1,9` 或 `1,1`；不指定 load/rooms/显式人数时运行这四个分配。旧 `--load=bots|humans|mixed` 仅用于显式探索，不能把扩大测试准入后的结果写成产品保证。`npm run test:s3`、`npm run test:s5` 分别运行对应工具的默认实验集合，执行前应核对运行成本和当前任务范围。

## 旧离线与画面对照

先构建，在单独终端执行 `npm run preview:offline`；下列已接统一配置的检查默认访问 `http://127.0.0.1:4173/`，也可通过 `TEST_URL` 指定离线页面的完整 HTTP / `file:` 地址。

| 范围 | npm 入口 |
| --- | --- |
| 加载、交火、反馈与稳定性 | `test:browser`、`test:feedback`、`test:extended`、`test:arena`、`test:menu` |
| 触屏、横屏与输入清理 | `test:mobile`、`test:landscape` |
| 九模块展示场 | `test:lab`；接口见 [lab-contract.json](../docs/lab-contract.json) |

```powershell
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:TEST_URL = ([System.Uri](Join-Path $PWD 'dist/index.html')).AbsoluteUri
npm run test:arena
```

`scripts/` 还保留 `test:surfaces`、`test:post`、手部/手臂/换弹及图像对照工具；部分历史工具仍使用原配置，需要相应旧截图、基线或参考 HTML。`audit:reference`、`study:reference` 用于参考审计；原始参考文件不随源码上传，也不影响基础构建。上述工具的保留用于复现历史工作，不代表它们已全部迁移至新测试框架或必须逐个重跑。

`scripts/browser-config.mjs`、`test-report.mjs`、`npm-cli.mjs`、`module-check.mjs`、`runtime-check-support.mjs`、`local-runtime-check.mjs` 及 `scripts/s3/`、`scripts/s5/` 中的辅助模块服务于入口脚本，按引用调用，不另算独立测试用例。
