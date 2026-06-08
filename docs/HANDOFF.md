# VeriGen 交接文档（Handoff）

> 给接手的 agent：本文件自包含，**不依赖任何历史对话**。读完即可独立推进。先读本文件，再读引用到的两份设计文档，然后从 §6「下一步」开始动手。

---

## 0. TL;DR（30 秒）

- **做什么**：把 VerilogCoder（Python/AutoGen）的核心能力——尤其是 **AST 波形追踪调试**——融入 VeriGen（基于 **pi** 的 TypeScript agent harness），做成一个 Verilog RTL「设计-验证-修复流水线 Agent」。参赛创客中国华大九天赛题。
- **现状**：S0 可行性验证、**S1 Python Worker**、**S2 TS 接入层**、**S3 TS 主体迁移** 与 **S4 npm 打包** 已完成。`packages/verigen` 现在包含 worker client、Spec KG、Playbook RAG、Graphify 默认上下文工具层、npm CLI、Python worker bootstrap 与 doctor。
- **下一步**：进入 S5 产品接入与发布准备：把 `verigen` CLI/TUI 接入正式 pi 分发入口、补生产级用户文档、确认 npm 发布权限与 tag 策略。
- **四条已锁定的硬决策**（不要推翻，除非有充分新证据）：
  1. **混合架构**：TS 主体 + 受管 Python Worker。
  2. **Worker 随 npm vendor + uv 受管环境**，唯一无 TS 平替的硬依赖是 **pyverilog**。
  3. **Python Worker 不用 MCP**：用源码内嵌的私有 JSON-stdio 协议，由编排器确定性调用。
  4. **Graphify 默认启用**：作为模型可自主调用的仓库/文档上下文导航工具；不替代 Spec KG 或 pyverilog RTL 语义分析。

---

## 1. 代码与文档位置

| 内容 | 路径 |
|---|---|
| VeriGen 主仓库（pi fork，TS monorepo） | `~/workspace/VeriGen`（当前工作目录，git 仓库，分支 `main`） |
| VerilogCoder 源码（待吸收，**只读参考，不要改它**） | `~/workspace/VerilogCoder` |
| 产品设计文档（PDD） | `docs/PDD-VeriGen.md` |
| 技术改造文档（依赖分析 + 架构 + npm-vendored Python worker + worker 协议） | `docs/TECH-VerilogCoder-Integration.md` |
| 本交接文档 | `docs/HANDOFF.md` |
| VeriGen TS 垂直层 | `packages/verigen`（`VerilogAnalysis`、Spec KG、Playbook RAG、Graphify Context、Context Router） |
| Prompt / Playbook 资产 | `.pi/prompts/verigen-*.md`、`.pi/skills/verigen-playbook.md` |
| 跨会话项目记忆 | `~/.claude/projects/-Users-krli-workspace-VeriGen/memory/verigen-architecture.md` |

**必读顺序**：本文件 → `TECH-VerilogCoder-Integration.md`（工程细节最关键）→ `PDD-VeriGen.md`（产品全貌）。

---

## 2. 底座：pi harness 速览

VeriGen = pi agent harness 的垂直定制。TS monorepo，关键包：

- `packages/ai`（`@earendil-works/pi-ai`）：多 provider LLM 统一 API → **取代** VerilogCoder 里的 openai/langchain。
- `packages/agent`（`pi-agent-core`）：agent 运行时、tool calling、state → **取代** autogen。
- `packages/coding-agent`：交互式 CLI。
- `packages/tui`：终端 UI。
- 扩展机制：`.pi/extensions`、`.pi/skills`、`.pi/prompts`（垂直定制都走这里，**不要 fork pi 核心**，以便跟随上游升级）。

仓库约定见 `AGENTS.md`（重要：只 `npm run check` 不随意 build/test；commit 只 stage 自己改的文件；erasable TS 语法等）。

---

## 3. 已查明的依赖事实（基于对 VerilogCoder 源码实测，非推测）

VerilogCoder 本质 = Microsoft AutoGen（`pyautogen`）+ `hardware_agent/`（硬件专属逻辑，真正价值所在）。

| 依赖 | 用途 | 决策 |
|---|---|---|
| **pyverilog**（163 处）+ 内置 `ply`（lex/yacc） | Verilog→AST→控制流/数据流图 | ⛔ **无 TS 平替，保留 Python**。且是**仓库内魔改 fork**（自加 `toplogic_tree_traverse`），**不能 `pip install pyverilog`**，必须 vendor `~/workspace/VerilogCoder/hardware_agent/examples/VerilogCoder/pyverilog` |
| `iverilog`（外部二进制） | pyverilog 的预处理器（`PYVERILOG_IVERILOG` 环境变量）+ VeriGen 仿真器 | 必需，运行期依赖；缺它 pyverilog 会失败 |
| `vcdvcd` + `pandas` | VCD 波形解析 + 表格化 | 随 worker 保留 Python |
| `jinja2` | pyverilog 代码生成模板 | 随 worker |
| `autogen`（101 处） | 多 Agent 框架 | ✅ **丢弃，用 pi 取代（本次改造最大净收益）** |
| `langchain`/`openai`/`tiktoken` | LLM/链 | → pi-ai |
| `networkx`（KG + 调试图） | 有向图 + BFS | KG → TS `graphology`；调试图随 worker |
| `chromadb` | RAG 向量库 | → TS（sqlite-vec / vectra） |
| `pydantic` | 数据模型 | → TS `zod` |
| `pygraphviz`/`matplotlib` | 可视化 | 弃用（UI 用 SVG/D3） |

VerilogCoder 关键模块（吸收目标）：
- `hardware_agent/examples/VerilogCoder/debug_graph_analyzer.py`（控制流图 + 多级信号回溯 BFS）
- `hardware_agent/examples/VerilogCoder/vcd_waveform_analyzer.py`（VCD 解析 + golden/DUT 对比）
- `hardware_agent/examples/VerilogCoder/pyverilog/examples/example_top_logic_graph.py`（控制流图入口 `generate_top_logic_graph`）
- `hardware_agent/examples/VerilogCoder/verilog_tools_class.py`（syntax/sim 工具，TS 端会重写）
- `hardware_agent/knowledge_circuit_graph.py`（KG，迁 TS）

---

## 4. 已锁定的架构决策（连同「为什么」）

### 4.1 混合架构：TS 主体 + 受管 Python Worker
TS（pi）负责：会话、LLM、四 Agent 编排（Planner/Coder/Verifier/Debugger）、Spec-Anchored KG、Playbook RAG、Tool Runner、上下文裁剪。Python Worker 只做**无状态分析计算**（输入 RTL/VCD → 输出结构化 JSON）：AST 解析、控制流图、波形追踪、时序元件识别。

### 4.2 Worker 随 npm vendor + uv 受管环境
S4 的分发目标是 **`npm install` 一键安装 TS/CLI 主体**。Python worker 源码和魔改 pyverilog fork 进入 npm tarball；`.venv`、wheelhouse 和第三方 Python 包不进入 npm。安装后或首次运行时，npm 包用 uv 在受管 cache venv 中从 PyPI 安装 `ply`、`jinja2`、`vcdvcd`、`pandas` 等第三方依赖，并从 npm 包内本地路径安装 worker。pyverilog 不能依赖 PyPI 官方 `pyverilog`，也不做“先装官方包再覆盖”的补丁链。详见 TECH 文档 §5。

### 4.3 **不用 MCP**（这是最近一次明确决策，重要）
用户明确否决 MCP，理由是「对上下文工程不友好」。改为：
- **传输层**：源码内嵌的 TS 客户端 `child_process.spawn` 拉起**常驻 worker**，走**私有 newline-delimited JSON over stdio** 协议（4 个无状态 RPC：`parse_ast` / `build_controlflow` / `trace_waveform` / `identify_seq_element`），worker 仅依赖标准库，**不引入 `mcp` 包**。
- **暴露面**：波形追踪是 fix loop 里的**确定性步骤**，由**编排器在 sim-fail 处确定性调用**，**不**做成模型自主调用的 tool。原始结果较大，先经 **TS 侧 Context Router 裁剪**（只留相关信号、hex 波形窗口、命中代码片段）再注入 Debugger 上下文。
- **Skill 的定位**：只承载**知识/方法论**（Verilog Playbook、调试报告解读指南），**不**用 skill 做计算传输。
- 协议帧格式与函数签名见 TECH 文档 §6。

> 为什么不纯 TS / Pyodide：pyverilog 运行期要调 iverilog 原生二进制（WASM 跑不了），pandas 在 Pyodide 也重。故保留子进程，只是把外层从 MCP 换成私有协议。

### 4.4 Graphify 默认启用，由模型自主调用
Graphify 的调用面与波形追踪不同：它是**仓库/文档上下文导航工具**，不是 RTL 语义调试工具。默认启用后，模型可在需要定位相关源码、文档、prompt、Playbook 规则或跨文件关系时自主调用 Graphify 查询能力（建议封装为原生 pi tool：`graphify.query` / `graphify.path` / `graphify.explain`），读取 `graphify-out/graph.json` 或触发受控更新。

边界：Graphify 不替代 Spec-Anchored KG（规格/端口/信号/状态语义），也不替代 pyverilog worker（AST/控制流/波形追踪）。如果 graph 缺失或过期，工具应返回明确状态并提示重建；不要把完整 `GRAPH_REPORT.md` 或 raw graph 全量塞进上下文。

---

## 5. 当前状态

- ✅ 产品设计（PDD）定稿。
- ✅ 技术改造方案（依赖分析、混合架构、npm-vendored Python worker + uv 受管环境、worker 协议）定稿且内部自洽（已无残留 MCP 旧方案描述）。
- ✅ 决策已写入项目记忆。
- ✅ **S0 可行性验证已完成**：vendored pyverilog fork 可脱离 AutoGen 独立运行，真实 `iverilog/vvp` 生成 VCD 后可做信号回溯与波形表格化。报告见 `docs/S0-Feasibility-Report.md`。
- ✅ **S1 Python Worker 已完成**：`packages/verilog-analysis` 已存在，包含 uv 项目、vendored pyverilog、`uv.lock`、私有 JSON-stdio worker、4 个无状态 RPC、离线 wheelhouse 脚本与 smoke test。
- ✅ **S2 TS 接入已完成**：`packages/verigen` 新增 `VerilogAnalysis` TS 客户端（`child_process.spawn` 常驻 worker，按 `id` 配对 JSONL 响应）、`traceSimulationFailure` 确定性 sim-fail helper，以及 `trimTraceForDebugger` / `formatTraceForDebugger` Context Router 裁剪器。集成测试覆盖：并发 RPC 配对、真实 `iverilog/vvp` 生成 VCD、调用 `trace_waveform`、输出裁剪后的 Debugger 上下文。
- ✅ **S3 TS 迁移已完成**：`packages/verigen` 新增 `SpecAnchoredKnowledgeGraph`（Graphology + zod schemas）、`PlaybookRag`（Vectra + 默认 Verilog Playbook rules）、`GraphifyContext`（默认启用的模型自主 repo/docs 查询层）；`.pi/prompts` 新增 Planner/Coder/Verifier/Debugger/System/ICL prompts，`.pi/skills` 新增 `verigen-playbook.md`。
- ✅ **S4 npm 打包已完成**：`@earendil-works/pi-verigen` 暴露 `verigen` bin，`prepack` 生成 TS dist 并复制 `packages/verilog-analysis` 与 `vendor/pyverilog` 到 npm tarball；安装后可从 npm 包内 worker 本地路径创建 uv cache venv，并完成 `parse_ast` 往返。

---

## 6. 下一步（按顺序，可直接执行）

### S0 — 可行性验证（已完成）
目标：确认魔改 pyverilog 能脱离 autogen 独立跑通 AST→控制流图→波形追踪。
1. 用 uv 建隔离 venv（Python 3.10–3.12）：`uv venv && uv pip install ply jinja2 vcdvcd pandas`。
2. 把 `~/workspace/VerilogCoder/.../pyverilog`（魔改 fork）以本地源码方式装入。
3. 确认系统有 `iverilog`（`iverilog -V`）；设置 `PYVERILOG_IVERILOG` 若需要。
4. 跑通 `example_top_logic_graph.generate_top_logic_graph` 对一个小 Verilog 模块建控制流图。
5. 用 `debug_graph_analyzer` + `vcd_waveform_analyzer` 对「一段含 bug 的 RTL + golden TB + 生成的 VCD」做一次波形追踪，确认能产出信号回溯 + 波形对比 + 代码片段。
**产出**：可行性确认报告（fork 是否能独立运行、踩到哪些坑）。**若 S0 失败，整个架构需要重审，先别往下走。**

### S1 — 建 Worker（已完成）
按 TECH 文档 §5.2 目录布局建 `packages/verilog-analysis`：vendor pyverilog fork、写 `pyproject.toml` + `uv.lock`、实现 4 个无状态 RPC（私有 JSON-stdio，§6 协议）、离线安装脚本（wheelhouse）。产出：worker 可独立启动并完成一次往返。

### S2 — 接入 TS（已完成）
`packages/verigen` 已提供 TS `VerilogAnalysis` 客户端（`child_process.spawn` 常驻 worker，按 `id` 配对请求/响应）；`traceSimulationFailure` 作为后续 VeriGen 编排器在 fix loop 的 sim-fail 处确定性调用入口；Context Router 裁剪后生成 Debugger context。验证命令：

```bash
cd packages/verigen && node --test test/verilog-analysis-client.test.ts
npm run check
```

### S3 — TS 迁移（已完成）
KG（Graphology + zod schema）、RAG（Vectra + 离线确定性 embedding）、prompt/ICL 资产（`.pi/prompts/verigen-*.md`）与 Playbook skill（`.pi/skills/verigen-playbook.md`）已落地；Graphify 默认接入为模型可自主调用的受控查询工具。验证命令：

```bash
cd packages/verigen && npm test
npm run check
```

### S4 — npm 打包（已完成）
目标：`npm install -g <verigen-package>` 后即可启动 VeriGen CLI/TUI；未来可直接发布到 npm。Python worker 源码和魔改 pyverilog fork 随 npm 包分发，第三方 Python 依赖从 PyPI 安装到受管 cache venv。

1. 收敛 `packages/verigen` 的 npm 发布面：`bin`、`files`、`exports`、`prepack`/构建产物、包名与版本策略。
2. 把 `packages/verilog-analysis` 的 worker 源码、`pyproject.toml`、`uv.lock` 与 `vendor/pyverilog` 纳入 npm `files`；排除 `.venv`、wheelhouse、缓存和生成产物。
3. 做安装自检与自举：`verigen doctor` / 首次运行检查 Node、uv/Python、`iverilog/vvp`、本地 vendored worker、Graphify；缺失时给出可执行修复，允许 `VERIGEN_SKIP_PYTHON_BOOTSTRAP=1` 跳过。
4. Graphify 继续默认启用：通过 PyPI 包 `graphifyy` 独立自举或 `uvx --from graphifyy graphify update <repo-or-subdir> --no-cluster` 生成 `graphify-out/graph.json`；不要放进 Python analysis worker。
5. 在干净临时目录验收：`npm pack` → `npm install -g <tgz>` → CLI 启动 → 从 npm 包内 worker 本地路径创建 uv cache venv → `parse_ast` 往返 → Graphify `status/query` 可用。

S4 验收证据（2026-06-08）：

```bash
npm --prefix packages/verigen run build
cd packages/verigen && npm pack --pack-destination /tmp/verigen-s4-pack
npm install --global --prefix /tmp/verigen-s4-install-final /tmp/verigen-s4-pack/earendil-works-pi-verigen-0.78.1.tgz --ignore-scripts
/tmp/verigen-s4-install-final/bin/verigen --help
VERIGEN_CACHE_DIR=/tmp/verigen-s4-cache-final /tmp/verigen-s4-install-final/bin/verigen worker-smoke --json
VERIGEN_CACHE_DIR=/tmp/verigen-s4-cache-final /tmp/verigen-s4-install-final/bin/verigen doctor --json
/tmp/verigen-s4-install-final/bin/verigen graphify-query "coder prompt kg" --json
/tmp/verigen-s4-install-final/bin/verigen graphify-path docs/PDD-VeriGen.md packages/verigen/src/spec-kg.ts --json
```

结果：build、pack、临时安装、CLI 启动、worker bootstrap、`parse_ast` smoke、doctor 均通过；tarball 包含 `dist/python/verilog-analysis` 与 `vendor/pyverilog`，不包含 `.venv`、wheelhouse、`__pycache__` 或 pyc/pyo 缓存。Graphify 默认启用；缺失索引时 `graphify-status/query/path` 返回 `stale_or_missing_index`，ready fixture 下 `graphify-query` 和 `graphify-path` 能返回节点与路径。

验收冒烟标准见 TECH 文档 §11。

---

## 7. 坑与注意事项

- **pyverilog 是魔改 fork**：别去 PyPI 装官方 `pyverilog`，会缺 `toplogic_tree_traverse`；也别装完官方包再覆盖。S4 已通过 npm tarball 内部 vendor 分发这份 fork。
- **pyverilog 隐式依赖 iverilog**：worker 启动应自检 `iverilog -V`，缺失时明确报错而非静默返回错误结果。
- **不要 fork pi 核心**：垂直定制走 `.pi/extensions|skills|prompts`，保持可跟随上游升级。
- **VerilogCoder 仓库只读**：它是参考来源，不要在那里改动。
- **Python Worker 不要重新引入 MCP**：这是被明确否决的方案；Graphify 可作为默认启用的模型自主上下文导航工具，但不要混同为 pyverilog/波形追踪传输层。
- **git 规范**（见 `AGENTS.md`）：只 stage 自己改的文件，别 `git add -A`；非用户要求不 commit/build/test。
- **TS 语法**：根配置下只能用 erasable TS（无 enum/namespace/parameter properties 等）。

---

## 8. 仍待用户拍板的开放项

- npm 发布权限、dist-tag、正式 release 流程与是否保留当前包名 `@earendil-works/pi-verigen`，待发布前确认。
- 时序元件识别放 worker（省事）还是早期就平移到 TS（减少跨进程）——TECH §7.2 一期放 worker。
- 模型池默认分工（Qwen3-Coder / Kimi / Qwen3-VL）是占位，需按实测基线确定。
