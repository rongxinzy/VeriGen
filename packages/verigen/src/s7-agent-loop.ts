import { type EdaToolIssue, type EdaToolIssueKind, type EdaToolRunResult, runIverilogVvp } from "./eda-toolrunner.ts";
import {
	buildCodegenQualityProbePrompt,
	buildCodegenQualityProbeTestbench,
	type CodegenProbeLlmConfig,
	type CodegenProbeModuleContract,
	type CodegenQualityProbeCase,
	generateCodegenQualityProbeRtl,
	getCodegenQualityProbeCase,
	normalizeGeneratedRtl,
	type RunCodegenQualityProbeOptions,
} from "./quality-probe.ts";

export type VerigenLoopAgent = "planner" | "coder" | "verifier" | "debugger";

export type VerigenFixLoopStatus = "pass" | "fail" | "missing_tool";

export type VerigenFixLoopFailureType = EdaToolIssueKind | "unknown" | "max_rounds";

export interface VerigenPlanKgNode {
	id: string;
	kind: "module" | "port" | "constraint";
	label: string;
}

export interface VerigenAgentPlan {
	caseId: string;
	title: string;
	spec: string;
	moduleContract: CodegenProbeModuleContract;
	kgSeed: VerigenPlanKgNode[];
}

export interface VerigenDebuggerFeedback {
	failureType: VerigenFixLoopFailureType;
	summary: string;
	repairPrompt: string;
	issue?: EdaToolIssue;
}

export interface VerigenCoderInput {
	plan: VerigenAgentPlan;
	round: number;
	maxRounds: number;
	prompt: string;
	previousFeedback?: VerigenDebuggerFeedback;
}

export type VerigenCoder = (input: VerigenCoderInput) => Promise<string> | string;

export interface VerigenFixLoopAttempt {
	round: number;
	coderPrompt: string;
	rtl: string;
	verifierResult: EdaToolRunResult;
	failureType?: VerigenFixLoopFailureType;
	debuggerFeedback?: VerigenDebuggerFeedback;
}

export interface VerigenFixLoopEvent {
	agent: VerigenLoopAgent;
	round?: number;
	action: string;
	summary: string;
}

export interface RunCodegenQualityProbeFixLoopOptions extends RunCodegenQualityProbeOptions {
	maxRounds?: number;
	generateRtl?: VerigenCoder;
}

export interface VerigenFixLoopReport {
	status: VerigenFixLoopStatus;
	case: CodegenQualityProbeCase;
	plan: VerigenAgentPlan;
	maxRounds: number;
	attempts: VerigenFixLoopAttempt[];
	repairRounds: number;
	finalRtl: string | null;
	failureType?: VerigenFixLoopFailureType;
	events: VerigenFixLoopEvent[];
	llm?: CodegenProbeLlmConfig;
}

function clampMaxRounds(value: number | undefined): number {
	if (value === undefined) return 3;
	return Math.min(3, Math.max(1, value));
}

function planFromProbeCase(probeCase: CodegenQualityProbeCase): VerigenAgentPlan {
	const moduleNode: VerigenPlanKgNode = {
		id: `module:${probeCase.moduleContract.moduleName}`,
		kind: "module",
		label: probeCase.moduleContract.moduleName,
	};
	const portNodes: VerigenPlanKgNode[] = probeCase.moduleContract.ports.map((port) => ({
		id: `port:${probeCase.moduleContract.moduleName}.${port.name}`,
		kind: "port",
		label: `${port.direction} ${port.name}[${port.width}]`,
	}));
	const constraintNodes: VerigenPlanKgNode[] = probeCase.moduleContract.notes.map((note, index) => ({
		id: `constraint:${probeCase.id}:${index + 1}`,
		kind: "constraint",
		label: note,
	}));
	return {
		caseId: probeCase.id,
		title: probeCase.title,
		spec: probeCase.spec,
		moduleContract: probeCase.moduleContract,
		kgSeed: [moduleNode, ...portNodes, ...constraintNodes],
	};
}

function mux2Candidate(round: number): string {
	if (round <= 1) {
		return `module mux2 (
  input [7:0] a,
  input [7:0] b,
  input sel,
  output [7:0] y
);
  assign y = sel ? a : b;
endmodule
`;
	}
	return `module mux2 (
  input [7:0] a,
  input [7:0] b,
  input sel,
  output [7:0] y
);
  assign y = sel ? b : a;
endmodule
`;
}

function priorityEncoderCandidate(round: number): string {
	if (round <= 1) {
		return `module priority_encoder4(
  input [3:0] in,
  output reg [1:0] idx,
  output reg valid
);
  always @* begin
    valid = |in;
    idx = 2'd0;
    if (in[0]) idx = 2'd0;
    else if (in[1]) idx = 2'd1;
    else if (in[2]) idx = 2'd2;
    else if (in[3]) idx = 2'd3;
  end
endmodule
`;
	}
	return `module priority_encoder4(
  input [3:0] in,
  output reg [1:0] idx,
  output reg valid
);
  always @* begin
    valid = |in;
    idx = 2'd0;
    if (in[3]) idx = 2'd3;
    else if (in[2]) idx = 2'd2;
    else if (in[1]) idx = 2'd1;
    else idx = 2'd0;
  end
endmodule
`;
}

function counterCandidate(round: number): string {
	if (round <= 1) {
		return `module counter8_en(
  input clk,
  input rst,
  input en,
  output reg [7:0] q
);
  always @(posedge clk) begin
    if (rst) q <= 8'h00;
    else q <= q + 8'h01;
  end
endmodule
`;
	}
	return `module counter8_en(
  input clk,
  input rst,
  input en,
  output reg [7:0] q
);
  always @(posedge clk) begin
    if (rst) q <= 8'h00;
    else if (en) q <= q + 8'h01;
  end
endmodule
`;
}

function shiftRegisterCandidate(round: number): string {
	if (round <= 1) {
		return `module shift_reg8(
  input clk,
  input clr,
  input din,
  output reg [7:0] q
);
  always @(posedge clk) begin
    if (clr) q <= 8'h00;
    else q <= {din, q[7:1]};
  end
endmodule
`;
	}
	return `module shift_reg8(
  input clk,
  input clr,
  input din,
  output reg [7:0] q
);
  always @(posedge clk) begin
    if (clr) q <= 8'h00;
    else q <= {q[6:0], din};
  end
endmodule
`;
}

function scriptedCandidate(caseId: string, round: number): string {
	if (caseId === "l0-mux2") return mux2Candidate(round);
	if (caseId === "l0-priority-encoder") return priorityEncoderCandidate(round);
	if (caseId === "l1-counter") return counterCandidate(round);
	if (caseId === "l1-shift-register") return shiftRegisterCandidate(round);
	throw new Error(`No scripted S7 fix-loop candidate for Codegen Quality Probe case ${caseId}`);
}

function firstIssue(result: EdaToolRunResult): EdaToolIssue | undefined {
	return result.issues.find((issue) => issue.severity === "error") ?? result.issues[0];
}

function failureTypeFor(result: EdaToolRunResult): VerigenFixLoopFailureType {
	const issue = firstIssue(result);
	return issue?.kind ?? "unknown";
}

function formatIssue(issue: EdaToolIssue | undefined): string {
	if (!issue) return "verifier failed without a structured issue";
	const location = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : issue.tool;
	const snippet = issue.snippet ? `\nSnippet:\n${issue.snippet}` : "";
	return `${issue.kind} from ${location}: ${issue.message}${snippet}`;
}

function buildRepairPrompt(
	plan: VerigenAgentPlan,
	round: number,
	maxRounds: number,
	rtl: string,
	verifierResult: EdaToolRunResult,
): VerigenDebuggerFeedback {
	const issue = firstIssue(verifierResult);
	const failureType = failureTypeFor(verifierResult);
	const issueText = formatIssue(issue);
	const repairPrompt = [
		"You are VeriGen Debugger + Coder.",
		"Repair the RTL while preserving the module contract exactly.",
		`Task: ${plan.title}`,
		`Round ${round} failed; ${maxRounds - round} repair round(s) remain.`,
		`Failure type: ${failureType}`,
		"",
		"Verifier issue",
		issueText,
		"",
		"Module contract",
		`module: ${plan.moduleContract.moduleName}`,
		...plan.moduleContract.ports.map((port) => `- ${port.direction} ${port.name} width=${port.width}`),
		"",
		"Previous RTL",
		rtl,
		"",
		"Return one complete synthesizable Verilog module only. Do not include markdown fences.",
	].join("\n");
	return {
		failureType,
		summary: issueText,
		repairPrompt,
		...(issue ? { issue } : {}),
	};
}

function buildVerifierInput(probeCase: CodegenQualityProbeCase, rtl: string): Parameters<typeof runIverilogVvp>[0] {
	return {
		rtl: [{ filename: `${probeCase.moduleContract.moduleName}.v`, content: normalizeGeneratedRtl(rtl) }],
		testbench: [
			{
				filename: `${probeCase.moduleContract.moduleName}_tb.v`,
				content: buildCodegenQualityProbeTestbench(probeCase.id),
			},
		],
		top: "tb",
	};
}

async function generateAttemptRtl(
	input: VerigenCoderInput,
	options: RunCodegenQualityProbeFixLoopOptions,
): Promise<{ rtl: string; llm?: CodegenProbeLlmConfig }> {
	if (options.generateRtl) {
		return { rtl: normalizeGeneratedRtl(await options.generateRtl(input)) };
	}
	if (options.live) {
		const generated = await generateCodegenQualityProbeRtl(input.prompt, options);
		return { rtl: generated.generatedRtl, llm: generated.llm };
	}
	return { rtl: scriptedCandidate(input.plan.caseId, input.round) };
}

export async function runCodegenQualityProbeFixLoop(
	caseId: string,
	options: RunCodegenQualityProbeFixLoopOptions = {},
): Promise<VerigenFixLoopReport> {
	const probeCase = getCodegenQualityProbeCase(caseId);
	const plan = planFromProbeCase(probeCase);
	const maxRounds = clampMaxRounds(options.maxRounds);
	const attempts: VerigenFixLoopAttempt[] = [];
	const events: VerigenFixLoopEvent[] = [
		{
			agent: "planner",
			action: "plan",
			summary: `Created module contract and KG seed for ${probeCase.moduleContract.moduleName}`,
		},
	];
	let previousFeedback: VerigenDebuggerFeedback | undefined;
	let llm: CodegenProbeLlmConfig | undefined;

	for (let round = 1; round <= maxRounds; round += 1) {
		const coderPrompt = previousFeedback?.repairPrompt ?? buildCodegenQualityProbePrompt(probeCase);
		events.push({ agent: "coder", round, action: "generate", summary: `Generated candidate RTL round ${round}` });
		const generated = await generateAttemptRtl(
			{ plan, round, maxRounds, prompt: coderPrompt, previousFeedback },
			options,
		);
		if (generated.llm) llm = generated.llm;
		const verifierResult = await runIverilogVvp(buildVerifierInput(probeCase, generated.rtl));
		events.push({
			agent: "verifier",
			round,
			action: "compile_sim",
			summary: verifierResult.ok ? "compile/sim passed" : `${failureTypeFor(verifierResult)} failed`,
		});

		if (verifierResult.ok) {
			attempts.push({
				round,
				coderPrompt,
				rtl: generated.rtl,
				verifierResult,
			});
			return {
				status: "pass",
				case: probeCase,
				plan,
				maxRounds,
				attempts,
				repairRounds: Math.max(0, round - 1),
				finalRtl: generated.rtl,
				events,
				...(llm ? { llm } : {}),
			};
		}

		const debuggerFeedback = buildRepairPrompt(plan, round, maxRounds, generated.rtl, verifierResult);
		events.push({
			agent: "debugger",
			round,
			action: "repair_prompt",
			summary: debuggerFeedback.summary,
		});
		attempts.push({
			round,
			coderPrompt,
			rtl: generated.rtl,
			verifierResult,
			failureType: debuggerFeedback.failureType,
			debuggerFeedback,
		});
		previousFeedback = debuggerFeedback;
	}

	const lastAttempt = attempts[attempts.length - 1];
	const lastFailure = lastAttempt?.failureType ?? "max_rounds";
	return {
		status: lastFailure === "missing_tool" ? "missing_tool" : "fail",
		case: probeCase,
		plan,
		maxRounds,
		attempts,
		repairRounds: Math.max(0, attempts.length - 1),
		finalRtl: lastAttempt?.rtl ?? null,
		failureType: lastFailure,
		events,
		...(llm ? { llm } : {}),
	};
}

export function renderVerigenFixLoopReport(report: VerigenFixLoopReport): string {
	const lines = [
		`VeriGen S7 Fix Loop: ${report.case.id}`,
		`Status: ${report.status}`,
		`Repair rounds: ${report.repairRounds}/${report.maxRounds - 1}`,
		`Module: ${report.plan.moduleContract.moduleName}`,
		"",
		"Agent events",
		...report.events.map((event) => {
			const round = event.round ? ` round=${event.round}` : "";
			return `- ${event.agent}${round} ${event.action}: ${event.summary}`;
		}),
		"",
		"Attempts",
		...report.attempts.map((attempt) => {
			const result = attempt.verifierResult.ok ? "pass" : (attempt.failureType ?? "unknown");
			return `- round ${attempt.round}: ${result}`;
		}),
		"",
		"Final RTL",
		report.finalRtl ?? "[no RTL generated]",
	];
	return lines.join("\n");
}
