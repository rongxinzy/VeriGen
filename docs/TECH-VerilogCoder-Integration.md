# VeriGen 技术改造文档：吸收融合 VerilogCoder（Python → TS 混合架构）

| 项 | 内容 |
|---|---|
| 目的 | 评估将 VerilogCoder（Python/AutoGen）核心能力融入 VeriGen（pi / TypeScript）的技术路径，重点解决「Python 依赖在 TS 生态无平替」的问题 |
| 结论先行 | **混合架构**：pi(TS) 主体 + **随 npm vendor 的受管 Python Worker**（npm tarball 内含 worker 源码与魔改 pyverilog，第三方 Python 依赖由 uv 从 PyPI 安装到 cache venv，**不走 MCP**，用自控的私有 JSON-stdio 协议）；波形追踪由**编排器确定性调用**、结果格式 100% 自控；唯一不可迁移的硬依赖是 **pyverilog**（Verilog 语法解析器）；**Graphify 默认启用**为仓库/文档级 Context Graph，并暴露为模型可自主调用的受控上下文导航工具 |
| 配套文档 | 产品设计见 [PDD-VeriGen.md](PDD-VeriGen.md)；本文为其 §7/§18 的工程落地 |
| 依据 | 基于对 `~/workspace/VerilogCoder` 实际源码的 import 频次与内部依赖追踪（非推测） |

---

## 1. 现状盘点：VerilogCoder 真实依赖图谱

VerilogCoder 本质 = **Microsoft AutoGen（`pyautogen`）** + `hardware_agent/`（硬件专属逻辑）。`setup.py` 即 AutoGen 的 setup，真正的价值代码在 `hardware_agent/`。

### 1.1 import 频次（实测，Top）

```
163 pyverilog     # ★ Verilog AST/控制流/数据流（核心护城河）
101 autogen       # 多 Agent 框架（= pi 的替代物，不迁移）
 15 openai        # LLM 调用（→ pi-ai）
  5 chromadb      # RAG 向量库
  4 networkx      # 有向图 + BFS（KG + 调试图）
  4 langchain     # KG 的 prompt/实体抽取链
  3 matplotlib    # 可视化（可弃）
  2 pygraphviz    # 图渲染（需系统 graphviz，可弃）
  2 numpy / PIL
  1 vcdvcd        # VCD 波形解析
    pandas        # 波形表格化（vcd_waveform_analyzer）
    ply           # pyverilog 内部 lex/yacc（间接）
    jinja2        # pyverilog 内部代码生成模板（间接）
```

### 1.2 核心模块的依赖链（追踪结果）

| VerilogCoder 模块 | 直接依赖 | 关键事实 |
|---|---|---|
| `pyverilog/`（**仓库内魔改 fork**） | `ply.lex/yacc`、`jinja2`、`networkx`、`pygraphviz`、外部 `iverilog` | 含自加的 `toplogic_tree_traverse`（ast.py）与 `example_top_logic_graph.py`——**不能 `pip install pyverilog` 替代，必须 vendor 这个 fork** |
| `debug_graph_analyzer.py`（控制流图 + 多级信号回溯） | 仅 `copy/re/deque` + pyverilog 的 `generate_top_logic_graph` | 算法本身纯净，唯一重依赖是 pyverilog |
| `vcd_waveform_analyzer.py`（VCD 解析 + golden/DUT 对比） | `vcdvcd`、`pandas`、`math` + `debug_graph_analyzer` | 波形追踪入口 |
| `verilog_tools_class.py`（语法检查/仿真/波形追踪工具） | `subprocess`(iverilog/vvp)、上面两者 | Agent 可调用的工具封装 |
| `knowledge_circuit_graph.py`（KG） | `langchain`、`autogen`、`networkx`、`pydantic` | KG 算法（建图+BFS）可移植；LLM 链需重写到 pi-ai |

### 1.3 关键隐藏依赖：iverilog 作为 pyverilog 预处理器

`pyverilog/vparser/preprocessor.py` 通过环境变量 `PYVERILOG_IVERILOG`（默认 `iverilog`）调用 **Icarus Verilog 二进制**做 `` `define ``/`` `include `` 预处理。即 pyverilog 不是纯 Python——它**运行期依赖系统装有 iverilog**。VeriGen 工具链本就包含 iverilog（UI 第 6 屏），无额外成本，但 worker 必须能找到它。

---

## 2. 依赖分类与 TS 平替评估（逐库定性）

迁移决策分三档：**(A) 重写为 TS** / **(B) 保留 Python（worker）** / **(C) 外部二进制**。

| 依赖 | 用途 | TS 平替 | 决策 | 理由 |
|---|---|---|---|---|
| **pyverilog** | Verilog→AST→控制流/数据流图 | **无**（无成熟 TS Verilog 文法解析器） | **B 保留 Python** | 重写=数人年；fork 已魔改 |
| `ply` | pyverilog 的 lex/yacc | 不适用 | B（随 pyverilog） | pyverilog 内部 |
| `jinja2` | pyverilog 代码生成模板 | nunjucks(TS) | B（随 pyverilog） | 仅 pyverilog 用 |
| `vcdvcd` | VCD 波形解析 | `vcd`/`vcd-parser`(npm) 存在但弱 | B 保留 Python | 与调试图强耦合，迁移收益低 |
| `pandas` | 波形表格化 | 手写/`danfojs` | B（随 worker） | 仅格式化用，无须单独迁 |
| `networkx` | KG / 调试图（DiGraph+BFS） | ✅ `graphology` | **A 迁 TS（KG）** / B（调试图随 worker） | KG 是产品一等公民，宜在 TS 主体 |
| `pygraphviz` + graphviz | 图渲染 PNG | TS 端 SVG/D3 渲染 | **弃用** | UI 已用 SVG 画 KG（原型第4屏） |
| `matplotlib` | 画图 | 弃 | 弃用 | 非必需 |
| **`autogen`** | 多 Agent 编排/会话 | ✅ **pi（agent-core）** | **弃用，pi 重写** | pi 即其替代，这是改造的核心收益 |
| `langchain` | KG prompt/抽取链 | ✅ pi-ai | A 重写 | 仅 KG 用到链 |
| `openai`/`tiktoken` | LLM/计 token | ✅ pi-ai | A 重写 | pi-ai 统一多 provider |
| `chromadb` | RAG 向量库 | ✅ `vectra`/`hnswlib-node`/sqlite-vec | A 迁 TS | Playbook RAG 在 TS 主体 |
| `pydantic` | 数据模型 | ✅ `zod` | A 重写 | TS 标准做法 |
| `numpy`/`PIL` | 数值/图像 | 内置/`sharp` | A 重写 | 边角 |

**一句话结论：除 pyverilog 体系（含 ply/jinja2/vcdvcd/pandas，统一打包进 worker）外，其余依赖在 TS 生态都有平替或被 pi 直接取代。**

---

## 3. 集成方式决策：内嵌 Worker，不用 MCP

### 3.0 决策记录（为什么不用 MCP / 不用 Skill 做传输）

把「TS 如何调用 Python」拆成两个**正交**问题，MCP 的问题在于它在两个轴上都给松耦合：

| 轴 | 选项 | 我们的选择 |
|---|---|---|
| **传输层** | MCP 协议 / 直接 spawn 受管子进程 | **受管子进程 + 私有 JSON-stdio 协议** |
| **对模型的暴露面** | 模型自主 tool / 编排器确定性步骤 / skill | **波形追踪走编排器确定性步骤；Graphify 走模型自主上下文导航 tool** |

**为什么砍掉 MCP（对上下文工程不友好）：**
- MCP 工具的 schema/description 会**常驻进上下文**，且工具结果格式不完全可控——与 VeriGen「Context Router + 结构化中间物」原则冲突。
- 还多一层 server 发现 / 握手 / 独立进程生命周期，松耦合带来的全是负债。

**关键洞察：波形追踪不该是「模型自主调用的 tool」。** 它是 fix loop 里的**确定性步骤**：仿真失败 → 跑追踪 → 报告经 Context Router 裁剪后注入 Debugger 上下文。因此应由**编排器确定性调用**，而非让模型「想到了就 call」。

**Graphify 是例外，且应默认启用。** Graphify 的用途是仓库/文档上下文导航，不是 RTL 语义诊断；它适合让模型自主判断何时调用，以减少盲目全仓搜索和重复读文件。默认暴露面建议是原生 pi tool（`graphify.query` / `graphify.path` / `graphify.explain` / `graphify.status`），工具内部读取 `graphify-out/graph.json` 或触发受控增量更新，返回已经裁剪的相关节点/文件/社区摘要。

**Skill 的定位：** 只承载**知识/方法论**（Verilog Playbook、调试报告「解读指南」——每类错误怎么读 trace、怎么改），在进入 debug 阶段按需载入；**不**用 skill 做计算传输（会花 token 教模型调一个本可由编排器直接调的东西）。

**为什么不纯 TS / Pyodide 去掉子进程：** pyverilog 运行期要调 **iverilog 原生二进制**做预处理（WASM 跑不了），pandas 在 Pyodide 也重——故保留「npm-vendored Python worker + uv cache venv + 子进程」，只把外层协议从 MCP 换成内嵌私有协议。

### 3.1 目标架构

```
┌──────────────────────── VeriGen 进程（TS / pi） ────────────────────────┐
│  pi-tui / pi-coding-agent          TUI · CLI · HTTP                       │
│  Orchestrator（Planner/Coder/Verifier/Debugger）   ← 取代 autogen        │
│   └─ fix loop: sim-fail ▶ 确定性调用 trace ▶ Context Router 裁剪 ▶ 注入   │
│  pi-ai（Qwen3-Coder / Kimi / Qwen3-VL）            ← 取代 openai/langchain│
│  Spec-Anchored KG（graphology / zod）              ← 取代 networkx+pydantic│
│  Playbook RAG（sqlite-vec / vectra）               ← 取代 chromadb        │
│  Repo/Docs Context Graph（Graphify，默认启用，模型可自主查询）            │
│  Tool Runner（subprocess 调 EDA 工具）                                    │
│  ┌─ VerilogAnalysis 客户端（TS）：持有/复用常驻 worker，序列化由我们控制 ─┐│
└──┼────────────────────────┬──────────────────────────────┬──────────────┘│
   │ 私有 JSON-stdio 协议    │                              │ child_process │
   ▼ (newline-delimited)    │                              ▼               │
┌──────── 受管 Python Worker（npm vendor + uv cache venv，常驻） ┐ ┌── 外部二进制 ─┐
│  worker 入口（无状态 RPC：4 个函数）            │   │  iverilog / vvp    │
│   • parse_ast            (pyverilog fork)       │   │  verilator         │
│   • build_controlflow    (toplogic graph)       │   │  yosys             │
│   • trace_waveform       (debug_graph+vcdvcd)   │   │  himasim           │
│   • identify_seq_element (FF/latch 识别)         │   │  (graphviz 可选)   │
│  npm tarball 内含: pyverilog(魔改) + worker 源码 │ └────────────────────┘
│            + vcdvcd + pandas                     │
└──────────────────────────────────────────────────┘
```

**设计要点**
- Worker 只做**无状态分析计算**（输入 RTL/VCD 文本，输出结构化 JSON），不持有会话状态、不调 LLM。会话 / LLM / 编排 / 上下文裁剪全在 TS。
- TS 侧由一个 **VerilogAnalysis 客户端模块（内嵌源码）** 拉起并复用常驻 worker（`child_process.spawn`），通过**私有 newline-JSON 协议**调用——内部实现细节，**结果序列化 100% 由我们掌控**，进上下文前先经 Context Router 裁剪。
- iverilog 既是 VeriGen 仿真工具，又是 pyverilog 预处理器，二者共用同一二进制。

---

## 4. 边界划分总表（迁移落点）

| VerilogCoder 资产 | 落点 | 形态 |
|---|---|---|
| pyverilog fork（AST/控制流/数据流） | Worker | vendored Python |
| `debug_graph_analyzer`（控制流图 + 多级回溯 BFS） | Worker | Python，暴露 `build_controlflow`/`trace_waveform` |
| `vcd_waveform_analyzer`（VCD 解析 + golden/DUT 对比表） | Worker | Python |
| 时序元件识别（FF/latch） | Worker（首选）/ 可选 TS | 纯算法，先放 worker 省事 |
| `verilog_tools_class`（syntax/sim 工具） | TS Tool Runner（调 iverilog/vvp） | TS 重写（subprocess 简单） |
| KG（建图 + 实体抽取 + BFS 检索） | TS 主体 | graphology + pi-ai（重写 langchain 链） |
| 多 Agent 编排（autogen） | TS 主体（pi） | 丢弃 autogen |
| ICL/prompt 模板（`ICL_examples`/`prompt_templates`/`OS_prompt_templates`） | `.pi/prompts` + skills | 转写为 pi prompt/Playbook |
| RAG/示例库（`verilog_examples_manager`、chromadb） | TS 主体 | sqlite-vec/vectra |
| VerilogEval v2 用例（`load_verilog_cases`） | 评测脚本（TS 或 Python 皆可） | 评测期复用 |
| Graphify（默认启用） | TS 主体的 Context Router / 模型自主仓库导航 tool | 默认生成/读取 `graphify-out/graph.json`；暴露 `query/path/explain/status` |

### 4.1 当前 TS 接入落点（S2 已完成）

仓库新增 `packages/verigen` 作为 VeriGen 垂直层的 TS 接入包：

- `VerilogAnalysis`：用 `child_process.spawn` 拉起并复用 `packages/verilog-analysis` worker，按请求 `id` 配对 newline-JSON 响应，封装 `parseAst` / `buildControlflow` / `traceWaveform` / `identifySeqElement`。
- `traceSimulationFailure`：给后续 VeriGen 编排器在 sim-fail fix loop 中确定性调用；输入 RTL + VCD + mismatch signals，调用 `trace_waveform`，返回 raw trace 与 Debugger prompt context。
- `trimTraceForDebugger` / `formatTraceForDebugger`：TS 侧 Context Router 裁剪器，只保留相关信号、有限 hex 波形窗口、命中 RTL 代码片段和遗漏计数，避免把 raw VCD/全图直接塞进上下文。
- 集成测试：`packages/verigen/test/verilog-analysis-client.test.ts` 真实运行 `iverilog/vvp` 生成 VCD，并验证常驻 worker、并发 RPC id 配对、`trace_waveform` 与 Debugger context 格式化。

### 4.2 当前 TS 主体迁移落点（S3 已完成）

`packages/verigen` 继续承载 S3 的 TS 主体能力：

- `SpecAnchoredKnowledgeGraph`：Graphology directed graph + zod schemas；支持 KG import/export、相关子图 BFS、模块端口契约校验。
- `PlaybookRag`：Vectra local index + 离线确定性 embedding；默认内置 FSM、位宽、时序赋值、TB mismatch、工具子集 5 类 Verilog Playbook rules。
- `GraphifyContext`：默认启用的 repo/docs context graph wrapper；支持 `status` / `query` / `explain` / `path` / 受控 `update`，工具结果在 TS 侧裁剪后给模型。
- Prompt/ICL 资产：`.pi/prompts/verigen-system.md`、`verigen-planner.md`、`verigen-coder.md`、`verigen-verifier.md`、`verigen-debugger.md`、`verigen-icl.md`。
- Playbook skill：`.pi/skills/verigen-playbook.md`。

---

## 5. Python Worker 工程方案（npm vendor + uv 受管环境）

### 5.1 S4 分发目标

S4 的目标不是 Docker，也不是发布我们自己的 Python 包到 PyPI，而是：

- TS/CLI 主体发布到 npm，用户通过 `npm install -g <verigen-package>` 一键安装。
- Python worker 源码、`pyproject.toml`、`uv.lock` 与魔改 `vendor/pyverilog` 随 npm tarball 分发。
- `ply`、`jinja2`、`networkx`、`numpy`、`pandas`、`vcdvcd` 等第三方 Python 依赖由 uv 从 PyPI 安装到受管 cache venv。
- Graphify 通过 PyPI 包 `graphifyy` 独立自举，继续默认启用，不放进 `packages/verilog-analysis` worker。
- 安装后首个命令必须能明确报告缺失项：uv/Python、`iverilog/vvp`、npm-vendored worker、Graphify index。

uv 仍作为 Python 受管环境工具，原因是：

| 诉求 | uv 能力 |
|---|---|
| 可复现 | npm 包内随附 worker 的 `uv.lock`；发布前可用 `uv sync --frozen` 校验 |
| 安装体验 | npm 包可从本地 worker 路径创建 uv cache venv；只有第三方依赖从 PyPI 下载 |
| 快 | Rust 实现，解析/安装比 pip 快一个量级（CI 与首次部署体验） |
| 干净隔离 | 自带 venv 管理，不污染系统 Python；可 `uv python install` 固定解释器版本 |
| 单一工具 | 取代 pip+venv+pip-tools+pyenv 组合，降低 bootstrap 复杂度 |

> 注意：pyverilog fork 仍不是 PyPI 官方 `pyverilog`。S4 不走“安装官方 pyverilog 后覆盖文件”的补丁链，而是把 `vendor/pyverilog` 随 npm tarball 分发，并在 worker venv 中从本地 path source 安装 `pyverilog==1.3.0+verigen`。

### 5.2 Worker 目录布局

```
packages/verilog-analysis/            # 随 npm tarball vendor
├── pyproject.toml                    # uv 项目定义
├── uv.lock                           # 锁文件（提交入库）
├── README.md
├── src/verilog_analysis/
│   ├── __main__.py                   # worker 入口：stdin 读帧 / stdout 回帧（私有 JSON-stdio）
│   ├── server.py                     # RPC 分发（4 个无状态函数）
│   ├── controlflow.py               # 封装 debug_graph_analyzer
│   ├── waveform.py                  # 封装 vcd_waveform_analyzer
│   └── seq_element.py               # 时序元件识别
├── vendor/
│   └── pyverilog/                    # 魔改 fork（含 toplogic_tree_traverse）
└── scripts/                          # doctor、bootstrap、smoke 辅助脚本
```

### 5.3 pyproject.toml（要点）

```toml
[project]
name = "verigen-verilog-analysis"
requires-python = ">=3.10,<3.13"      # 对齐 pyverilog/AutoGen 支持区间
dependencies = [
    "ply",            # pyverilog 文法引擎
    "jinja2",         # pyverilog 代码生成
    "networkx",       # pyverilog / 调试图依赖
    "numpy",          # pandas 间接数值依赖，锁定在 uv.lock 中
    "vcdvcd",         # VCD 解析
    "pandas",         # 波形表格化
    "pyverilog==1.3.0+verigen",
    # 无需 mcp：worker 用极简私有 JSON-stdio 协议
    # pyverilog 走 npm tarball 内本地 vendored 源码，见下
]

[tool.uv.sources]
pyverilog = { path = "vendor/pyverilog", editable = true }

[project.scripts]
verigen-verilog-analysis = "verilog_analysis.__main__:main"
```

### 5.4 安装 / 锁定 / npm 自举

```bash
# 开发期（联网）：建 venv + 解析 + 写 uv.lock
uv sync

# 锁定后严格复现（CI / 发布前校验）
uv sync --frozen

# npm 发布前：确认 tarball 包含 worker 源码和 vendor/pyverilog，但不包含 .venv/wheelhouse
npm pack --dry-run

# npm 包安装后或首次运行时，从 npm 包内本地路径创建受管 cache venv
uv venv <cache-dir>/verigen-python/<npm-version>
uv pip install --python <cache-dir>/verigen-python/<npm-version>/bin/python <npm-package-root>/packages/verilog-analysis

# Graphify 默认启用，但独立管理
uvx --from graphifyy graphify update <repo-or-subdir> --no-cluster
```

### 5.5 npm 包分发策略

| 内容 | 做法 | 不做 |
|---|---|---|
| npm tarball | 包含 TS/JS CLI、prompt/skill 资产、Graphology/Vectra npm 依赖、bootstrap/doctor 逻辑、`packages/verilog-analysis` worker 源码与 `vendor/pyverilog` | 不包含 `.venv`、wheelhouse、Python cache、Dockerfile |
| Python worker | 从 npm 包内本地路径安装到 uv cache venv；`pyverilog==1.3.0+verigen` 由 `vendor/pyverilog` path source 提供 | 不发布到 PyPI；不依赖官方 PyPI `pyverilog`；不覆盖 site-packages 里的官方包 |
| 安装时机 | 优先安装后/首次运行自动自举；支持 `VERIGEN_SKIP_PYTHON_BOOTSTRAP=1` 跳过，再由 `verigen doctor` 修复 | 不要求用户手工 clone Python 子项目 |
| Graphify | 通过 `graphifyy` PyPI 包独立安装或 `uvx` 按需运行，Graphify 默认启用 | 不放入 Verilog analysis worker |

TS 主进程仍通过 `child_process.spawn` 拉起 worker 可执行文件；该可执行文件来自 npm 包本地路径安装后的受管 cache venv，而不是 npm 包内置 venv。

---

## 6. 私有 Worker 协议（非 MCP）

Worker 暴露 4 个**无状态 RPC 函数**，走自控的 **newline-delimited JSON over stdio**（每行一个请求/响应），不引入 MCP。TS 侧 VerilogAnalysis 客户端调用，结果由编排器/Context Router 处理后再决定如何进上下文。

**协议帧（极简）**

```jsonc
// → 请求（一行）
{ "id": 7, "fn": "trace_waveform", "args": { "rtl": "...", "vcd": "...", "mismatch_signals": ["out_byte"], "trace_level": 2 } }
// ← 响应（一行）
{ "id": 7, "ok": true, "result": { "trace": [...], "wave_table_hex": "...", "code_snippets": [...] } }
// ← 出错（结构化，不抛裸异常）
{ "id": 7, "ok": false, "error": { "kind": "parse_error", "details": [{ "line": 42, "msg": "..." }] } }
```

**函数集**

| 函数 | 输入 | 输出 |
|---|---|---|
| `parse_ast` | `{ rtl, top }` | `{ ast_ok, errors?: [{line, msg}], modules: [...] }` |
| `build_controlflow` | `{ rtl, top }` | `{ nodes, edges, signal_lines: {signal: [lineno]} }` |
| `trace_waveform` | `{ rtl, vcd, mismatch_signals[], trace_level }` | `{ trace: [{signal, controllers}], wave_table_hex, code_snippets }` |
| `identify_seq_element` | `{ clock_waveform, signal_waveform }` | `{ kind: "posedge_ff"|"negedge_ff"|"latch_high"|"latch_low" }` |

- **错误处理**：解析失败返回结构化 `error`（带行号），不抛裸异常——与 PDD §10 错误分类对接。
- **结果不直接进上下文**：原始 `result` 较大（完整波形/全图），由 TS 侧 Context Router 裁剪（只留相关信号、hex 窗口、命中代码片段）后再注入 Debugger。这正是相对 MCP 的核心优势——**序列化与裁剪完全自控**。
- VCD 由 TS 侧仿真（iverilog/vvp 或 Himasim）产生后，把**文件路径或内容**传给 worker；worker 不负责跑仿真。
- worker 常驻复用，避免每次冷启 Python；TS 客户端按 `id` 配对请求/响应。

---

## 7. 组件迁移细化

### 7.1 AST 波形追踪（保留 Python，护城河）
- 直接 vendor 魔改 pyverilog + `debug_graph_analyzer` + `vcd_waveform_analyzer`，薄封装为 worker 的 4 个无状态 RPC 函数（私有 JSON-stdio，非 MCP）。
- **不重写算法**，只做接口收敛（Python 函数 → JSON in/out）。风险最低、保真度最高。
- 暴露面：由编排器在 fix loop 的 sim-fail 处确定性调用，结果经 TS 侧 Context Router 裁剪后注入 Debugger（见 §3.0）。

### 7.2 时序元件识别
- 纯波形跳变规则，算法简单。一期随 worker（省事），后续若想减少跨进程调用可平移到 TS。

### 7.3 Spec-Anchored KG（迁 TS）
- 建图/BFS：`networkx` → `graphology`（API 对应良好：DiGraph、邻接遍历、BFS）。
- 实体抽取链：`langchain` chains → pi-ai 的结构化输出（function-calling / JSON schema by zod）。
- 数据模型：`pydantic` → `zod`。
- 收益：KG 是产品可解释性一等公民（UI 第4屏），放 TS 主体便于与 TUI/HTTP 直接渲染，避免跨进程。

### 7.4 多 Agent 编排（弃 autogen，用 pi）
- autogen 的 GroupChat/ConversableAgent → pi 的 agent-core + extensions。
- 这是改造的**净收益**：去掉 101 处 autogen 依赖与其传递依赖（flaml/docker/diskcache 等）。

### 7.5 Playbook RAG（迁 TS）
- chromadb → sqlite-vec 或 vectra（纯 JS，离线友好，契合私有化）。
- 嵌入模型经 pi-ai 或本地 embedding 服务。

### 7.6 Prompt / ICL 资产
- `ICL_examples.py`/`prompt_templates.py`/`OS_prompt_templates.py` 的硬件专属提示（K-map 提取、FSM 规则、always@(*)、禁 typedef enum、强制 localparam）转写为 `.pi/prompts` 与 Playbook 规则切片（PDD §8）。

### 7.7 Repo/Docs Context Graph（默认启用 Graphify）

Graphify（`safishamsi/graphify`，PyPI 包名 `graphifyy`，CLI 命令 `graphify`）默认作为**仓库/文档级上下文图谱**启用，用于优化 agent 性能：

- **用途**：对 VeriGen 源码、`.pi/prompts`、Playbook、技术文档做离线抽取，生成 `graphify-out/graph.json`；TS 侧 Context Router 读取该 JSON，按当前任务检索相关文件、函数、文档段落和社区，而不是让模型反复全仓搜索/阅读。
- **收益**：减少上下文 token、缩短跨文件定位时间、让 Planner/Coder/Debugger 在进入任务前获得更稳定的相关子图。适合“我该读哪些文件/规则/提示词”这类仓库导航问题。
- **边界**：Graphify **不替代** Spec-Anchored KG（规格/端口/信号/状态语义图），也**不替代** pyverilog 控制流图（RTL 语义/波形追踪）。实测 `.v` 文件可被识别为代码节点，但未抽出 module/port/assign 级 Verilog 语义；Verilog 语义仍由 pyverilog worker 负责。
- **默认启用方式**：S3 开始默认在项目初始化/CI 中生成 `graphify-out/graph.json`，并在运行时启用 Graphify 上下文导航工具。如果 graph 缺失或过期，工具返回 `stale_or_missing_index` 并建议或触发受控增量更新，例如 `uvx --from graphifyy graphify update <repo-or-subdir> --no-cluster`。
- **模型自主调用**：Planner/Coder/Verifier/Debugger 均可自主调用 Graphify，但只用于仓库/文档定位：`graphify.query`（自然语言查相关节点）、`graphify.path`（解释两个实体的连接路径）、`graphify.explain`（解释某实体/文件）、`graphify.status`（索引状态）。工具结果必须由 TS 侧裁剪后返回，不直接把 raw graph 或完整报告塞进上下文。
- **禁止项**：不要把 Graphify 当作 pyverilog 替代；不要把 `trace_waveform` 这类 RTL 语义调试改成模型自主调用；不要把 Graphify 依赖放进 `packages/verilog-analysis` worker。是否使用 Graphify MCP server 不是核心要求，一期优先原生 pi tool 包装 CLI/JSON，减少 schema 常驻负担。
- **依赖影响**：Graphify 会拉取 `tree-sitter`、`networkx`、`numpy`、`scipy` 等较重 Python 依赖。为避免污染 Verilog analysis worker，S4 用 `uvx`/独立 cache venv 管理，并从 PyPI 安装 `graphifyy`；不要把它塞进 npm 包或 Python analysis worker。

---

## 8. 系统级外部依赖清单（二进制，非 Python/TS 包）

| 二进制 | 用途 | 必需性 |
|---|---|---|
| `iverilog` + `vvp` | 仿真 + **pyverilog 预处理器** | 必需 |
| `verilator` | 快速 lint / C++ 仿真 | 推荐 |
| `yosys` | 逻辑综合 | 推荐 |
| `himasim`（华大九天） | 赛题指定仿真/综合 | 必需（赛事） |
| `graphviz` | 图渲染 | 可弃（用 TS SVG 替代） |

安装后需通过 `verigen doctor` 检查这些二进制，并通过 `PYVERILOG_IVERILOG` 等环境变量显式指向，保证运行时可用。

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| pyverilog 是魔改 fork，不可依赖官方 PyPI `pyverilog` | 维护/升级困难 | 通过 npm tarball 分发 `vendor/pyverilog`；自加的 `toplogic_tree_traverse` 单独文档化 |
| npm tarball 漏带 worker 或 `vendor/pyverilog` | `npm install` 后波形追踪不可用 | `npm pack --dry-run` / smoke test 检查包内容；`verigen doctor` 明确报错 |
| 第三方 Python 依赖从 PyPI 自举失败 | 首次运行不能创建 worker venv | `verigen doctor` 明确报错；支持重试安装、镜像源配置、`VERIGEN_SKIP_PYTHON_BOOTSTRAP=1` 跳过后补装 |
| 跨进程（TS↔Python）调用开销 | 大量小调用变慢 | worker 常驻 + 批量调用；波形追踪是低频重计算，开销可接受 |
| pyverilog 隐式依赖 iverilog | 解析在缺 iverilog 时静默失败 | 启动自检 `iverilog -V`；缺失则明确报错 |
| 版本漂移（pandas/numpy ABI 等） | 复现性差 | `uv.lock` 锁定 + `--frozen`；pin Python 版本 |
| pyverilog 对 SystemVerilog 支持有限 | 高级 SV 解析失败 | 解析失败优雅降级（跳过波形追踪，回退到纯报错驱动修复）；Playbook 限制生成可解析子集 |
| Graphify 依赖较重且 Verilog 语义粒度不足 | 安装较慢 / 误当 RTL 语义图使用 | 默认启用但独立 cache venv/uvx 管理；不放入 worker；工具描述保持短 schema；Verilog 语义仍走 pyverilog |

---

## 10. 分阶段实施

| 阶段 | 目标 | 交付 |
|---|---|---|
| S0 验证 | 在隔离 venv 跑通 vendored pyverilog + `example_top_logic_graph` + 一个 VCD 追踪样例 | 可行性确认（确认 fork 能独立运行） |
| S1 Worker | 封装 4 个无状态 RPC（私有 JSON-stdio），uv 项目 + uv.lock + 离线安装脚本 | `packages/verilog-analysis` 可独立启动 |
| S2 接入 | TS VerilogAnalysis 客户端拉起常驻 worker；`traceSimulationFailure` 作为编排器 sim-fail 确定性调用入口；Context Router 裁剪后注入 Debugger | `packages/verigen` + 集成测试已完成 |
| S3 TS 迁移 | KG（Graphology）、RAG（Vectra）、prompt/ICL/Playbook 资产落 TS 与 `.pi`；默认接入 Graphify Repo/Docs Context Graph，暴露模型自主查询工具；运行时无 autogen 依赖 | `packages/verigen` S3 模块 + `.pi/prompts` + `.pi/skills` 已完成 |
| S4 npm 打包 | npm 一键安装；Python worker 与 `vendor/pyverilog` 随 npm 分发；第三方 Python 依赖与 Graphify 从 PyPI 自举；无 Docker | 已完成：独立包 `verigen` 可 pack/install，CLI、doctor、本地 worker bootstrap、`parse_ast` smoke 均通过 |
| S5 VeriGen Mode + TUI Trace MVP | 把底层能力接入产品入口；展示流水线状态、仿真失败、trace report；引入 Codegen Quality Probe 小题集 | 固定失败 RTL + VCD 能在 TUI 展示 trace report；L0/L1 小题能生成 RTL 供人工评审 |
| S6 EDA ToolRunner 标准化 | 统一 iverilog/vvp、Verilator、Yosys、Himasim profile 和错误 schema | `lint -> sim -> trace` 可结构化返回给 Debugger；Quality Probe 可跑 compile/sim |
| S7 四 Agent 闭环 | Planner/Coder/Verifier/Debugger 串联，最多 3 轮 fix loop | counter、edge detector、简单 FSM 能自然语言到仿真通过；Quality Probe 记录修复轮次 |
| S8 Context Router 强化 | Graphify、KG、Playbook、trace 统一裁剪和注入 | 模型能自动取相关规则/文件/图节点，不全仓盲搜 |
| S9 Board Profile 抽象 + Mock Bring-up | board schema、constraints schema、programmer interface、mock board backend | 固定 `blink_led` 在 mock backend 中完成 synth/bitstream/program/report dry-run |
| S10 Dry-run Hardware Flow | 受控模板任务接入 sim/synth/dry-run program/smoke report | 简单模块由 VeriGen 生成，完成 sim/synth/dry-run hardware report |
| S11 发布工程化 | npm 发布、release smoke、示例工程、CI pack/install smoke | 新机器按 quickstart 可安装并跑通 smoke |
| S12 评测与数据闭环 | Codegen Quality Probe 正式化；VerilogEval/自建用例、失败样本库、指标统计 | 可量化生成质量、收敛率、修复轮次、错误分类分布 |
| S13 产品级 TUI 信息架构 | 项目仪表盘、pipeline navigator、inspector tabs、run history | 用户能在 TUI 完成一次完整 RTL debug 工作流 |
| S14 TUI 可视化 polish | 波形窗口、信号依赖图、RTL diff、键盘操作、状态体系 | TUI 达到可演示、可重复使用、信息密度合理 |
| S15 产品化交付闭环 | onboarding、doctor 修复建议、模板、profile 管理、报告导出、session replay | 可用于正式演示、内部试用和后续商业化包装 |
| S16 Real FPGA Validation | 接真实板卡 backend、真实 programmer、真实观测 smoke | 固定 demo 和一个 VeriGen 生成模块在真实 FPGA 上 smoke 通过 |

---

## 11. 验收标准（冒烟）

1. 干净临时目录中 `npm pack` 后 `npm install -g <tgz>` 成功，CLI/TUI 可启动。
2. 首次运行或 `verigen doctor` 能从 npm 包内本地 `packages/verilog-analysis` 创建/定位 uv cache venv，TS 客户端能拉起常驻 worker 并完成一次 `parse_ast` 往返（私有 JSON-stdio）。
3. Graphify 默认启用；缺失 index 时可通过受控路径运行 `uvx --from graphifyy graphify update <repo-or-subdir> --no-cluster`，随后 `graphify.status/query` 可用。
4. 给定一段含 bug 的 RTL + golden TB，端到端跑出：仿真 FAIL → 编排器确定性调 `trace_waveform` → 信号回溯 + 波形对比 + 代码片段（经 Context Router 裁剪）→ Debugger 产出定向修复 → 复仿真 PASS。
5. 缺失 iverilog 时给出明确错误而非静默错误结果。

S4 已完成的 npm 安装验收（2026-06-08）：

```bash
npm --prefix packages/verigen run build
cd packages/verigen && npm pack --pack-destination /tmp/verigen-s4-pack
npm install --global --prefix /tmp/verigen-s4-install-final /tmp/verigen-s4-pack/verigen-0.79.2.tgz --ignore-scripts
/tmp/verigen-s4-install-final/bin/verigen --help
VERIGEN_CACHE_DIR=/tmp/verigen-s4-cache-final /tmp/verigen-s4-install-final/bin/verigen worker-smoke --json
VERIGEN_CACHE_DIR=/tmp/verigen-s4-cache-final /tmp/verigen-s4-install-final/bin/verigen doctor --json
/tmp/verigen-s4-install-final/bin/verigen graphify-query "coder prompt kg" --json
/tmp/verigen-s4-install-final/bin/verigen graphify-path docs/PDD-VeriGen.md packages/verigen/src/spec-kg.ts --json
```

验收结果：tarball 包含 TS dist、prompt/skill 资产、`dist/python/verilog-analysis` 与 `vendor/pyverilog`；不包含 `.venv`、wheelhouse、Python cache、Dockerfile。临时安装后的 CLI 可启动，worker 从 npm 包内本地路径安装到 uv cache venv，`parse_ast` 往返成功。`verigen doctor` 对 Node、uv、`iverilog`、`vvp`、worker venv 均返回 ok；Graphify 缺失索引时返回非阻断 warning，ready fixture 下 `graphify-query` 和 `graphify-path` 可返回节点与路径。

---

## 附：核心结论复述

> **不要把 pyverilog 重写成 TS，也不要安装官方 pyverilog 后覆盖文件。** 它（含 `ply` 文法引擎）是唯一无 TS 平替的硬依赖，且是仓库内魔改 fork。正确做法是把 worker 源码与 `vendor/pyverilog` 随 npm tarball 分发，再由 npm 包把本地 worker 安装进 uv 受管 cache venv；`ply`、`jinja2`、`vcdvcd`、`pandas` 等第三方依赖从 PyPI 安装。TS 的 pi 主体仍通过**源码内嵌的私有 JSON-stdio 协议**（**不用 MCP**，避免上下文负债）调用 worker，并由**编排器在 fix loop 中确定性调用、结果经 Context Router 自控裁剪**；Skill 只承载 Playbook / 调试解读知识，不做计算传输。其余依赖（autogen/langchain/openai/chromadb/networkx/pydantic）在 TS 生态都有平替或被 pi 直接取代——其中**弃用 autogen、改用 pi 本身就是这次改造的最大净收益**。
