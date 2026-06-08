# VeriGen 产品设计文档（PDD）

| 项目 | 内容 |
|---|---|
| 产品名称 | VeriGen — Verilog 代码生成智能体 |
| 一句话定位 | 不是「Verilog 版 Copilot」，而是一条**自然语言 → 可验证 / 可综合 RTL 的「设计-验证-修复」流水线 Agent** |
| 技术底座 | pi agent harness（`@earendil-works/pi-*` monorepo：ai / agent / coding-agent / tui），通过 `.pi/extensions`、`skills`、`prompts` 做垂直定制 |
| 参赛背景 | 第十一届「创客中国」工业智能体大赛 · 场景赛赛题三（华大九天命题）：Verilog 代码生成智能体 |
| 研发主体 | 北京容芯致远科技有限公司（研发部开源组） |
| 文档版本 | v0.1（产品设计基线，对齐 UI 原型 v0.9.0） |

---

## 1. 设计立场与第一性原理

**核心论断：Verilog Agent 的价值不在「会写代码」，而在「能把 RTL 设计任务闭环到可验证、可综合、可复用」。**

由此推出五条不可妥协的设计原则，贯穿全文：

| # | 原则 | 含义 | 反面教材 |
|---|---|---|---|
| P1 | **验证优先（Verification-first）** | 先有 testbench / golden / assertion，再写 RTL。能过仿真、能综合、能被 property 约束才算「对」 | 直接生成大段 RTL 让人肉眼审 |
| P2 | **结构化中间物（Structured artifacts）** | 每个流水线阶段必须产出机器可校验的中间物（契约表、KG、错误分类、修复 diff），而非自由文本 | 一个 Agent 一口气写完整模块 |
| P3 | **KG 锚定（Spec-Anchored）** | 规格 → 知识图谱 → 代码。Coder 严格按 KG 端口契约生成，从根本上抑制层次化设计中的「接口幻觉」 | 把整仓库 / 整本 LRM 塞进上下文 |
| P4 | **工程化知识 > 原始文档** | 喂给模型的是「规则切片 + 可执行例子 + 工具报错 + 修复方式」的 Playbook，不是 LRM 全文 | RAG 里堆一本 SystemVerilog 标准 |
| P5 | **精简多 Agent + Prompt 为一等公民** | Agent 数量不是关键，上下文约束与 Prompt 工程才是杠杆。固定四角色，把复杂度投到知识与流程 | 无限拆 sub-agent |

> 两大技术支柱：**① Spec-Anchored Knowledge Graph**（可解释、抑制幻觉）+ **② AST 驱动的波形追踪调试**（从 VerilogCoder 吸收，难以复制的护城河）。项目对外叙事建议把这两条并列，而非只讲 KG。

---

## 2. 目标用户与场景

### 2.1 用户画像

| 角色 | 痛点 | VeriGen 提供的价值 |
|---|---|---|
| 资深数字设计工程师 | 中等模块 2–4 周；重复造轮子 | 分钟级出可仿真 RTL + TB，把人力投到架构与签核 |
| 系统 / 算法工程师（非 RTL 专精） | 不熟时序/组合逻辑，易埋隐蔽 bug | 自然语言/时序图 → 可综合 RTL，门槛下移 |
| 高校 / 培训 | 学生看不到「代码→仿真→波形」即时反馈 | 教学闭环，KG 可视化讲设计决策 |
| 国产 EDA 生态 / 企业内网 | 数据安全、需自主可控工具链 | npm 一键安装、内置 Python worker 与魔改 pyverilog、与华大九天工具链深度集成 |

### 2.2 核心场景（对齐赛题）

1. **I²C 控制器生成**：自然语言 → I²C Master/Slave 模块 + testbench。
2. **多模态输入**：解析 PDF 规格书 / 时序图，自动构建 KG 并生成 RTL。
3. **仿真闭环**：生成代码自动过 Himasim 功能仿真 + 逻辑综合。
4. **调试优化演示**：故意引入错误需求，展示 AI 自主发现→修复→收敛（≤3 轮）。

---

## 3. 系统总体架构

VeriGen = **pi harness（运行时/工具/TUI）** + **VeriGen 垂直层（Agent 编排 / KG / Playbook / EDA 工具适配 / 数据闭环）**。

```
┌─────────────────────────────────────────────────────────────────────┐
│  交互层   TUI  ·  CLI  ·  HTTP Server        (pi-tui / pi-coding-agent) │
├─────────────────────────────────────────────────────────────────────┤
│  编排层   Orchestrator / TaskFlow（DAG 顺序执行 · 信号级增量）         │
│           ├ Planner   ├ Coder   ├ Verifier   ├ Debugger                │
├─────────────────────────────────────────────────────────────────────┤
│  知识层   Spec-Anchored KG   ·   Verilog Playbook（三类知识 RAG）      │
│           ·  Failure Dataset（数据闭环）                               │
├─────────────────────────────────────────────────────────────────────┤
│  工具层   Himasim · iverilog · Verilator · Yosys · (SymbiYosys)        │
│           AST 波形追踪 · 时序元件识别 · Graphify · 错误归因 (pi tools)  │
├─────────────────────────────────────────────────────────────────────┤
│  模型层   pi-ai 多 provider · 模型池热切换                             │
│           Qwen3-Coder（代码）· Kimi/GLM（规划/中文）· Qwen3-VL（多模态）│
├─────────────────────────────────────────────────────────────────────┤
│  运行时   pi-agent-core（tool calling · state · context）             │
│           本地推理 vLLM · SQLite + 向量库 · npm + uv/PyPI 依赖安装      │
└─────────────────────────────────────────────────────────────────────┘
```

**与 pi 的关系**：编排层、Agent system prompts、Playbook、KG、EDA 工具均以 pi 的 `extensions / skills / prompts` 形式注入，不 fork 核心运行时——保证可随上游 pi 升级。

---

## 4. 核心工作流（流水线）

固定流水线，每步必产出结构化中间物（P2）；任意一步失败回到对应修复环，而非整体重来。

```
spec ─▶ module contract ─▶ KG 构建 ─▶ RTL skeleton ─▶ implementation
  ─▶ lint ─▶ sim(+TB) ─▶ [fix loop ≤3] ─▶ synth check ─▶ final report
                 ▲                 │
                 └──── 波形追踪 / 错误归因 ◀┘
```

| 阶段 | 负责 Agent | 输入 | 结构化产出 |
|---|---|---|---|
| 规格理解 | Planner | NL / PDF / 时序图 | 需求要点、约束清单 |
| 接口定义 | Planner | 规格 | **端口契约表**（名/方向/位宽/语义/时钟域/复位） |
| KG 构建 | Planner | 契约 + 规格 | 模块层次 / 端口 / 连线语义 / 依赖 DAG |
| RTL 生成 | Coder | KG（按契约） | 信号级增量 RTL（见 §6） |
| Lint | Verifier/ToolRunner | RTL | 语法/位宽/latch/组合环报告 |
| TB & 仿真 | Verifier | RTL + 规格 | testbench / assertion + Himasim 结果 |
| Debug | Debugger | 仿真失败 + VCD | **波形追踪报告**（信号回溯 + 波形对比 + 代码片段） |
| 综合 | ToolRunner | RTL | Yosys/Himasim 综合结果、门级数、时序收敛 |
| 报告 | Orchestrator | 全过程 | JSON 报告 + 可解释 KG 视图 |

---

## 5. 多智能体设计（四角色）

精简为四个核心 Agent（P5）。每个 Agent = 领域专属 system prompt + few-shot + 输出格式约束 + 受限工具集 + Playbook 检索触发器。

| Agent | 职责 | 关键工具 | 输出契约 |
|---|---|---|---|
| **Planner** | 规格→契约→KG；信号级任务 DAG；时序元件识别 | KG 构建、时序元件识别、Playbook(FSM/接口) | 契约表 + KG + 子任务 DAG |
| **Coder** | 按 KG 契约**信号级增量**生成 RTL | 文件写、语法检查、Playbook(语法/可综合) | RTL diff（每子任务一个信号） |
| **Verifier** | 写 TB/assertion/golden；跑仿真+综合；判定 PASS/FAIL | Himasim/iverilog/Verilator/Yosys、覆盖率 | TB + 仿真/综合判定 + 覆盖率 |
| **Debugger** | 失败归因；AST 波形追踪；产出修复建议 | AST 波形追踪、错误分类、Playbook(修复库) | 信号回溯报告 + 定向修复建议 |

> 角色映射到原讨论的 Designer/Verifier/Reviewer/ToolRunner：Reviewer（时序/位宽/可综合性审查）合并进 Verifier 的 lint 阶段 + Debugger 的归因，ToolRunner 作为各 Agent 共享的工具执行层，不单列为对话 Agent，避免上下文膨胀。

---

## 6. 支柱一：Spec-Anchored Knowledge Graph

### 6.1 节点 / 边模型

| 节点类型 | 含义 |
|---|---|
| Module（顶层/子模块） | 模块层次 |
| Port | 端口契约（方向/位宽/语义/时钟域/复位策略） |
| Signal | 内部信号 / 状态 |
| StateTransition | FSM 状态转移 |
| SignalExample | 规格中的信号示例 / 波形 |
| Constraint | 时序 / 面积 / 功耗 / 编码规范约束 |

| 边类型 | 含义 |
|---|---|
| INSTANTIATES | 模块实例化（层次） |
| HAS_PORT / DRIVES | 端口归属、信号驱动关系 |
| IMPLEMENTS | 计划实现某信号 |
| STATETRANSITION | 信号参与状态转移 |
| EXAMPLES | 示例描述某信号 |
| CONSTRAINED_BY | 受约束节点约束 |

### 6.2 构建与检索

- **构建**：Planner 用 LLM 从规格抽取实体（signal / state / example），再判定节点间关系，存为有向图（NetworkX 思路）。
- **检索**：代码生成前用 BFS 从 KG 拉取「当前子任务相关的信号描述 + 状态转移 + 波形示例 + 约束」注入 prompt——只取相关子图，不全量。
- **价值**：① 抑制层次化设计接口幻觉（子模块实例化端口 100% 对齐契约）；② 作为**可解释性输出**（UI 第 4 屏 KG 可视化），让评委/用户看懂 AI 的设计依据。

---

## 7. 支柱二：AST 驱动的波形追踪调试（吸收自 VerilogCoder）

仿真失败时，不把原始报错丢回模型，而做**结构化根因定位**：

1. **控制流图构建**：用（修改版）Pyverilog 解析生成的 RTL → AST → 遍历构建控制流图（边表示 rvalue→lvalue 控制关系，记录源码行号）。
2. **多级信号回溯**：从仿真不匹配的输出信号出发，沿控制流图逆向 BFS 回溯驱动它的上级控制信号（`trace_level` 控制深度）。
3. **波形对比**：解析 VCD，提取 testbench 输入、golden（`_ref`）与 DUT（`_dut`）的十六进制波形对比表。
4. **结构化调试报告**：信号回溯关系 + 波形对比表 + 对应 Verilog 代码片段（标注错误信号所在行）+ 诊断提示。Debugger 基于此报告做修复，而非在波形里盲人摸象。

**配套：时序元件自动识别**——根据时钟与信号波形跳变，自动判定 posedge/negedge flip-flop、active-high/low latch，在 Planner 阶段避免 latch 被误实现为触发器。

> 这是比 KG 更难复制的工程护城河，建议作为第二技术支柱重点投入与对外宣传。

---

## 8. 知识体系：Verilog Playbook（P4 落地）

**完整 LRM 可入库，但绝不作主上下文。** 真正喂给 Agent 的是工程化整理的规则库。三类知识分库管理：

| 类别 | 内容 | 来源 |
|---|---|---|
| **① 语言规范** | Verilog/SystemVerilog 语法、语义、边界（位宽、signed/unsigned、blocking vs non-blocking、generate、array/packed） | LRM 切片 |
| **② 工程规范** | 公司/项目 RTL style：reset 策略、时钟命名、FSM 风格、是否允许 latch/initial block、localparam vs typedef enum | 企业资产 |
| **③ 工具规范** | Verilator/Yosys/Himasim 支持与不支持的特性、哪些 SV 特性会炸、可综合 vs 不可综合 | 工具文档+实测 |

### 8.1 规则切片格式（每条规则 = 正确写法 + 错误写法 + 工具报错 + 修复 + 自检）

```text
Rule: 时序逻辑在允许 SystemVerilog 时必须用 always_ff。
Bad:   always @(posedge clk) begin ... end
Good:  always_ff @(posedge clk) begin ... end
Check: - reset 行为显式；- 用非阻塞赋值；- 时序块内无意外组合赋值
ToolErr: <对应 lint/综合报错样例>
Fix:   <修复 diff 模板>
```

### 8.2 按任务触发检索（不是全量塞）

| 触发场景 | 检索内容 |
|---|---|
| 写 FSM | FSM 模板 + always_ff/always_comb 规则 |
| width warning | 位宽规则 + 历史位宽修复案例 |
| 综合失败 | Yosys/Himasim 支持限制 + 不可综合语法 |
| 写 testbench | TB 模板（而非 RTL 规范） |

知识切片主题：module/port/parameter · always_comb/ff/latch · blocking vs non-blocking · generate · FSM · signed/位宽 · array/packed/unpacked · interface/modport · assertion/SVA · 可综合 vs 不可综合。

---

## 9. 工具链闭环

| 工具 | 角色 | 阶段 |
|---|---|---|
| **Himasim**（华大九天） | 功能仿真 + 逻辑综合（赛题核心，差异化集成） | sim / synth |
| iverilog | 语法检查 + 仿真 | lint / sim |
| Verilator | 快速 lint + C++ 仿真 | lint / sim |
| Yosys | RTL 综合 / 门级 | synth |
| SymbiYosys（阶段三） | bounded formal / assertion check | formal |

闭环规则：语法错误返回**带注释代码片段**（标注错误行 ±N 行上下文）；仿真失败**自动触发波形追踪**并建议 `trace_level`；由 `validate_correct_parse` 判定 `[Compiled Success]` + `[Function Check Success]` 是否通过。

---

## 10. 错误分类与自动修复体系

不把报错原样回灌模型。每类错误配专属 repair prompt/skill：

| 错误类别 | 归因依据 | 修复策略 |
|---|---|---|
| 语法错误 | 编译器报错行 | Playbook 语法规则 + 上下文片段重写 |
| 位宽错误 | width warning | 位宽规则 + 历史案例 |
| 时序逻辑错误 | 波形追踪 + 时序元件识别 | always_ff/复位/边沿修复模板 |
| 组合环 | 综合报错 | 拆环 / 寄存器插入 |
| 锁存器推断 | latch 警告 | 补全 default/else，always_comb |
| 不可综合语法 | Yosys/Himasim 限制 | 替换为可综合等价写法 |
| TB mismatch | VCD golden vs DUT | 波形回溯定位信号 |
| spec mismatch | KG 契约校验 | 回溯到契约/KG 修正 |

每次修复产出 diff，进入数据闭环（§14）。

---

## 11. 上下文管理（Context Router）

Verilog 项目上下文极易污染（spec/接口/波形/报错/历史代码）。Context Router 规则：

- **默认启用 Graphify**：模型可自主调用 Graphify 查询仓库/文档级上下文图，定位相关源码、prompt、Playbook 规则和设计文档；调用结果必须先经 Context Router 裁剪。
- 当前子任务**只加载**：相关端口契约 + 依赖模块接口 + 上一子任务输出 + 失败日志 + 相关约束 + 命中的 Playbook 切片。
- **不做**：整仓库 / 整本 LRM / 全量波形塞入。
- 信号级增量生成天然限制单次上下文规模（每子任务一个信号）。

---

## 12. 多模态输入（UI 第 5 屏）

- **PDF 规格书 / 时序图识别**：Qwen3-VL 解析为结构化实体（模块、端口、时序条件如 START/STOP/ACK）。
- **语义结构化**：Kimi/GLM 将解析结果归一为契约草案。
- **KG 构建**：Planner 据此构建 KG，再进入标准流水线。
- 支持文本 + PDF + 时序图截图混合输入。

---

## 13. 模型池与国产模型协同（UI 第 6 屏）

- 基于 pi-ai 多 provider，**运行时热切换**。
- 默认分工：Qwen3-Coder（代码生成）/ Kimi/GLM（规划/中文语义/长文本）/ Qwen3-VL（多模态）。
- 本地 vLLM 推理（连续批处理 + 分页注意力）；运行期可零云端模型依赖，安装期通过 npm 获取产品包，并由 uv/PyPI 获取第三方 Python 依赖。
- **系统评估国产模型在 Verilog 任务上的能力边界**——结论沉淀为论文/专利/可复用资产（差异化叙事）。

---

## 14. 数据闭环：RTL Agent Failure Dataset

> 长期护城河不是 prompt，而是「RTL agent failure dataset」。

每次失败结构化记录：`{prompt, spec, KG, 生成代码, 报错, 错误分类, 修复 diff, 是否最终通过, 迭代轮次}`。用途：① 喂回 Playbook 修复库；② 微调/评估国产模型；③ 量化收敛率等产品指标。存储：本地 SQLite + 向量库，离线。

---

## 15. 产品形态与交互（对齐 UI v0.9.0）

三种模式：**TUI**（探索式）/ **CLI**（CI/CD 批处理）/ **HTTP Server**（内网 API）。S4 产品形态以 npm 一键安装为目标；TS 主体、Python worker 源码与魔改 pyverilog 随 npm 分发，第三方 Python 依赖与 Graphify 从 PyPI 自举，不走 Docker。

| 屏 | 界面 | 设计要点 |
|---|---|---|
| 1 | TUI 主界面 | 左侧 Agent 流水线状态（Planner✓/Coder✓/Verifier⟳/Debugger·）+ 运行配置 + 会话历史；主区对话流 + 实时代码 |
| 2 | 代码生成 | 左 RTL，右 **KG 端口契约表**（方向/位宽/语义 + 一致性校验：位宽方向 100% 对齐、无接口幻觉、无 latch/组合环） |
| 3 | 仿真闭环 | 迭代日志（FAIL→定位→修复建议→PASS）+ 指标卡（功能/综合/覆盖率/门级数/收敛轮次）+ 波形片段 |
| 4 | 知识图谱 | KG 可视化（顶层/子模块/端口/约束节点）+ 图谱统计——**可解释性**核心展示 |
| 5 | 多模态输入 | PDF 预览 + AI 结构化提取结果 + KG 构建进度 |
| 6 | 系统设置 | pi 工具配置（Himasim/iverilog/Verilator/Yosys/FPGA）+ Graphify 索引状态 + 模型池 + 私有化部署 + 推理服务 |

---

## 16. 评测体系

不靠主观感觉，建立基线：

- **CVDP**（NVIDIA）：覆盖 RTL generation / verification / debugging / spec alignment，作主基线（论文指出当前模型 Verilog pass@1 仍低，恰说明工具闭环 + agentic workflow 的价值）。
- **VerilogEval v2 (Human)**：补充用例（含 K-map 提取、FSM 特殊处理）。
- **自建指标**：仿真通过率、综合通过率、平均收敛轮次、覆盖率、接口幻觉率（KG 前后对比）。

---

## 17. 路线图（对齐里程碑）

| 阶段 | 时间 | 目标 | 对应能力 |
|---|---|---|---|
| 一：基础闭环 | 2026.05–06.03 | NL 规格 → RTL + TB → 自动仿真 → 失败自动修复 3–5 轮 | pi + Himasim/iverilog 闭环 baseline |
| 二：Design Contract | 06.04–06.17 | 先出契约表/时钟复位约定/FSM 说明再写代码；KG 原型；国产模型基线 | §5/§6/§8 |
| 三：Formal/Assertion | 06.18–07.10（初赛） | 简单模块生成 SVA，SymbiYosys bounded check；报名材料/PPT/视频 | §9 formal |
| 四：企业级知识库 + 硬件 | 07.11–09.04（复赛/决赛） | 接入企业 RTL 模板/板卡约束/IP/规范/历史 bug；FPGA 硬件在环；多模态打磨 | §8②③/§12/数据闭环 |

---

## 18. 从 VerilogCoder 吸收的精华清单

| 精华 | 吸收方式 | 落点 |
|---|---|---|
| 信号级增量代码生成（每子任务一个信号，DAG 顺序，PreviousTaskOutput 注入） | 作为 Coder 默认生成策略 | §4/§5/§11 |
| KG 增强规划（Plan/Signal/StateTransition/SignalExample + BFS 检索） | 融入 Spec-Anchored KG | §6 |
| **AST 波形追踪调试**（控制流图 + 多级信号回溯 + VCD 对比 + 调试报告） | 作为支柱二 | §7 |
| 时序元件自动识别（posedge/negedge/latch） | Planner 工具 | §7 |
| 语法-仿真-验证闭环（带注释报错、自动触发追踪、validate 判定） | 工具层 | §9 |
| 硬件专属 Prompt（K-map 提取、FSM 规则、always@(*)、禁 typedef enum、强制 localparam） | 写入 Playbook + Agent prompt | §8 |

---

## 19. 风险与对策

| 风险 | 对策 |
|---|---|
| 国产模型 Verilog pass@1 偏低 | 工具闭环 + 多轮修复 + Playbook 兜底；多模型协同；评测驱动选型 |
| Himasim 集成/授权 | 提前打通受管 tool runner；iverilog/Verilator 作开源回退 |
| 上下文污染导致跑偏 | Context Router + 信号级增量（§11） |
| 接口幻觉（层次化设计） | KG 契约硬约束 + 实例化端口一致性校验（§6） |
| 跟随 pi 上游升级的兼容性 | 只用 extensions/skills/prompts 扩展，不 fork 核心 |

---

## 附：一句话总纲

> **VeriGen 要做的不是 Verilog 版 Copilot，而是「RTL 设计-验证-修复流水线 Agent」——以 Spec-Anchored KG 抑制幻觉、以 AST 波形追踪闭环调试、以工程化 Playbook 替代原始文档、以国产模型 + npm 一键安装路径落地产业。**
