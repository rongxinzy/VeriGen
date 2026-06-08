#!/usr/bin/env node
import { inspect } from "node:util";
import { GraphifyContext } from "./graphify-context.ts";
import { bootstrapPythonWorker, type DoctorCheck, doctorVerigenInstall } from "./python-worker-bootstrap.ts";
import { VerilogAnalysis } from "./verilog-analysis-client.ts";

function printHelp(): void {
	console.log(`Usage: verigen <command> [options]

Commands:
  doctor           Check Node, uv, iverilog/vvp, worker bootstrap, and Graphify status
  worker-smoke     Bootstrap the worker and run one parse_ast JSONL request
  graphify-status  Print the default Graphify index status for the current repo
  graphify-query   Search the Graphify index
  graphify-explain Explain a Graphify node by id or path
  graphify-path    Find a Graphify path between two nodes
  graphify-update  Rebuild the Graphify index with uvx graphify

Options:
  --no-bootstrap   Do not create the Python worker cache venv
  --json           Print machine-readable JSON
  --max-results N  Limit Graphify query/explain results
  --max-depth N    Limit Graphify path search depth
  --help           Show this help
`);
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

function optionValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index < 0) return undefined;
	return args[index + 1];
}

function numberOption(args: string[], flag: string): number | undefined {
	const value = optionValue(args, flag);
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function positionalArgs(args: string[]): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const value = args[index];
		if (!value) continue;
		if (value === "--json" || value === "--no-bootstrap" || value === "--help") continue;
		if (value === "--max-results" || value === "--max-depth") {
			index += 1;
			continue;
		}
		values.push(value);
	}
	return values;
}

function checkPrefix(check: DoctorCheck): string {
	if (check.state === "ok") return "OK";
	if (check.state === "warn") return "WARN";
	return "ERROR";
}

function printDoctorChecks(checks: DoctorCheck[]): void {
	for (const check of checks) {
		console.log(`${checkPrefix(check)} ${check.name}: ${check.message}`);
	}
}

async function runDoctor(args: string[]): Promise<number> {
	const result = await doctorVerigenInstall({ bootstrap: !hasFlag(args, "--no-bootstrap") });
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		printDoctorChecks(result.checks);
	}
	return result.ok ? 0 : 1;
}

async function runWorkerSmoke(args: string[]): Promise<number> {
	const launch = await bootstrapPythonWorker({ bootstrap: !hasFlag(args, "--no-bootstrap") });
	const worker = new VerilogAnalysis({
		command: launch.command,
		args: launch.args,
		workerCwd: launch.cwd,
		requestTimeoutMs: 60_000,
	});
	try {
		const result = await worker.parseAst({
			rtl: "module TopModule(input wire a, output wire y); assign y = a; endmodule",
			top: "TopModule",
		});
		if (hasFlag(args, "--json")) {
			console.log(JSON.stringify({ ok: true, result }, null, 2));
		} else {
			console.log(`OK worker-smoke: parsed ${result.modules.length} module(s)`);
		}
		return result.ast_ok ? 0 : 1;
	} finally {
		await worker.close();
	}
}

async function runGraphifyStatus(args: string[]): Promise<number> {
	const status = await new GraphifyContext({ repoRoot: process.cwd() }).status();
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(status, null, 2));
	} else {
		console.log(inspect(status, { colors: false, depth: null }));
	}
	return status.state === "invalid_index" ? 1 : 0;
}

async function runGraphifyQuery(args: string[]): Promise<number> {
	const query = positionalArgs(args).join(" ");
	if (!query) {
		console.error("graphify-query requires a query string");
		return 1;
	}
	const result = await new GraphifyContext({ repoRoot: process.cwd() }).query(
		query,
		numberOption(args, "--max-results"),
	);
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(inspect(result, { colors: false, depth: null }));
	}
	return result.status.state === "invalid_index" ? 1 : 0;
}

async function runGraphifyExplain(args: string[]): Promise<number> {
	const [idOrPath] = positionalArgs(args);
	if (!idOrPath) {
		console.error("graphify-explain requires a node id or path");
		return 1;
	}
	const result = await new GraphifyContext({ repoRoot: process.cwd() }).explain(
		idOrPath,
		numberOption(args, "--max-results"),
	);
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(inspect(result, { colors: false, depth: null }));
	}
	return result.status.state === "invalid_index" ? 1 : 0;
}

async function runGraphifyPath(args: string[]): Promise<number> {
	const [source, target] = positionalArgs(args);
	if (!source || !target) {
		console.error("graphify-path requires source and target node ids or paths");
		return 1;
	}
	const result = await new GraphifyContext({ repoRoot: process.cwd() }).path(
		source,
		target,
		numberOption(args, "--max-depth"),
	);
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(inspect(result, { colors: false, depth: null }));
	}
	return result.status.state === "invalid_index" ? 1 : 0;
}

async function runGraphifyUpdate(args: string[]): Promise<number> {
	const [target] = positionalArgs(args);
	const result = await new GraphifyContext({ repoRoot: process.cwd() }).update(target);
	if (hasFlag(args, "--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(inspect(result, { colors: false, depth: null }));
	}
	return result.ok ? 0 : 1;
}

async function main(args: string[]): Promise<number> {
	const command = args[0] ?? "doctor";
	if (command === "--help" || command === "-h" || hasFlag(args, "--help")) {
		printHelp();
		return 0;
	}
	if (command === "doctor") return await runDoctor(args.slice(1));
	if (command === "worker-smoke") return await runWorkerSmoke(args.slice(1));
	if (command === "graphify-status") return await runGraphifyStatus(args.slice(1));
	if (command === "graphify-query") return await runGraphifyQuery(args.slice(1));
	if (command === "graphify-explain") return await runGraphifyExplain(args.slice(1));
	if (command === "graphify-path") return await runGraphifyPath(args.slice(1));
	if (command === "graphify-update") return await runGraphifyUpdate(args.slice(1));
	console.error(`Unknown command: ${command}`);
	printHelp();
	return 1;
}

main(process.argv.slice(2))
	.then((exitCode) => {
		process.exitCode = exitCode;
	})
	.catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exitCode = 1;
	});
