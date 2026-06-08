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

已完成到 S4：

- S0：验证魔改 `pyverilog` fork 可脱离 VerilogCoder/AutoGen 独立运行。
- S1：实现 Python Verilog analysis worker，提供私有 JSONL RPC。
- S2：实现 TypeScript `VerilogAnalysis` 客户端和仿真失败 trace helper。
- S3：迁移 Spec KG、Playbook RAG、Graphify context、VeriGen prompts 和 skill。
- S4：完成 npm 打包路径，Python worker 和魔改 `pyverilog` 随 npm tarball 分发，首次运行用 uv 自举受管 cache venv。

下一阶段是 S5：把 VeriGen 能力接入正式产品入口，包括 TUI/CLI 流程、Codegen Quality Probe、EDA ToolRunner、mock/dry-run board profile、发布与产品化流程。没有真实 FPGA 设备时不阻塞 S5-S15；真实设备验证单独放到 S16。完整产品化路线图见 [VeriGen 产品化路线图](docs/ROADMAP-VeriGen.md)。

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

当前 S4 可预览的是 `verigen` CLI，而不是完整产品 TUI。

从源码生成本地 npm tarball：

```bash
cd packages/verigen
npm pack --pack-destination /tmp/verigen-pack
```

临时安装：

```bash
rm -rf /tmp/verigen-preview /tmp/verigen-preview-cache
npm install -g --prefix /tmp/verigen-preview /tmp/verigen-pack/earendil-works-pi-verigen-0.78.1.tgz --ignore-scripts
```

运行：

```bash
/tmp/verigen-preview/bin/verigen --help
VERIGEN_CACHE_DIR=/tmp/verigen-preview-cache /tmp/verigen-preview/bin/verigen doctor
VERIGEN_CACHE_DIR=/tmp/verigen-preview-cache /tmp/verigen-preview/bin/verigen worker-smoke
/tmp/verigen-preview/bin/verigen graphify-status
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

## npm 分发策略

`@earendil-works/pi-verigen` 发布时包含：

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

- 还没有完成 VeriGen 专属 TUI 产品界面。
- 还没有接真实 FPGA 上板流程；无设备阶段先做 mock/dry-run board backend。
- 还没有把 Himasim/Vivado/Quartus/Yosys profile 做成完整 board profile。
- S4 已证明 npm 安装、自举、worker smoke、Graphify 查询和 doctor 可用。
- 真实 FPGA 测试放到 S16，应从固定 `blink_led` bring-up 开始，再接 VeriGen 生成 RTL。

## 文档

- [产品设计文档](docs/PDD-VeriGen.md)
- [产品化路线图](docs/ROADMAP-VeriGen.md)
- [技术改造文档](docs/TECH-VerilogCoder-Integration.md)
- [交接文档](docs/HANDOFF.md)
- [S0 可行性报告](docs/S0-Feasibility-Report.md)

## License

MIT
