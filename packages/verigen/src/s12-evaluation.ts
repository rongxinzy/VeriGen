import { defaultCodegenQualityProbeCases } from "./quality-probe.ts";
import {
	runCodegenQualityProbeFixLoop,
	type VerigenFixLoopFailureType,
	type VerigenFixLoopReport,
} from "./s7-agent-loop.ts";

export type EvaluationSuiteId = "smoke" | "roadmap";

export interface EvaluationCaseResult {
	caseId: string;
	status: "pass" | "fail" | "missing_tool";
	passAt1: boolean;
	convergedWithin3: boolean;
	repairRounds: number;
	failureTypes: VerigenFixLoopFailureType[];
}

export interface EvaluationMetrics {
	total: number;
	passed: number;
	passAt1: number;
	convergedWithin3: number;
	passAt1Rate: number;
	convergenceRate: number;
	averageRepairRounds: number;
	failureTypeDistribution: Record<string, number>;
}

export interface EvaluationSuiteReport {
	suite: EvaluationSuiteId;
	caseVersion: string;
	cases: EvaluationCaseResult[];
	metrics: EvaluationMetrics;
	failureSamples: Array<{
		caseId: string;
		failureTypes: VerigenFixLoopFailureType[];
		replayHint: string;
	}>;
}

function suiteCaseIds(suite: EvaluationSuiteId): string[] {
	if (suite === "smoke") return ["l0-mux2", "l1-counter"];
	return defaultCodegenQualityProbeCases.map((probeCase) => probeCase.id);
}

function resultFromFixLoop(report: VerigenFixLoopReport): EvaluationCaseResult {
	const failureTypes = report.attempts
		.map((attempt) => attempt.failureType)
		.filter((failureType): failureType is VerigenFixLoopFailureType => Boolean(failureType));
	return {
		caseId: report.case.id,
		status: report.status,
		passAt1: report.status === "pass" && report.attempts.length === 1,
		convergedWithin3: report.status === "pass" && report.attempts.length <= 3,
		repairRounds: report.repairRounds,
		failureTypes,
	};
}

export function calculateEvaluationMetrics(cases: EvaluationCaseResult[]): EvaluationMetrics {
	const total = cases.length;
	const passed = cases.filter((item) => item.status === "pass").length;
	const passAt1 = cases.filter((item) => item.passAt1).length;
	const convergedWithin3 = cases.filter((item) => item.convergedWithin3).length;
	const repairRoundSum = cases.reduce((sum, item) => sum + item.repairRounds, 0);
	const failureTypeDistribution: Record<string, number> = {};
	for (const item of cases) {
		for (const failureType of item.failureTypes) {
			failureTypeDistribution[failureType] = (failureTypeDistribution[failureType] ?? 0) + 1;
		}
	}
	return {
		total,
		passed,
		passAt1,
		convergedWithin3,
		passAt1Rate: total === 0 ? 0 : passAt1 / total,
		convergenceRate: total === 0 ? 0 : convergedWithin3 / total,
		averageRepairRounds: total === 0 ? 0 : repairRoundSum / total,
		failureTypeDistribution,
	};
}

export async function runEvaluationSuite(suite: EvaluationSuiteId = "smoke"): Promise<EvaluationSuiteReport> {
	const results: EvaluationCaseResult[] = [];
	for (const caseId of suiteCaseIds(suite)) {
		const report = await runCodegenQualityProbeFixLoop(caseId);
		results.push(resultFromFixLoop(report));
	}
	const metrics = calculateEvaluationMetrics(results);
	return {
		suite,
		caseVersion: "verigen-quality-probe-v1",
		cases: results,
		metrics,
		failureSamples: results
			.filter((item) => item.status !== "pass" || item.failureTypes.length > 0)
			.map((item) => ({
				caseId: item.caseId,
				failureTypes: item.failureTypes,
				replayHint: `verigen quality-probe fix-loop --case ${item.caseId} --json`,
			})),
	};
}

function percent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

export function renderEvaluationSuiteReport(report: EvaluationSuiteReport): string {
	return [
		`VeriGen S12 Evaluation Suite: ${report.suite}`,
		`Case version: ${report.caseVersion}`,
		"",
		"Metrics",
		`- total: ${report.metrics.total}`,
		`- passed: ${report.metrics.passed}`,
		`- pass@1: ${report.metrics.passAt1} (${percent(report.metrics.passAt1Rate)})`,
		`- 3-round convergence: ${report.metrics.convergedWithin3} (${percent(report.metrics.convergenceRate)})`,
		`- average repair rounds: ${report.metrics.averageRepairRounds.toFixed(2)}`,
		`- failure types: ${JSON.stringify(report.metrics.failureTypeDistribution)}`,
		"",
		"Cases",
		...report.cases.map(
			(item) =>
				`- ${item.caseId}: ${item.status}, repairRounds=${item.repairRounds}, failures=${item.failureTypes.join(",") || "none"}`,
		),
		"",
		"Failure samples",
		...(report.failureSamples.length > 0
			? report.failureSamples.map((sample) => `- ${sample.caseId}: ${sample.replayHint}`)
			: ["[none]"]),
	].join("\n");
}
