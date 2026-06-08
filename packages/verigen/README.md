# VeriGen

`@earendil-works/pi-verigen` 是 VeriGen 的 TypeScript 垂直能力包，用于把 Verilog RTL 生成、验证、调试所需的结构化能力接入 pi agent harness。

它不是完整的 FPGA IDE，也不是单纯的 Verilog 代码补全工具。当前包提供的是 S4 阶段已经完成的 npm 分发能力：CLI、Graphify 仓库上下文导航、Spec KG、Playbook RAG、以及随 npm 包分发的 Python Verilog analysis worker。

## 能力范围

- `VerilogAnalysis`：常驻 Python worker 客户端，使用私有 JSONL 协议调用 Verilog 分析能力。
- `traceSimulationFailure`：在仿真失败后确定性调用波形追踪，生成 Debugger 可用的结构化上下文。
- `SpecAnchoredKnowledgeGraph`：用 Graphology 存储模块、端口、信号、状态、约束和任务关系。
- `PlaybookRag`：用 Vectra 索引 Verilog 修复规则和工程化 Playbook。
- `GraphifyContext`：默认启用的仓库/文档上下文图查询层，支持 `status`、`query`、`explain`、`path` 和受控 `update`。
- `verigen` CLI：提供安装自检、worker smoke test、Graphify 查询等命令。

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
verigen doctor
verigen worker-smoke
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

`doctor` 会检查 Node、uv、`iverilog`、`vvp`、npm 包内 Python worker、受管 venv 和 Graphify 索引状态。Graphify 索引缺失时是 warning，不阻断 Verilog worker。

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
npm pack --pack-destination /tmp/verigen-pack
```

## 边界

- 当前包不直接提供完整 FPGA 上板流程。
- 当前包不把波形追踪暴露为模型随意调用的通用工具；它应由编排器在仿真失败后确定性调用。
- Graphify 只做仓库/文档导航，不做 Verilog 语义分析。
- 魔改 pyverilog fork 必须随 npm 包 vendor 分发，不要改成“先安装官方 pyverilog 再覆盖文件”的补丁链。
