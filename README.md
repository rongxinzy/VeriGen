# VeriGen

VeriGen 是一个基于 pi agent harness 改造的 Verilog 特化 coding agent。它的目标不是做通用代码助手，而是把自然语言规格转成可验证、可调试、可综合的 RTL 设计流程。

本仓库直接以 pi monorepo 为底座，在其 TypeScript agent runtime、CLI/TUI、tool calling、模型接入和扩展机制之上，加入 Verilog/RTL 专用能力：Spec-Anchored KG、Verilog Playbook、AST 波形追踪、Graphify 上下文导航，以及随 npm 分发的 Python Verilog analysis worker。

## 项目定位

VeriGen 面向 RTL 设计-验证-修复流水线：

```text
规格输入
  -> 模块契约 / 端口约束
  -> Spec-Anchored KG
  -> RTL 生成
  -> lint / sim / synth
  -> 仿真失败定位
  -> AST 波形追踪
  -> 定向修复
  -> 复验通过
```

核心原则：

- 验证优先：RTL 不是生成出来就结束，必须能被工具链验证。
- 结构化中间物：规格、KG、trace、修复建议都要机器可读。
- KG 锚定：用端口契约和模块关系约束生成，减少接口幻觉。
- 工程化知识：用 Verilog Playbook 和历史修复规则，而不是把原始规范全文塞进上下文。
- 精简 Agent：Planner、Coder、Verifier、Debugger 四角色，复杂度放在上下文和工具结果裁剪上。

## 当前状态

已完成到 S15 MVP：

- S0：验证魔改 `pyverilog` fork 可脱离 VerilogCoder/AutoGen 独立运行。
- S1：实现 Python Verilog analysis worker，提供私有 JSONL RPC。
- S2：实现 TypeScript `VerilogAnalysis` 客户端和仿真失败 trace helper。
- S3：迁移 Spec KG、Playbook RAG、Graphify context、VeriGen prompts 和 skill。
- S4：完成 npm 打包路径，Python worker 和魔改 `pyverilog` 随 npm tarball 分发，首次运行用 uv 自举受管 cache venv。
- S5：完成 VeriGen mode/profile、文本 trace panel、TUI preview、默认加载 workbench extension 的 `verigen agent` 和 Codegen Quality Probe 入口。
- S6：完成 EDA ToolRunner MVP，统一 `iverilog/vvp`、Verilator、Yosys、Himasim profile 和工具错误 schema，并让 Quality Probe 支持 `--run-tools` compile/sim。
- S7：新增 `quality-probe fix-loop` 初版，串起 Planner/Coder/Verifier/Debugger，最多 3 轮，记录修复轮次和失败类型。
- S8：新增统一 Context Router API，能裁剪 KG、Playbook、Graphify、trace 和 tool results，输出可注入 Coder/Debugger 的上下文 section。
- S9：新增 board profile/schema、mock programmer backend、`blink_led` 与 `uart_loopback` dry-run bring-up。
- S10：新增 dry-run hardware flow，把受控模板先送入 `iverilog/vvp` 仿真，再进入 mock board validate/synth/bitstream/program/observe report。
- S11：新增 release smoke checklist、quickstart、CI checklist 和示例工程清单。
- S12：新增 evaluation suite，记录 pass@1、3 轮收敛率、平均修复轮次和失败类型分布。
- S13-S15：新增 product workbench model、onboarding、provider config、project templates、board profile 管理、响应式 TUI 状态迁移、pi-tui Component 适配契约、layout persistence、报告导出和 session replay。

下一阶段是继续增强交互式产品 TUI polish，并在真实 FPGA 设备到位后进入 S16。完整产品化路线图见 [VeriGen 产品化路线图](docs/ROADMAP-VeriGen.md)。

## 架构

```text
VeriGen TypeScript 主体
  pi-coding-agent / pi-agent-core / pi-ai / pi-tui
  ├─ Planner / Coder / Verifier / Debugger prompts
  ├─ Spec-Anchored KG        (graphology + zod)
  ├─ Verilog Playbook RAG    (vectra)
  ├─ Graphify Context        (repo/docs context graph)
  ├─ Context Router          (裁剪 trace / graph / playbook 结果)
  └─ VerilogAnalysis client  (child_process + JSONL)

受管 Python Worker
  packages/verilog-analysis
  ├─ pyverilog 魔改 fork      (vendor/pyverilog)
  ├─ parse_ast
  ├─ build_controlflow
  ├─ trace_waveform
  └─ identify_seq_element

外部工具
  iverilog / vvp / verilator / yosys / himasim / FPGA vendor tools
```

波形追踪不做成模型随意调用的通用工具。它是仿真失败后的确定性步骤：Verifier 发现失败，编排器调用 trace，Context Router 裁剪结果，再交给 Debugger 生成修复建议。

Graphify 是例外：它默认启用，作为模型可自主调用的仓库/文档导航工具，用来决定“该读哪些文件、prompt、规则和设计文档”。它不替代 `pyverilog` 的 RTL 语义分析。

## 仓库结构

| 路径 | 说明 |
|---|---|
| `packages/coding-agent` | pi 原有交互式 coding agent CLI，VeriGen 产品入口会基于它继续改造 |
| `packages/agent` | pi agent runtime、tool calling、state 管理 |
| `packages/ai` | 多 provider LLM 接入 |
| `packages/tui` | 终端 UI 基础库 |
| `packages/verigen` | VeriGen TypeScript 垂直层：KG、RAG、Graphify、worker client、CLI |
| `packages/verilog-analysis` | Python Verilog analysis worker，含 vendored `pyverilog` fork |
| `.pi/prompts` | VeriGen Planner/Coder/Verifier/Debugger/System/ICL prompts |
| `.pi/skills` | VeriGen Playbook skill |
| `docs` | 产品设计、技术方案、handoff、S0 验证报告 |

## 运行依赖

基础依赖：

- Node.js `>=22.19.0`
- npm
- uv
- Python `>=3.11,<3.13`
- `iverilog`
- `vvp`

推荐后续接入：

- Verilator
- Yosys
- Himasim
- FPGA vendor tools，例如 Vivado、Quartus 或国产工具链

## 本地开发

安装依赖：

```bash
npm install --ignore-scripts
```

仓库门禁：

```bash
npm run check
```

VeriGen 子包测试：

```bash
cd packages/verigen
node --test test/*.test.ts
```

Python worker 本地运行：

```bash
cd packages/verilog-analysis
uv sync --frozen
uv run verigen-verilog-analysis
```

## CLI 预览

当前可预览的是 `verigen` CLI、S5 TUI preview、S6 ToolRunner 和 S15 product workbench TUI MVP。

从源码生成本地 npm tarball：

```bash
cd packages/verigen
npm pack --pack-destination /tmp/verigen-pack
```

临时安装：

```bash
rm -rf /tmp/verigen-preview /tmp/verigen-preview-cache
npm install -g --prefix /tmp/verigen-preview /tmp/verigen-pack/verigen-0.79.2.tgz --ignore-scripts
```

运行：

```bash
/tmp/verigen-preview/bin/verigen --help
VERIGEN_CACHE_DIR=/tmp/verigen-preview-cache /tmp/verigen-preview/bin/verigen doctor
VERIGEN_CACHE_DIR=/tmp/verigen-preview-cache /tmp/verigen-preview/bin/verigen worker-smoke
/tmp/verigen-preview/bin/verigen graphify-status
/tmp/verigen-preview/bin/verigen mode
/tmp/verigen-preview/bin/verigen agent --dry-run
/tmp/verigen-preview/bin/verigen trace-demo
/tmp/verigen-preview/bin/verigen tui-preview trace-demo
/tmp/verigen-preview/bin/verigen quality-probe list
/tmp/verigen-preview/bin/verigen quality-probe run --case l0-mux2 --live --run-tools
/tmp/verigen-preview/bin/verigen quality-probe fix-loop --case l0-mux2
/tmp/verigen-preview/bin/verigen board-smoke --smoke blink_led
/tmp/verigen-preview/bin/verigen hardware-flow --template blink_led
/tmp/verigen-preview/bin/verigen release-smoke
/tmp/verigen-preview/bin/verigen release-smoke --verify-local
/tmp/verigen-preview/bin/verigen release-smoke --verify-dist
/tmp/verigen-preview/bin/verigen release-smoke --pack-install-plan
/tmp/verigen-preview/bin/verigen eval-suite --suite smoke
/tmp/verigen-preview/bin/verigen product-preview --with-smoke
/tmp/verigen-preview/bin/verigen product-preview --with-smoke --tui
/tmp/verigen-preview/bin/verigen product-preview --provider-page
/tmp/verigen-preview/bin/verigen product-preview --profiles
/tmp/verigen-preview/bin/verigen product-template --id uart_loopback --output /tmp/verigen-uart-template
/tmp/verigen-preview/bin/verigen product-preview --report --output /tmp/verigen-preview-report.md
/tmp/verigen-preview/bin/verigen product-workbench
```

`worker-smoke` 成功表示 npm 包内 Python worker、vendored `pyverilog` 和 uv cache venv 已经跑通。

## Graphify

生成仓库上下文图：

```bash
uvx --from graphifyy graphify update . --no-cluster
```

查询：

```bash
verigen graphify-status --json
verigen graphify-query "waveform debugger trace" --json
verigen graphify-path docs/PDD-VeriGen.md packages/verigen/src/spec-kg.ts --json
```

缺少 `graphify-out/graph.json` 时，Graphify 命令会返回 `stale_or_missing_index`，这是可恢复状态，不阻断 worker 或 doctor。

## 测试 LLM 端点

Codegen Quality Probe 后续使用内网 Anthropic-compatible 端点测试 Verilog 生成质量：

```bash
export VERIGEN_TEST_LLM_PROVIDER=anthropic
export VERIGEN_TEST_LLM_BASE_URL=http://172.18.5.179:3000
export VERIGEN_TEST_LLM_MODEL=kimi-for-coding
export VERIGEN_TEST_LLM_API_KEY=<local-secret>
```

兼容实现如果要求 OpenAI 风格路径，可把 base URL 设为 `http://172.18.5.179:3000/v1`。API key 不应写入 README、docs、测试 fixture 或 commit。

运行一次 L0 小题生成：

```bash
verigen quality-probe run --case l0-mux2 --live
verigen quality-probe run --case l0-mux2 --live --run-tools
verigen tui-preview quality-probe --case l0-mux2 --live
```

`--run-tools` 会用 S6 ToolRunner 对生成 RTL 执行 `iverilog/vvp` compile/sim，返回结构化 tool result。Verilator lint、Yosys synth 和 Himasim profile 已有统一结果 schema；缺工具时返回 `missing_tool`。

运行一次 S7 fix loop：

```bash
verigen quality-probe fix-loop --case l0-mux2
verigen quality-probe fix-loop --case l0-mux2 --live
```

默认 dry-run 会用脚本化候选 RTL 先制造一次仿真失败，再由 Debugger repair prompt 驱动下一轮修复，用于验证四 Agent 闭环和 report schema。`--live` 会把每轮 Coder prompt 发给配置的 Anthropic-compatible endpoint。

## VeriGen Agent 入口

S5 新增 `verigen agent` 作为进入 pi coding-agent 的 VeriGen 专属入口。它会加载：

- `verigen-system.md` 作为 system prompt
- `verigen-planner/coder/verifier/debugger/icl.md` 作为 prompt templates
- `verigen-playbook.md` 作为 skill

预览实际启动参数：

```bash
verigen agent --dry-run
```

运行时会委托给原 `pi` CLI，因此保留 pi 的交互式对话、工具调用、会话和 TUI 基础能力。

## npm 分发策略

`verigen` 发布时包含：

- TypeScript 编译产物
- `verigen` CLI
- `.pi` prompts / skills 资产
- Python worker 源码
- `vendor/pyverilog` 魔改 fork

不包含：

- `.venv`
- wheelhouse
- Python cache
- Dockerfile
- PyPI 上的 VeriGen 私有 worker 包

首次运行时，CLI 使用 `uv` 从 npm 包内本地路径安装 worker 到受管 cache venv。第三方 Python 依赖从 PyPI 安装，`pyverilog==1.3.0+verigen` 从本地 `vendor/pyverilog` 安装。

## 当前边界

- 已有 VeriGen 专属 TUI 产品界面 MVP：`product-preview --tui`、`product-workbench` 和默认挂入 `verigen agent` 的 workbench extension。后续仍需继续视觉 polish 和更深的 agent runtime 接入。
- 还没有接真实 FPGA 上板流程；无设备阶段先做 mock/dry-run board backend。
- 还没有把 Himasim/Vivado/Quartus/Yosys profile 做成完整 board profile。
- S6 已证明 npm 安装路径、worker smoke、Graphify 查询、doctor、trace demo、ToolRunner sim 和 Quality Probe `--run-tools` 可用。
- S7 初版已证明 Quality Probe 能进入最多 3 轮 fix loop，并记录失败类型、修复轮次和最终 RTL。
- S8 初版已证明 KG、Playbook、Graphify、trace 和 tool results 可以按预算合并成统一上下文，不把 raw graph/raw VCD 全量注入模型。
- S9 已证明固定 `blink_led` 和 `uart_loopback` 能在 mock backend 中完成 validate、synth、bitstream、program、observe dry-run，并输出结构化 report。
- S10 已证明受控模板能先真实仿真通过，再进入 mock board dry-run hardware report。
- S11-S15 已证明 release checklist、本地 release smoke verifier、built dist 包面预检、pack/install smoke plan、评测指标、产品 workbench TUI preview、onboarding、provider config page、doctor repair suggestions、project template scaffold、profile management、轻量交互 TUI、pi-tui Component 适配契约、coding-agent extension 挂载入口、TUI action replay、响应式布局、layout persistence、Markdown report artifact、报告导出和 session replay 均可结构化输出。
- 当前产品 TUI 是响应式终端 workbench 状态模型：宽屏三栏、中等宽度双栏、窄终端堆叠，已支持 `product-workbench` 交互入口、焦点、inspector 切换和 density toggle。`verigen agent` 默认把内置 workbench extension 传给 pi；外部也可通过 `verigen/coding-agent-extension` 或 `installVerigenCodingAgentExtension()` 挂入 coding-agent widget/custom message renderer。离线 TUI dogfood 已验证首屏能加载 extension 并渲染 workbench；后续继续视觉 polish。
- 真实 FPGA 测试放到 S16，应从固定 `blink_led` bring-up 开始，再接 VeriGen 生成 RTL。

## 文档

- [产品设计文档](docs/PDD-VeriGen.md)
- [产品化路线图](docs/ROADMAP-VeriGen.md)
- [技术改造文档](docs/TECH-VerilogCoder-Integration.md)
- [交接文档](docs/HANDOFF.md)
- [S0 可行性报告](docs/S0-Feasibility-Report.md)

## License

MIT
