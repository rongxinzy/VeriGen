# VeriGen 产品化路线图

本文档记录 S4 之后到产品化交付的路线图。目标不是继续堆底层能力，而是把 VeriGen 从“可安装的 Verilog 分析能力包”推进到“基于 pi agent harness 的 Verilog 特化 coding agent 产品”。

## 阶段判断

- **能演示**：需要做到 S10-S11。
- **能作为工程产品使用**：至少需要做到 S13。
- **成熟、美观、可交付的 TUI 工程界面**：建议规划到 **S15**。
- **真实 FPGA 验证**：不阻塞 S5-S15；没有设备时先做 mock/dry-run，设备到位后进入 **S16**。
- **生成质量探针**：从 S5 开始常驻执行 Codegen Quality Probe，先人工评审，S12 升级为正式评测体系。

当前状态：S0-S4 已完成。下一步从 S5 开始。

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

1. 先做 **S5 + S6**，让 TUI 和 ToolRunner 有可观察、可调试的工程闭环。
2. 再做 **S7 + S8**，让四 Agent 和上下文路由真正工作。
3. 然后做 **S9 + S10**，用 board profile 抽象和 mock/dry-run backend 固化硬件接口。
4. 继续做 **S11-S15**，进入发布、评测、成熟 TUI 和产品化交付。
5. 真实设备到位后做 **S16**，只替换 hardware backend，不重写产品层。
