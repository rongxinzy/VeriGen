# VeriGen

`@earendil-works/pi-verigen` 是 VeriGen 的 TypeScript 垂直能力包，用于把 Verilog RTL 生成、验证、调试所需的结构化能力接入 pi agent harness。

它不是完整的 FPGA IDE，也不是单纯的 Verilog 代码补全工具。当前包提供到 S15 MVP：CLI、Graphify 仓库上下文导航、Spec KG、Playbook RAG、随 npm 包分发的 Python Verilog analysis worker、VeriGen mode/TUI preview、Codegen Quality Probe、EDA ToolRunner、初版四 Agent 修复闭环、统一 Context Router、mock board profile/bring-up、dry-run hardware flow、release smoke、evaluation suite 和 product workbench preview。

## 能力范围

- `VerilogAnalysis`：常驻 Python worker 客户端，使用私有 JSONL 协议调用 Verilog 分析能力。
- `traceSimulationFailure`：在仿真失败后确定性调用波形追踪，生成 Debugger 可用的结构化上下文。
- `SpecAnchoredKnowledgeGraph`：用 Graphology 存储模块、端口、信号、状态、约束和任务关系。
- `PlaybookRag`：用 Vectra 索引 Verilog 修复规则和工程化 Playbook。
- `GraphifyContext`：默认启用的仓库/文档上下文图查询层，支持 `status`、`query`、`explain`、`path` 和受控 `update`。
- `verigen` CLI：提供安装自检、worker smoke test、Graphify 查询、VeriGen agent 入口、trace panel、TUI preview、Quality Probe 和 ToolRunner 命令。

## 安装

未来发布到 npm 后：

```bash
npm install -g @earendil-works/pi-verigen
```

本地预览 tarball：

```bash
cd packages/verigen
npm pack --pack-destination /tmp/verigen-pack
npm install -g --prefix /tmp/verigen-preview /tmp/verigen-pack/earendil-works-pi-verigen-0.78.1.tgz --ignore-scripts
/tmp/verigen-preview/bin/verigen --help
```

## 运行依赖

必须在 `PATH` 中可用：

- Node.js `>=22.19.0`
- `uv`
- `iverilog`
- `vvp`

Python worker 会在首次运行时由 `uv` 自动创建 cache venv。npm 包内自带 worker 源码和魔改 `pyverilog` fork；`ply`、`jinja2`、`networkx`、`numpy`、`pandas`、`vcdvcd` 等第三方 Python 依赖从 PyPI 安装。

不需要 Docker，也不会发布 VeriGen 自己的 Python worker 到 PyPI。

## CLI

```bash
verigen --help
verigen agent --dry-run
verigen agent
verigen mode
verigen doctor
verigen worker-smoke
verigen trace-demo
verigen trace-panel --rtl buggy.v --vcd wave.vcd --mismatch out --top TopModule
verigen tui-preview trace-demo
verigen tool-runner sim --rtl dut.v --tb tb.v --top tb --json
verigen tool-runner lint --rtl dut.v --top dut --json
verigen tool-runner synth --rtl dut.v --top dut --json
verigen tool-runner himasim --json
verigen quality-probe list
verigen quality-probe run --case l0-mux2 --live
verigen quality-probe run --case l0-mux2 --live --run-tools
verigen quality-probe fix-loop --case l0-mux2
verigen quality-probe fix-loop --case l0-mux2 --live
verigen board-smoke --smoke blink_led
verigen board-smoke --smoke uart_loopback --json
verigen hardware-flow --template blink_led
verigen hardware-flow --template uart_loopback --json
verigen release-smoke
verigen release-smoke --verify-local
verigen release-smoke --verify-dist
verigen release-smoke --pack-install-plan
verigen eval-suite --suite smoke
verigen product-preview --with-smoke
verigen product-preview --with-smoke --tui
verigen product-preview --with-smoke --report
verigen tui-preview quality-probe --case l0-mux2 --live
verigen graphify-status
verigen graphify-query "coder prompt"
verigen graphify-explain .pi/prompts/verigen-coder.md
verigen graphify-path docs/PDD-VeriGen.md packages/verigen/src/spec-kg.ts
verigen graphify-update
```

常用检查：

```bash
verigen doctor
verigen worker-smoke --json
```

`doctor` 会检查 Node、uv、`iverilog`、`vvp`、Verilator、Yosys、Himasim、npm 包内 Python worker、受管 venv 和 Graphify 索引状态。Graphify、Verilator、Yosys、Himasim 缺失时是 warning，不阻断 Verilog worker。

## S5 VeriGen Mode

S5 新增的是可被后续正式 TUI 消费的垂直入口：

- `verigen agent`：加载 VeriGen system prompt、prompt templates 和 playbook skill 后委托给原 pi coding-agent，保留对话流和工具调用能力。
- `verigen mode`：输出 VeriGen profile 和 `spec -> plan -> rtl -> sim -> trace -> fix -> report` 阶段。
- `verigen trace-demo`：生成固定失败 RTL/VCD，调用 `traceSimulationFailure`，输出文本版 trace panel。
- `verigen trace-panel`：对用户提供的 RTL/VCD 输出同样的 trace panel。
- `verigen tui-preview`：把 trace panel 或 Quality Probe 结果渲染成 S5 TUI 预览快照。
- `verigen quality-probe`：列出或运行 L0/L1 Codegen Quality Probe 小题。

## S6 EDA ToolRunner

S6 已新增统一 EDA ToolRunner：

- `iverilog-vvp`：compile + simulation。
- `verilator-lint`：Verilator lint profile。
- `yosys-synth`：Yosys synth/check profile。
- `himasim`：Himasim backend placeholder/profile，未安装时返回 `missing_tool`。

统一输出 schema 包含：

- `compile_error`
- `sim_fail`
- `width_warning`
- `synth_fail`
- `missing_tool`

错误会尽量带上 file、line、column 和源码 snippet，供 Verifier/Debugger 消费。

`quality-probe run --live` 会读取当前目录 `.env` 或环境变量：

```bash
VERIGEN_TEST_LLM_PROVIDER=anthropic
VERIGEN_TEST_LLM_BASE_URL=http://172.18.5.179:3000
VERIGEN_TEST_LLM_MODEL=kimi-for-coding
VERIGEN_TEST_LLM_API_KEY=<local-secret>
```

加上 `--run-tools` 后，Quality Probe 会把生成 RTL 写入临时工程并运行 `iverilog/vvp` compile/sim。

## S7 Fix Loop MVP

S7 初版新增 `quality-probe fix-loop`：

- Planner：从 Quality Probe case 生成 module contract 和 KG seed。
- Coder：生成候选 RTL；默认 dry-run 使用脚本化候选，`--live` 使用配置的 LLM endpoint。
- Verifier：运行 S6 `iverilog/vvp` compile/sim。
- Debugger：根据 `compile_error`、`sim_fail`、`missing_tool` 等失败类型生成 repair prompt。
- 最多 3 轮，输出结构化 report，记录 `repairRounds`、每轮失败类型、Verifier 结果和最终 RTL。

## S8 Context Router MVP

S8 初版新增 `buildVerigenRoutedContext`：

- KG：按 seed 取相关子图并限制节点数。
- Playbook：按任务和 trigger 检索规则并限制条数。
- Graphify：只注入 query 命中的节点摘要，不注入 raw graph。
- Trace：注入裁剪后的 mismatch、controller、waveform window 和 RTL snippet。
- Tool results：注入结构化 issue 摘要并限制 issue 数。
- 统一 `maxTotalChars` / `maxSectionChars` / per-source limit，输出 section list、rendered context 和 omission 统计。

## S9 Mock Board Profile

S9 新增 `board-smoke` 和 mock board schema：

- board profile：FPGA part、clock、reset、pin constraints、programmer profile。
- constraints：pin、direction、IO standard、bank、voltage。
- programmer interface：validate、synth、bitstream、program、observe。
- mock backend：只做 dry-run，不访问真实硬件。
- smoke：`blink_led` 和 `uart_loopback`。

```bash
verigen board-smoke --smoke blink_led
verigen board-smoke --smoke uart_loopback --json
```

输出 report 与未来真实 FPGA backend 保持同一类结构：steps、commands、artifacts、observations、issues。

## S10 Dry-run Hardware Flow

S10 新增 `hardware-flow`：

- 只允许受控模板：`blink_led`、`uart_loopback`。
- 先用 S6 ToolRunner 执行 `iverilog/vvp` 仿真。
- 仿真通过后进入 S9 mock board validate/synth/bitstream/program/observe。
- 输出统一 report：`simResult`、`boardReport`、`issues`。

```bash
verigen hardware-flow --template blink_led
verigen hardware-flow --template uart_loopback --json
```

## S11-S15 Productization MVP

新增产品化命令：

- `release-smoke`：输出 quickstart、release smoke、CI checklist、example projects 和发布 blockers。
- `eval-suite`：运行 S12 smoke/roadmap 评测，输出 pass@1、3 轮收敛率、平均修复轮次和失败类型分布。
- `product-preview`：输出 S13-S15 workbench model，包含 onboarding、provider config、project templates、board profiles、inspector tabs、session replay、响应式 TUI layout 和 report export。
- `product-template`：把 S15 project template scaffold 到本地目录，包含 README、RTL、testbench 和 `verigen.json`。

```bash
verigen release-smoke --json
verigen release-smoke --verify-local
verigen release-smoke --verify-dist --json
verigen release-smoke --pack-install-plan
verigen eval-suite --suite smoke --json
verigen product-preview --with-smoke
verigen product-preview --with-smoke --tui
verigen product-preview --interactive
verigen product-workbench
verigen product-preview --provider-page
verigen product-preview --profiles
verigen product-template --id uart_loopback --output ./examples/uart_loopback
verigen product-preview --with-smoke --tui --action focus-left,toggle-density
verigen product-preview --show-layout
verigen product-preview --with-smoke --report
verigen product-preview --report --output ./verigen-product-report.md
```

`release-smoke --verify-local` 会检查 npm package manifest、`verigen` bin、`files` whitelist、prepack hook、pi coding-agent/pi-tui 依赖、`./coding-agent-extension` 子路径导出、S15 workbench extension 入口、`verigen agent` 默认 extension 加载、Python worker 源码、vendored pyverilog fork，以及不要求 Docker 的安装边界。`release-smoke --verify-dist` 会检查已 build 的 `dist` 包面：CLI/API 入口、coding-agent extension、agent extension wiring、Python worker、vendored pyverilog、VeriGen prompt assets 和 skill assets。`release-smoke --pack-install-plan` 只输出真实 pack/install smoke 的命令清单，不运行 build、pack、install 或 publish，也不处理 npm 认证。真正 pack/install smoke 仍需发布前显式执行。

当前 product workbench 是响应式终端 TUI preview/model，并提供 `product-workbench` 轻量交互入口。它在宽屏渲染三栏，在中等宽度渲染双栏，在窄终端堆叠关键面板；包含 pipeline navigator、task log/session replay、inspector tabs、keybindings、焦点状态、inspector 切换、density toggle、layout 序列化/恢复、provider config page、board profile management、doctor repair suggestions、project template scaffold 和 report export。`verigen agent` 默认传入内置 workbench extension；`createProductWorkbenchPiTuiMount()` 暴露了 `@earendil-works/pi-tui` Component 适配契约；`@earendil-works/pi-verigen/coding-agent-extension` 和 `installVerigenCodingAgentExtension()` 会在 coding-agent `session_start`/`turn_end` 时把 workbench 挂到 editor 下方，并注册 `/verigen-workbench show|hide|toggle|snapshot`。`product-preview --report --output <path>` 会生成可分享 Markdown artifact，包含 onboarding、provider、layout、inspector snapshot、keybindings、release smoke 和 session replay。离线 TUI dogfood 已验证首屏能加载 extension 并渲染 workbench；后续继续视觉 polish。

## Python Worker 分发方式

S4 的分发策略是：

- npm tarball 包含 `dist/python/verilog-analysis`。
- `dist/python/verilog-analysis/vendor/pyverilog` 是魔改 pyverilog fork。
- 首次运行时，CLI 从 npm 包内本地路径安装 worker 到 uv cache venv。
- `pyverilog==1.3.0+verigen` 从本地 `vendor/pyverilog` 安装，不依赖 PyPI 官方 `pyverilog`。
- `.venv`、wheelhouse、Python cache、`__pycache__` 和 pyc/pyo 不进入 npm tarball。

可用环境变量：

```bash
VERIGEN_CACHE_DIR=/tmp/verigen-cache verigen worker-smoke
VERIGEN_SKIP_PYTHON_BOOTSTRAP=1 verigen doctor
```

`VERIGEN_SKIP_PYTHON_BOOTSTRAP=1` 用于跳过自动创建 venv，适合只做诊断或由外部系统预先准备 Python 环境。

## Graphify

Graphify 默认启用，但独立于 Verilog analysis worker。它用于仓库/文档级上下文导航，不替代 pyverilog 的 RTL AST、控制流和波形追踪。

生成或更新索引：

```bash
uvx --from graphifyy graphify update . --no-cluster
```

查询状态：

```bash
verigen graphify-status --json
verigen graphify-query "debugger waveform trace" --json
```

如果 `graphify-out/graph.json` 不存在，CLI 会返回 `stale_or_missing_index`，由上层 agent 自主决定是否触发更新。

## TypeScript API

```ts
import {
	GraphifyContext,
	SpecAnchoredKnowledgeGraph,
	VerilogAnalysis,
	traceSimulationFailure,
} from "@earendil-works/pi-verigen";

const worker = new VerilogAnalysis();
const ast = await worker.parseAst({
	rtl: "module TopModule(input wire a, output wire y); assign y = a; endmodule",
	top: "TopModule",
});
await worker.close();
```

默认情况下，`new VerilogAnalysis()` 会自动查找 npm 包内 worker 并完成 uv cache venv bootstrap。

## 开发

```bash
cd packages/verigen
node --test test/*.test.ts
```

仓库根目录门禁：

```bash
npm run check
```

打包验证：

```bash
cd packages/verigen
verigen release-smoke --verify-local
verigen release-smoke --pack-install-plan
# npm run build 或 npm pack 的 prepack 生成 dist 后再执行
verigen release-smoke --verify-dist
npm pack --pack-destination /tmp/verigen-pack
```

## 边界

- 当前包不直接提供完整 FPGA 上板流程。
- 当前包不把波形追踪暴露为模型随意调用的通用工具；它应由编排器在仿真失败后确定性调用。
- Graphify 只做仓库/文档导航，不做 Verilog 语义分析。
- 魔改 pyverilog fork 必须随 npm 包 vendor 分发，不要改成“先安装官方 pyverilog 再覆盖文件”的补丁链。
