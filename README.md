# VeriGen

VeriGen 是一个基于 pi agent harness 改造的 Verilog 特化 coding agent。它的目标不是做通用代码助手，而是把自然语言规格转成**可验证、可调试、可综合**的 RTL 设计流程。

本仓库以 pi monorepo 为底座，在其 TypeScript agent runtime、CLI/TUI、tool calling、模型接入和扩展机制之上，加入 Verilog/RTL 专用能力：

- **Spec-Anchored KG**：用端口契约和模块关系约束生成，减少接口幻觉
- **Verilog Playbook RAG**：沉淀工程化知识和历史修复规则
- **AST 波形追踪**：仿真失败后的确定性定位步骤
- **Graphify 上下文导航**：模型可自主调用的仓库/文档导航
- **随 npm 分发的 Python Verilog analysis worker**：基于魔改 `pyverilog` fork

## 工作流程

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

- **验证优先**：RTL 不是生成出来就结束，必须能被工具链验证。
- **结构化中间物**：规格、KG、trace、修复建议都要机器可读。
- **KG 锚定**：用端口契约和模块关系约束生成，减少接口幻觉。
- **工程化知识**：用 Verilog Playbook 和历史修复规则，而不是把原始规范全文塞进上下文。
- **极简常驻上下文**：启动时只常驻 VeriGen system prompt 和 extension；Planner、Coder、Verifier、Debugger 与 Playbook 规则按需注入。

## 架构

```text
VeriGen TypeScript 主体
  pi-coding-agent / pi-agent-core / pi-ai / pi-tui
  ├─ Minimal system prompt + on-demand Planner/Coder/Verifier/Debugger context
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

两条设计约定：

- **波形追踪不是通用工具**。它是仿真失败后的确定性步骤：Verifier 发现失败，编排器调用 trace，Context Router 裁剪结果，再交给 Debugger 生成修复建议。
- **Graphify 是例外**。它默认启用，作为模型可自主调用的仓库/文档导航工具，用来决定"该读哪些文件、prompt、规则和设计文档"。它不替代 `pyverilog` 的 RTL 语义分析。

## 快速开始

### 运行依赖

基础依赖：

- Node.js `>=22.19.0` 和 npm
- uv
- Python `>=3.11,<3.13`
- `iverilog` / `vvp`

推荐后续接入：Verilator、Yosys、Himasim，以及 FPGA vendor tools（Vivado、Quartus 或国产工具链）。

### 安装

Windows PowerShell 一键安装：

```powershell
irm https://raw.githubusercontent.com/rongxinzy/VeriGen/main/packages/verigen/install.ps1 | iex
```

该脚本会检测 Node.js/npm 版本、提示安装 Git Bash、通过 `https://registry.npmmirror.com` 安装 npm 包，并提前用包内 bundled `uv` 创建 Python worker venv 和依赖。若 Node.js/npm 缺失或版本不满足，脚本会输出 Chocolatey + Node.js `24.16.0` 安装命令。

通用 npm 安装：

```bash
npm install -g verigen@latest

verigen doctor          # 环境诊断
verigen worker-smoke    # 验证 Python worker 可用
verigen agent           # 进入 VeriGen agent
```

安装脚本会提前创建 Python worker cache venv；如果预热失败，首次运行时 CLI 仍会用包内 bundled `uv` 把包内 Python worker 自举到受管 cache venv，无需手动配置 Python 环境（详见 [npm 分发策略](#npm-分发策略)）。

### 本地开发

```bash
# 安装依赖
npm install --ignore-scripts

# 仓库门禁
npm run check

# VeriGen 子包测试
cd packages/verigen
node --test test/*.test.ts

# Python worker 本地运行
cd packages/verilog-analysis
uv sync --frozen
uv run verigen-verilog-analysis
```

### 从源码预览 CLI

```bash
# 生成本地 npm tarball
cd packages/verigen
npm pack --pack-destination /tmp/verigen-pack

# 临时安装
rm -rf /tmp/verigen-preview /tmp/verigen-preview-cache
npm install -g --prefix /tmp/verigen-preview /tmp/verigen-pack/verigen-0.79.2.tgz --ignore-scripts

# 验证安装
/tmp/verigen-preview/bin/verigen --help
VERIGEN_CACHE_DIR=/tmp/verigen-preview-cache /tmp/verigen-preview/bin/verigen doctor
VERIGEN_CACHE_DIR=/tmp/verigen-preview-cache /tmp/verigen-preview/bin/verigen worker-smoke
```

`worker-smoke` 成功表示 npm 包内 Python worker、vendored `pyverilog` 和 uv cache venv 已经跑通。

## CLI 功能一览

以下按功能分组（省略安装前缀路径）：

```bash
# Agent 入口与模式
verigen agent --dry-run            # 预览 VeriGen 专属 agent 启动参数
verigen mode                       # 查看 VeriGen mode/profile

# 诊断与冒烟
verigen doctor                     # 环境诊断（含修复建议）
verigen worker-smoke               # Python worker 冒烟
verigen release-smoke              # release checklist
verigen release-smoke --verify-local | --verify-dist | --pack-install-plan

# 质量评测
verigen quality-probe list
verigen quality-probe run --case l0-mux2 --live --run-tools
verigen quality-probe fix-loop --case l0-mux2
verigen eval-suite --suite smoke   # pass@1、收敛率、修复轮次等指标

# 波形追踪与 TUI
verigen trace-demo
verigen tui-preview trace-demo
verigen tui-preview quality-probe --case l0-mux2 --live

# Graphify
verigen graphify-status
verigen graphify-query "waveform debugger trace" --json
verigen graphify-path docs/PDD-VeriGen.md packages/verigen/src/spec-kg.ts --json

# 板级流程（mock/dry-run）
verigen board-smoke --smoke blink_led
verigen hardware-flow --template blink_led

# 状态面板 / dogfood workbench
verigen product-workbench                 # 内部 dogfood/debug dashboard
verigen product-preview --with-smoke [--tui]
verigen product-preview --provider-page | --profiles
verigen product-preview --report --output /tmp/verigen-preview-report.md
verigen product-template --id uart_loopback --output /tmp/verigen-uart-template
```

### VeriGen Agent 入口

`verigen agent` 是进入 pi coding-agent 的 VeriGen 专属入口。它会加载：

- `verigen-system.md` 作为 system prompt
- VeriGen extension，提供模型配置、Graphify 工具、状态面板和按需上下文命令

它不会在启动时把 Planner/Coder/Verifier/Debugger prompt 或完整 Playbook skill 注入 system/context。需要专家 phase 时，在 TUI 内运行：

```text
/verigen-phase planner|coder|verifier|debugger [task]
/verigen-rules <query>
```

对明显的 RTL/Verilog 任务，extension 会在模型调用前自动注入一个小型 phase/rule 上下文；`/verigen-phase` 用于显式指定或覆盖 phase，`/verigen-rules` 只检索并注入相关规则。

运行时委托给原 `pi` CLI，因此保留 pi 的交互式对话、工具调用、会话、输入框和 `/` 指令引用手感。默认会加载内置 VeriGen extension，但不会展示完整 workbench；只有无可用模型等关键状态，或用户显式运行 `/verigen-workbench show` 时，才会在 editor 下方显示只读状态面板。该面板默认只显示模型状态、Python/uv 状态、当前任务、最近问题和下一步命令；`/verigen-workbench details` 才展开 logs、replay、board 和 report 摘要。外部也可通过 `verigen/coding-agent-extension` 或 `installVerigenCodingAgentExtension()` 挂入 coding-agent widget/custom message renderer。

### Graphify

生成仓库上下文图：

```bash
uvx --from graphifyy graphify update . --no-cluster
```

缺少 `graphify-out/graph.json` 时，Graphify 命令会返回 `stale_or_missing_index`，这是可恢复状态，不阻断 worker 或 doctor。

### 测试 LLM 端点

Codegen Quality Probe 使用内网 Anthropic-compatible 端点测试 Verilog 生成质量：

```bash
export VERIGEN_TEST_LLM_PROVIDER=anthropic
export VERIGEN_TEST_LLM_BASE_URL=http://<internal-host>:3000
export VERIGEN_TEST_LLM_MODEL=<model-id>
export VERIGEN_TEST_LLM_API_KEY=<local-secret>
```

兼容实现如果要求 OpenAI 风格路径，可把 base URL 加上 `/v1` 后缀。**API key 不应写入 README、docs、测试 fixture 或 commit。**

- `quality-probe run --live` 把 Coder prompt 发给配置的端点；`--run-tools` 用 ToolRunner 对生成 RTL 执行 `iverilog/vvp` compile/sim，返回结构化 tool result。Verilator lint、Yosys synth 和 Himasim profile 已有统一结果 schema；缺工具时返回 `missing_tool`。
- `quality-probe fix-loop` 串起 Planner/Coder/Verifier/Debugger 四 Agent，最多 3 轮。默认 dry-run 用脚本化候选 RTL 先制造一次仿真失败，再由 Debugger repair prompt 驱动下一轮修复；`--live` 把每轮 Coder prompt 发给配置端点。

## 仓库结构

| 路径 | 说明 |
|---|---|
| `packages/coding-agent` | pi 原有交互式 coding agent CLI，VeriGen 产品入口基于它改造 |
| `packages/agent` | pi agent runtime、tool calling、state 管理 |
| `packages/ai` | 多 provider LLM 接入 |
| `packages/tui` | 终端 UI 基础库 |
| `packages/verigen` | VeriGen TypeScript 垂直层：KG、RAG、Graphify、worker client、CLI |
| `packages/verilog-analysis` | Python Verilog analysis worker，含 vendored `pyverilog` fork |
| `.pi/prompts` | VeriGen System prompt 与按需 Planner/Coder/Verifier/Debugger/ICL prompts |
| `.pi/skills` | VeriGen Playbook rule pack |
| `docs` | 产品设计、技术方案、handoff、S0 验证报告 |

## npm 分发策略

`verigen` 发布时包含 TypeScript 编译产物、`verigen` CLI、`.pi` prompt/rule 资产、Python worker 源码和 `vendor/pyverilog` 魔改 fork；不包含 `.venv`、wheelhouse、Python cache、Dockerfile 或 PyPI 私有包。

首次运行时，CLI 使用 `uv` 从 npm 包内本地路径安装 worker 到受管 cache venv。第三方 Python 依赖从 PyPI 安装，`pyverilog==1.3.0+verigen` 从本地 `vendor/pyverilog` 安装。

## 项目状态

已完成 S0–S15 MVP，覆盖：

- **基础设施（S0–S4）**：魔改 `pyverilog` fork 独立运行、Python analysis worker（JSONL RPC）、TypeScript 客户端、Spec KG / Playbook RAG / Graphify 迁移、npm 打包与 uv 自举。
- **Agent 闭环（S5–S8）**：VeriGen mode/profile 与 `verigen agent` 入口、EDA ToolRunner（`iverilog/vvp`、Verilator、Yosys、Himasim 统一 schema）、Quality Probe fix-loop（四 Agent、最多 3 轮）、统一 Context Router（按预算裁剪 KG/Playbook/Graphify/trace/tool results）。
- **板级与评测（S9–S12）**：board profile/schema、mock programmer backend、dry-run hardware flow（先真实仿真再 mock 上板）、release smoke checklist、evaluation suite（pass@1、3 轮收敛率、失败类型分布）。
- **产品化（S13–S15）**：agent 内按需 VeriGen 状态面板、内部 dogfood/debug product workbench TUI、onboarding、provider config、project templates、board profile 管理、layout persistence、报告导出和 session replay。

当前边界：

- 还没有接真实 FPGA 上板流程；无设备阶段先做 mock/dry-run board backend。真实 FPGA 测试放到 S16，应从固定 `blink_led` bring-up 开始，再接 VeriGen 生成 RTL。
- 还没有把 Himasim/Vivado/Quartus/Yosys profile 做成完整 board profile。
- `product-workbench` 是内部 dogfood/debug 入口，不作为默认用户 TUI 形态；主体验保持 pi 的 chat-first 输入框和 `/` 指令引用。

各阶段完整交付物和下一步计划见 [VeriGen 产品化路线图](docs/ROADMAP-VeriGen.md)。

## 文档

- [产品设计文档](docs/PDD-VeriGen.md)
- [产品化路线图](docs/ROADMAP-VeriGen.md)
- [技术改造文档](docs/TECH-VerilogCoder-Integration.md)
- [交接文档](docs/HANDOFF.md)
- [S0 可行性报告](docs/S0-Feasibility-Report.md)

## License

MIT
