# VeriGen 产品化路线图

本文档记录 S4 之后到产品化交付的路线图。目标不是继续堆底层能力，而是把 VeriGen 从“可安装的 Verilog 分析能力包”推进到“基于 pi agent harness 的 Verilog 特化 coding agent 产品”。

## 阶段判断

- **能演示**：需要做到 S10-S11。
- **能作为工程产品使用**：至少需要做到 S13。
- **成熟、美观、可交付的 TUI 工程界面**：建议规划到 **S15**。
- **真实 FPGA 验证**：不阻塞 S5-S15；没有设备时先做 mock/dry-run，设备到位后进入 **S16**。
- **生成质量探针**：从 S5 开始常驻执行 Codegen Quality Probe，先人工评审，S12 升级为正式评测体系。

当前状态：S0-S15 MVP 已完成。下一步继续增强交互式产品 TUI polish，并在真实 FPGA 设备到位后进入 S16。

S5 当前实现：`packages/verigen` 已新增 VeriGen mode/profile、文本 trace panel、固定失败 `trace-demo`、用户文件 `trace-panel`、`tui-preview`、`verigen agent`、Codegen Quality Probe L0/L1 小题和可选 Anthropic-compatible 生成调用。后续 S13/S14 会在此基础上继续产品级 TUI 信息架构和可视化 polish。

S6 当前实现：新增统一 EDA ToolRunner schema，已接入 `iverilog/vvp` compile/sim、Verilator lint profile、Yosys synth profile、Himasim placeholder/profile，并让 Codegen Quality Probe 支持 `--run-tools` 进入 compile/sim。本机 Verilator/Yosys/Himasim 未安装时会按统一 schema 返回 `missing_tool`，`doctor` 给出修复建议。

S7 当前实现进展：新增 `runCodegenQualityProbeFixLoop` 和 `verigen quality-probe fix-loop`，将 Quality Probe case 编排为 Planner/Coder/Verifier/Debugger 四阶段闭环。默认 dry-run 会先制造一次仿真失败再修复通过；`--live` 会把每轮 Coder prompt 发给配置的 Anthropic-compatible endpoint。report 已记录最多 3 轮、失败类型、修复轮次、Verifier 结果和最终 RTL。

S8 当前实现进展：新增 `buildVerigenRoutedContext`，统一裁剪 Spec KG、Playbook、Graphify query result、trace context 和 ToolRunner issues，输出可注入 Coder/Debugger 的 section list、rendered context、预算和 omission 统计。当前先落 API 和测试，agent runtime tool mapping、S7 report 注入和 TUI inspector 接入仍待推进。

S9 当前实现：新增 board profile/schema、mock programmer backend、固定 `blink_led` 和 `uart_loopback` 设计，以及 `verigen board-smoke --smoke ...`。mock backend 已能输出 validate、synth、bitstream、program、observe 的结构化 dry-run report；真实设备仍放到 S16。

S10 当前实现：新增 `runDryRunHardwareFlow` 和 `verigen hardware-flow --template ...`，受控模板会先跑真实 `iverilog/vvp` 仿真，再进入 S9 mock board validate/synth/bitstream/program/observe，输出 `simResult`、`boardReport` 和 `issues`。

S11-S15 当前实现：新增 `release-smoke`、`eval-suite`、`product-preview`、`product-workbench` 和 `product-template`。当前已能输出 release smoke checklist、本地 release smoke verifier、built dist 包面预检、pack/install smoke plan、quickstart、CI checklist、example projects、evaluation metrics、failure samples、product workbench model、响应式 TUI preview、轻量交互 TUI、pi-tui Component 适配契约、`verigen agent` 默认 extension 加载、coding-agent extension 挂载入口、onboarding、provider config page、doctor repair suggestions、project template scaffold、board profile management、inspector tabs、keybindings、可回放 TUI action、layout persistence、session replay 和可落盘 markdown report artifact。离线 TUI dogfood 已验证首屏能加载 extension 并渲染 workbench；真实 npm pack/install smoke 和视觉 polish 仍可继续增强。

## 总览

| 阶段 | 目标 | 核心交付 | 验收标准 |
|---|---|---|---|
| S5 | VeriGen Mode + TUI Trace MVP | 专属模式、流水线状态、trace 文本面板、Codegen Quality Probe 小题集 | 固定失败 RTL + VCD 能在 TUI 展示 trace report；至少能生成 L0/L1 小题 RTL 供人工评审 |
| S6 | EDA ToolRunner 标准化 | iverilog/vvp、Verilator、Yosys、Himasim profile 和统一错误 schema | `lint -> sim -> trace` 能结构化返回给 Debugger；Quality Probe 可跑 compile/sim |
| S7 | 四 Agent 闭环 | Planner/Coder/Verifier/Debugger 串联，最多 3 轮 fix loop | 简单 RTL 任务能从自然语言到仿真通过；Quality Probe 记录修复轮次 |
| S8 | Context Router 强化 | Graphify、KG、Playbook、trace 统一裁剪和注入 | 模型能自动取相关规则/文件/图节点，不全仓盲搜 |
| S9 | Board Profile 抽象 + Mock Bring-up | board schema、constraints schema、programmer interface、mock board backend | 固定 `blink_led` 在 mock backend 中完成 synth/bitstream/program/report dry-run |
| S10 | Dry-run Hardware Flow | 受控模板任务接入 sim/synth/dry-run program/smoke report | 简单模块由 VeriGen 生成，完成 sim/synth/dry-run hardware report |
| S11 | 发布工程化 | npm 发布、release smoke、示例工程、CI pack/install smoke | 新机器按 quickstart 可安装并跑通 smoke |
| S12 | 评测与数据闭环 | Codegen Quality Probe 正式化、VerilogEval/自建用例、失败样本库、指标统计 | 可量化生成质量、收敛率、修复轮次、错误分类分布 |
| S13 | 产品级 TUI 信息架构 | 项目仪表盘、pipeline navigator、inspector tabs | 用户能在 TUI 完成一次完整 RTL debug 工作流 |
| S14 | TUI 可视化 polish | 波形窗口、信号依赖图、RTL diff、键盘操作、状态体系 | TUI 达到可演示、可重复使用、信息密度合理 |
| S15 | 产品化交付闭环 | onboarding、doctor 修复建议、模板、profile 管理、报告导出、session replay | 可用于正式演示、内部试用和后续商业化包装 |
| S16 | Real FPGA Validation | 接真实板卡 backend、真实 programmer、真实观测 smoke | 固定 demo 和一个 VeriGen 生成模块在真实 FPGA 上 smoke 通过 |

## 常驻：Codegen Quality Probe

目标：中途就观察 Verilog 代码生成质量，不等到真实 FPGA 或完整产品化才发现 prompt、KG、Playbook 或 ToolRunner 方向有问题。

执行时机：

- S5 开始引入，作为常驻质量探针。
- 每次改 prompt、KG、Playbook、ToolRunner、Context Router 或 TUI workflow 后运行。
- S5-S7 以小题集 + 人工评审为主。
- S12 升级为正式评测体系，进入数据闭环和指标统计。

建议题集：

| 层级 | 类型 | 题目 |
|---|---|---|
| L0 | 组合逻辑 | mux、priority encoder、edge detector、saturating adder |
| L1 | 时序逻辑 | counter、shift register、debounce、pulse synchronizer |
| L2 | FSM | sequence detector、traffic light、simple UART rx controller |
| L3 | 接口骨架 | FIFO、ready/valid skid buffer、I2C master skeleton、SPI master skeleton |

每题记录：

- prompt / spec
- module contract
- generated RTL
- generated 或固定 testbench
- lint / compile / sim result
- 是否符合端口契约
- 是否可综合子集
- 是否有 latch / race / width warning
- 修复轮次
- 人工评审结论

测试 LLM 端点：

- 后续 Codegen Quality Probe 默认优先支持内网 Anthropic-compatible 端点。
- base URL：`http://172.18.5.179:3000`，兼容实现可能要求 `http://172.18.5.179:3000/v1`。
- API key 不进入仓库文档或 commit，只通过环境变量注入。
- 建议环境变量：
  - `VERIGEN_TEST_LLM_PROVIDER=anthropic`
  - `VERIGEN_TEST_LLM_BASE_URL=http://172.18.5.179:3000`
  - `VERIGEN_TEST_LLM_MODEL=kimi-for-coding`
  - `VERIGEN_TEST_LLM_API_KEY=<local-secret>`

验收口径：

- S5：至少能生成 L0/L1 小题 RTL，人工检查风格、端口、时序写法。
- S6：Quality Probe 可接 ToolRunner 跑 compile/sim。
- S7：Quality Probe 可进入 3 轮 fix loop。
- S12：Quality Probe 正式指标化，和 VerilogEval/自建用例一起进入数据闭环。

## S5：VeriGen Mode + TUI Trace MVP

目标：让用户进入一个明确的 VeriGen 模式，而不是继续使用通用 pi coding-agent 界面。

交付：

- 增加 VeriGen mode/profile。
- 定义任务阶段：`spec -> plan -> rtl -> sim -> trace -> fix -> report`。
- 把 `traceSimulationFailure` 接入任务流。
- TUI 先做文本版 trace 面板：
  - mismatch signal
  - controller chain
  - hex waveform table
  - 命中 RTL 代码片段
  - Debugger 修复建议
- 保留原 pi 对话流和工具调用能力。
- 加入 Codegen Quality Probe 的入口或命令占位，能展示生成 RTL、工具结果和人工评审备注。

验收：

- 输入固定失败 RTL + VCD。
- TUI 能自动展示 trace report。
- Debugger 能看到裁剪后的 trace context。
- L0/L1 小题能生成 RTL 供人工评审。

当前落地：

- `verigen agent` 加载 VeriGen prompts/skill 后委托给原 pi coding-agent，保留 pi 对话流、工具调用、会话和 TUI 基础能力。
- `verigen mode` 输出 S5 VeriGen profile 和任务阶段。
- `verigen trace-demo` 用固定失败 RTL/VCD 自动生成 trace panel。
- `verigen trace-panel --rtl ... --vcd ... --mismatch ...` 对用户文件生成 trace panel。
- `verigen tui-preview trace-demo` 把固定失败 trace report 渲染成 S5 TUI 预览快照。
- `verigen tui-preview quality-probe --case l0-mux2 --live` 把生成 RTL 和人工评审清单渲染成 S5 TUI 预览快照。
- `verigen quality-probe list` 展示 L0/L1 小题集。
- `verigen quality-probe run --case l0-mux2 --live` 用 `VERIGEN_TEST_LLM_MODEL=kimi-for-coding` 调内网 Anthropic-compatible endpoint，输出生成 RTL、工具结果占位和人工评审清单。

## S6：EDA ToolRunner 标准化

目标：把 lint、sim、synth 从临时命令变成稳定工具层。

交付：

- `iverilog/vvp` profile。
- Verilator lint profile。
- Yosys synth profile。
- Himasim profile 占位或接入。
- 统一输出 schema：
  - compile error
  - sim fail
  - width warning
  - synth fail
  - missing tool
- 日志定位到文件、行号、片段。
- `verigen doctor` 能检查工具并给修复建议。

验收：

- 固定 RTL/TB 能跑 `lint -> sim -> trace`。
- 工具错误能结构化返回给 Verifier/Debugger。
- Codegen Quality Probe 生成的 RTL 能进入 compile/sim 检查。

当前落地：

- `verigen tool-runner sim --rtl ... --tb ... --top ... --json` 运行 `iverilog/vvp`。
- `verigen tool-runner lint --rtl ... --top ... --json` 运行 Verilator lint，缺失时返回 `missing_tool`。
- `verigen tool-runner synth --rtl ... --top ... --json` 运行 Yosys synth/check，缺失时返回 `missing_tool`。
- `verigen tool-runner himasim --json` 提供 Himasim profile/placeholder。
- `verigen quality-probe run --case l0-mux2 --live --run-tools` 对生成 RTL 运行 compile/sim。
- `verigen doctor` 检查 Verilator、Yosys、Himasim 并给修复建议。

## S7：四 Agent 闭环

目标：让 Planner/Coder/Verifier/Debugger 真正协作。

交付：

- Planner 产出 module contract / KG。
- Coder 按 KG 契约生成 RTL diff。
- Verifier 生成或执行 testbench。
- Debugger 在仿真失败后消费 trace report。
- 最多 3 轮 fix loop。
- 每轮输出结构化 run report。

验收：

- counter、edge detector、简单 FSM 能从自然语言到仿真通过。
- 失败时进入 Debugger，不是盲目重写全部 RTL。
- Quality Probe 每题记录修复轮次和失败类型。

当前落地：

- `runCodegenQualityProbeFixLoop(caseId)` 生成 module contract / KG seed，并运行最多 3 轮 fix loop。
- `verigen quality-probe fix-loop --case l0-mux2` 提供无 LLM 的 deterministic smoke：第一轮仿真失败，Debugger 生成 repair prompt，第二轮通过。
- `verigen quality-probe fix-loop --case l0-mux2 --live` 使用配置的 Anthropic-compatible endpoint 生成每轮 RTL。
- 结构化 report 包含 `repairRounds`、每轮 `failureType`、Verifier `edaResults`、Debugger repair prompt 和最终 RTL。

仍需补齐：

- 扩展 edge detector、FSM 等 S7 验收任务。
- 将 Debugger 的 sim-fail 分支接入更通用的 trace report，而不是只消费 ToolRunner failure summary。
- 将 S7 report 接入后续 TUI inspector。

## S8：Context Router 强化

目标：让 Graphify、KG、Playbook、trace 进入统一上下文路由。

交付：

- Graphify tool 映射到 agent runtime。
- KG/Playbook/Graphify/trace 统一裁剪。
- 限制最大 token 和最大节点数。
- Debugger/Coder 按任务自动检索相关规则。
- raw graph、raw VCD、完整报告不直接进入模型上下文。

验收：

- 同一任务下，模型能自动取到相关 prompt、Playbook 规则、设计文档和实现文件。
- 上下文不会全仓展开。

当前落地：

- `buildVerigenRoutedContext` 可合并 KG、Playbook、Graphify、trace 和 tool results。
- 每个来源都有独立数量限制；整体有 `maxTotalChars` 和 `maxSectionChars`。
- Graphify 只注入 query 命中的节点 path/summary，不注入 raw graph。
- trace 只消费 S2/S5 已裁剪的 `DebuggerTraceContext`，不注入 raw VCD。

仍需补齐：

- 将 router 映射到 agent runtime 的真实 tool/context 注入点。
- 把 S7 fix-loop report 注入 Coder/Debugger。
- 把 routed sections 接到后续 TUI inspector。

## S9：Board Profile 抽象 + Mock Bring-up

目标：在没有真实 FPGA 设备时，先把硬件接口抽象稳定下来。真实设备只是后续 backend，不应阻塞 TUI、发布、评测和产品化工作。

交付：

- board profile schema：
  - FPGA part
  - clock/reset
  - pin map
  - constraints
  - programmer
- constraints schema：
  - clock
  - reset
  - IO bank
  - pin direction
  - voltage / electrical hints
- programmer interface：
  - synth
  - bitstream
  - program
  - observe
  - collect logs
- mock board backend。
- 固定 `blink_led` smoke。
- 固定 UART loopback 或 I2C loopback smoke。
- bitstream/program dry-run 命令封装。
- mock bring-up 日志结构化。

验收：

- 非 AI 生成的固定 demo 能在 mock backend 中完成 synth、bitstream、program、observe 的 dry-run。
- 输出 report schema 与未来真实 FPGA backend 保持一致。

当前落地：

- `createDefaultMockBoardProfile()` 定义 mock FPGA part、clock/reset、pin constraints 和 mock programmer。
- `createBlinkLedDesign()` 与 `createUartLoopbackDesign()` 提供固定 smoke RTL。
- `runMockBoardBringup()` 输出 validate、synth、bitstream、program、observe steps、artifacts、observations 和 issues。
- `verigen board-smoke --smoke blink_led` 和 `--smoke uart_loopback` 可从 CLI 预览 dry-run report。

## S10：Dry-run Hardware Flow

目标：把 Agent 生成代码接入硬件流程抽象，但不要求真实设备。先证明 sim/synth/dry-run program/report 的产品链路完整。

交付：

- 仅允许受控模板任务进入 hardware flow。
- 自动检查 constraints。
- 自动跑 sim/synth，再 dry-run program。
- dry-run smoke 结果回传 report。
- 禁止未约束 IO、未知 clock、危险 pin map。

验收：

- VeriGen 生成一个简单模块。
- 仿真通过、综合通过、dry-run hardware smoke report 通过。

当前落地：

- `runDryRunHardwareFlow({ template: "blink_led" })` 和 `uart_loopback` 已跑通。
- 受控模板先进入 S6 `iverilog/vvp` 仿真。
- 仿真通过后进入 S9 mock board dry-run report。
- 自定义未审核 design 会被拒绝，避免未知 IO 和未约束硬件流进入后端。

仍需补齐：

- 把 S7/S8 Agent 生成 RTL 接入受控 hardware templates。
- 引入 mock synth 之外的可选 Yosys profile，通过缺工具时继续保留 dry-run 路径。

## S11：发布工程化

目标：从工程原型变成可安装、可验证、可演示的包。

交付：

- npm package name / scope / publish 权限确认。
- release smoke。
- CI pack/install smoke。
- 中文 quickstart。
- 示例工程：
  - counter
  - FSM
  - UART loopback
  - I2C skeleton
- changelog / version strategy。

验收：

- 新机器按 README 能安装并跑通 CLI/worker/doctor smoke。
- 发布流程可重复。

当前落地：

- `createReleaseEngineeringReport()` 输出 package name、version strategy、publish target、quickstart、smoke steps、examples、CI checklist 和 release blockers。
- `verigen release-smoke` 可预览 S11 checklist。
- `verigen release-smoke --verify-local` 可检查 package manifest、bin、files whitelist、prepack hook、pi coding-agent/pi-tui 依赖、`./coding-agent-extension` 子路径导出、S15 workbench extension 入口、`verigen agent` 默认 extension 加载、Python worker 源码、vendored pyverilog fork 和 no-Docker 安装边界。
- `verigen release-smoke --verify-dist` 可在 build/prepack 之后检查 built `dist` 包面，覆盖 CLI/API 入口、coding-agent extension、agent extension wiring、Python worker、vendored pyverilog、VeriGen prompt assets 和 skill assets，不触发 `npm pack` 或 build。
- `verigen release-smoke --pack-install-plan` 可输出真实 pack/install smoke 的命令清单，覆盖 source precheck、`npm pack`、临时 prefix install、installed CLI、installed `--verify-dist`、agent extension、product TUI、Quality Probe、hardware flow、doctor 和 worker smoke；它只输出计划，不执行命令、不处理 npm 认证。
- `@earendil-works/pi-verigen` 已纳入 root build、local release 和 publish 脚本，并新增 `packages/verigen/CHANGELOG.md`；正式 release/tag 后 CI publish job 才会覆盖 VeriGen npm 包。
- npm publish 权限、dist-tag 和真实 release command 仍需发布前确认。
- 真实 `npm pack` / 临时 prefix install smoke 仍需发布前显式运行。

## S12：评测与数据闭环

目标：把 Codegen Quality Probe 从人工小题集升级成正式评测体系，量化 VeriGen 的生成与修复能力。

交付：

- Codegen Quality Probe 正式化：
  - 固定题集版本
  - 固定 prompt/spec
  - 固定 TB 或 golden checker
  - 固定评分字段
- VerilogEval 或自建评测用例接入。
- 失败样本结构化记录：
  - prompt
  - spec
  - KG
  - generated RTL
  - tool error
  - trace report
  - fix diff
  - pass/fail
  - iteration count
- 指标：
  - pass@1
  - 3 轮内收敛率
  - 平均修复轮次
  - 工具错误分类分布

验收：

- 每次评测有可比较指标。
- 失败样本可回灌 Playbook。

当前落地：

- `runEvaluationSuite("smoke" | "roadmap")` 运行固定 Quality Probe case。
- 指标包含 `passAt1Rate`、`convergenceRate`、`averageRepairRounds` 和 `failureTypeDistribution`。
- `verigen eval-suite --suite smoke` 可输出可比较 report 和 replay hint。

## S13：产品级 TUI 信息架构

目标：把 TUI 从“通用聊天界面”升级为“Verilog 工程工作台”。

交付：

- 项目仪表盘。
- 左侧 pipeline navigator。
- 中央对话 / task log。
- 右侧 inspector tabs：
  - RTL diff
  - sim log
  - trace report
  - waveform table
  - KG view
  - Graphify context
  - tool log
- run history。

验收：

- 用户不看终端原始日志，也能理解当前任务阶段、失败原因、修复依据和下一步。

当前落地：

- `createProductWorkbenchModel()` 定义项目仪表盘、pipeline navigator、task log、inspector tabs 和 run history/session replay。
- inspector tabs 覆盖 RTL diff、sim log、trace report、waveform、KG、Graphify、tool log 和 board report。
- `verigen product-preview --tui` 可渲染响应式 workbench TUI preview，宽屏三栏、中等宽度双栏、窄终端堆叠，并支持通过 `--inspector` 指定 inspector。
- `verigen product-workbench` 可进入轻量交互终端 TUI，支持 keybindings 驱动状态切换。

## S14：TUI 可视化 polish

目标：把 S13 从“能用”推进到“美观、高效、可演示”。

交付：

- 统一主题、色彩、状态图标。
- 波形窗口压缩显示。
- 信号依赖图。
- 错误行跳转。
- RTL diff 高亮。
- keyboard-first 操作。
- layout persistence。
- loading / empty / error states。
- 移动焦点和 pane 切换体验。

验收：

- 30 分钟演示不会暴露明显 UI 断层。
- trace、diff、KG、log 能在一个工作台中顺畅切换。

当前落地：

- product preview 已锁定统一状态 badge、pipeline、inspector tabs、keybindings 和 session replay 信息架构。
- product workbench model 已支持焦点状态、inspector 前后切换、density toggle、layout 序列化/恢复和 action replay。
- `verigen product-preview --tui --action focus-left,toggle-density` 可预览键盘操作后的工作台状态。
- `ProductWorkbenchTuiComponent` 可把 terminal input 映射到 workbench action，不需要真实终端即可测试。
- 仍需继续把状态模型接回 pi-tui/coding-agent 主界面和视觉 polish。

## S15：产品化交付闭环

目标：支持正式演示、内部试用和后续商业化包装。

交付：

- onboarding wizard。
- `doctor` 自动修复建议。
- 项目模板。
- board profile 管理。
- 本地模型/provider 配置页。
- 导出报告。
- session replay。
- 企业内网安装说明。
- 发布包 smoke checklist。

验收：

- 新用户能按向导完成环境检查、创建项目、跑 demo、查看报告。
- 演示人员能稳定复现完整 VeriGen workflow。

当前落地：

- onboarding steps 覆盖 doctor、provider config、template project 和 report export。
- provider config page 固定内网 Anthropic-compatible endpoint 与 `kimi-for-coding`，API key 仍只走环境变量；`product-preview --provider-page` 可单独查看。
- doctor repair suggestions 会把 doctor warn/error 转换为 required/optional 修复动作。
- project templates 覆盖 counter、FSM、UART loopback、I2C skeleton；`product-template --id ... --output ...` 可生成 README、RTL、testbench 和 `verigen.json`。
- board profile management 以 mock profile list、programmer、clock/reset 和 smoke actions 进入 workbench model；`product-preview --profiles` 可单独查看。
- `verigen agent` 默认通过 `--extension` 加载内置 workbench extension；`createProductWorkbenchPiTuiMount()` 暴露 `@earendil-works/pi-tui` Component 适配契约；`@earendil-works/pi-verigen/coding-agent-extension` 和 `installVerigenCodingAgentExtension()` 可在 coding-agent `session_start`/`turn_end` 时挂入 below-editor widget，并注册 `/verigen-workbench show|hide|toggle|snapshot`。
- `exportProductReportMarkdown()` 输出可分享报告；`createProductReportArtifact()` 和 `product-preview --report --output <path>` 可生成落盘 Markdown artifact。
- report artifact 包含 onboarding、provider、layout、inspector snapshot、keybindings、release smoke 和 session replay。
- session replay 记录 onboarding、template、sim、board、report 和 TUI action 事件。

## S16：Real FPGA Validation

目标：真实 FPGA 设备到位后，把 S9/S10 的 backend 从 mock/dry-run 切换到真实工具链和板卡，而不重写产品层。

交付：

- 至少一个真实 board profile。
- 真实 vendor toolchain profile。
- 真实 programmer backend。
- 固定 `blink_led` 上板 smoke。
- UART/I2C loopback 或其他可观测 smoke。
- VeriGen 生成 RTL 的受控上板样例。
- 真实硬件日志、失败分类和报告导出。

验收：

- 固定 demo 在真实 FPGA 上 synth、bitstream、program、观测通过。
- 一个 VeriGen 生成的简单模块在真实 FPGA 上 smoke 通过。
- 真实 backend 复用 S9/S10 的 board/profile/report schema。

## 优先级建议

近期不要被真实 FPGA 设备阻塞。正确顺序是：

1. **S5 + S6 已完成 MVP**，TUI preview 和 ToolRunner 已有可观察、可调试的工程闭环。
2. 继续补齐 **S7 + S8** 的真实任务覆盖、trace 注入、agent runtime 映射和 TUI inspector 接入。
3. **S9 + S10 已完成 MVP**，硬件接口和 dry-run report 已稳定。
4. **S11-S15 已完成 MVP**，离线 TUI dogfood、dist 包面预检和 pack/install smoke plan 已接入；后续继续做交互式 TUI polish、真实 npm pack/install smoke 和发布权限确认。
5. 真实设备到位后做 **S16**，只替换 hardware backend，不重写产品层。
