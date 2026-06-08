import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { LocalIndex, type MetadataFilter, type MetadataTypes, type QueryResult } from "vectra";
import { z } from "zod";

export const playbookCategories = ["language", "engineering", "tool", "debug"] as const;

export const PlaybookRuleSchema = z.object({
	id: z.string().min(1),
	category: z.enum(playbookCategories),
	title: z.string().min(1),
	triggers: z.array(z.string()).default([]),
	bad: z.string().optional(),
	good: z.string().min(1),
	check: z.array(z.string()).default([]),
	toolErr: z.string().optional(),
	fix: z.string().min(1),
});

export type PlaybookCategory = (typeof playbookCategories)[number];
export type PlaybookRule = z.infer<typeof PlaybookRuleSchema>;

export interface PlaybookSearchOptions {
	topK?: number;
	category?: PlaybookCategory;
	triggers?: string[];
}

export interface PlaybookSearchResult {
	rule: PlaybookRule;
	score: number;
}

export type PlaybookRuleMetadata = Record<string, MetadataTypes> & {
	id: string;
	category: PlaybookCategory;
	title: string;
	triggers: string;
	text: string;
	ruleJson: string;
};

const vectorDimensions = 64;

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_@$]+/)
		.filter((token) => token.length > 1);
}

function hashToken(token: string): number {
	let hash = 2166136261;
	for (let index = 0; index < token.length; index += 1) {
		hash ^= token.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

export function embedPlaybookText(text: string): number[] {
	const vector = Array.from({ length: vectorDimensions }, () => 0);
	for (const token of tokenize(text)) {
		const hash = hashToken(token);
		const index = hash % vectorDimensions;
		vector[index] += (hash & 1) === 0 ? 1 : -1;
	}
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
	return norm === 0 ? vector : vector.map((value) => value / norm);
}

function ruleText(rule: PlaybookRule): string {
	const sections = [
		rule.title,
		rule.category,
		rule.triggers.join(" "),
		rule.bad ?? "",
		rule.good,
		rule.check.join(" "),
		rule.toolErr ?? "",
		rule.fix,
	];
	return sections.filter(Boolean).join("\n");
}

function metadataFromRule(rule: PlaybookRule): PlaybookRuleMetadata {
	return {
		id: rule.id,
		category: rule.category,
		title: rule.title,
		triggers: rule.triggers.join(","),
		text: ruleText(rule),
		ruleJson: JSON.stringify(rule),
	};
}

function ruleFromMetadata(metadata: PlaybookRuleMetadata): PlaybookRule {
	return PlaybookRuleSchema.parse(JSON.parse(metadata.ruleJson));
}

function filterFromOptions(options?: PlaybookSearchOptions): MetadataFilter | undefined {
	if (!options?.category) return undefined;
	return { category: { $eq: options.category } };
}

function triggerScore(rule: PlaybookRule, triggers: string[] | undefined): number {
	if (!triggers || triggers.length === 0) return 0;
	const triggerSet = new Set(rule.triggers.map((trigger) => trigger.toLowerCase()));
	return triggers.filter((trigger) => triggerSet.has(trigger.toLowerCase())).length * 0.05;
}

export class PlaybookRag {
	private index: LocalIndex<PlaybookRuleMetadata>;

	constructor(indexPath: string) {
		this.index = new LocalIndex<PlaybookRuleMetadata>(indexPath);
	}

	async reset(): Promise<void> {
		await rm(this.index.folderPath, { recursive: true, force: true });
	}

	async ensureIndex(): Promise<void> {
		await mkdir(this.index.folderPath, { recursive: true });
		if (!(await this.index.isIndexCreated())) {
			await this.index.createIndex({ version: 1, metadata_config: { indexed: ["id", "category", "title"] } });
		}
	}

	async indexRules(rules: PlaybookRule[]): Promise<void> {
		await this.ensureIndex();
		for (const rule of rules.map((item) => PlaybookRuleSchema.parse(item))) {
			await this.index.upsertItem({
				id: rule.id,
				vector: embedPlaybookText(ruleText(rule)),
				metadata: metadataFromRule(rule),
			});
		}
	}

	async search(query: string, options: PlaybookSearchOptions = {}): Promise<PlaybookSearchResult[]> {
		await this.ensureIndex();
		const topK = options.topK ?? 5;
		const vector = embedPlaybookText([query, ...(options.triggers ?? [])].join(" "));
		const results = await this.index.queryItems<PlaybookRuleMetadata>(
			vector,
			query,
			topK,
			filterFromOptions(options),
			false,
		);
		return results.map((result) => this.resultFromQuery(result, options.triggers));
	}

	private resultFromQuery(
		result: QueryResult<PlaybookRuleMetadata>,
		triggers: string[] | undefined,
	): PlaybookSearchResult {
		const stored = defaultPlaybookRules.find((rule) => rule.id === result.item.metadata.id);
		const rule = stored ?? ruleFromMetadata(result.item.metadata);
		return {
			rule,
			score: result.score + triggerScore(rule, triggers),
		};
	}
}

export const defaultPlaybookRules: PlaybookRule[] = [
	{
		id: "fsm-localparam-case",
		category: "engineering",
		title: "FSMs use explicit localparam state encodings and complete case branches",
		triggers: ["fsm", "state", "case", "latch"],
		bad: "Implicit state encodings or incomplete case statements infer latches and hide illegal transitions.",
		good: "Declare states with localparam, reset the state register explicitly, and cover every state plus default.",
		check: [
			"state register reset exists",
			"default branch exists",
			"next-state logic assigns every output on every path",
		],
		toolErr: "latch inferred for signal ...",
		fix: "Add default assignments at the top of combinational blocks and a default case that returns to reset state.",
	},
	{
		id: "width-explicit-casts",
		category: "language",
		title: "Width-sensitive arithmetic must size constants and intermediate wires explicitly",
		triggers: ["width", "signed", "truncate", "extend"],
		bad: "assign sum = a + 1;",
		good: "assign sum = a + WIDTH'(1);",
		check: [
			"constants have explicit width",
			"signed operands match",
			"output width accounts for carry when required",
		],
		toolErr: "width mismatch or truncation warning",
		fix: "Introduce a sized localparam or explicitly sized cast and widen intermediate signals before truncating intentionally.",
	},
	{
		id: "seq-nonblocking",
		category: "language",
		title: "Sequential logic uses nonblocking assignments with explicit reset behavior",
		triggers: ["posedge", "reset", "nonblocking", "ff"],
		bad: "always @(posedge clk) q = d;",
		good: "always @(posedge clk) begin if (!rst_n) q <= '0; else q <= d; end",
		check: [
			"all registers assigned with <=",
			"reset polarity matches contract",
			"no combinational assignment inside sequential block",
		],
		toolErr: "simulation mismatch around clock edge",
		fix: "Replace blocking assignments in clocked blocks with nonblocking assignments and align reset polarity with the contract.",
	},
	{
		id: "tb-mismatch-wave-trace",
		category: "debug",
		title: "TB mismatch repair starts from traced DUT output and controller signals",
		triggers: ["mismatch", "waveform", "debugger", "trace"],
		good: "Use the trimmed trace context first: mismatch_time, ref/dut values, signal controllers, and RTL snippets.",
		check: ["do not inspect full VCD manually", "map each proposed fix to a traced controller or snippet"],
		toolErr: "Hint: Output ... has mismatches",
		fix: "Patch the nearest traced assignment or state transition, then rerun simulation before changing unrelated code.",
	},
	{
		id: "tool-subset-sv",
		category: "tool",
		title: "Stay inside the parser/simulator supported synthesizable subset",
		triggers: ["yosys", "iverilog", "himasim", "systemverilog", "unsupported"],
		good: "Prefer plain module ports, localparam, always @(*)/always @(posedge clk), packed vectors, and synthesizable assigns.",
		check: [
			"avoid interface/modport unless tool support is confirmed",
			"avoid typedef enum if Verilog-only mode is required",
		],
		toolErr: "syntax error or unsupported SystemVerilog feature",
		fix: "Rewrite unsupported SV constructs into equivalent Verilog-2005 compatible code before retrying tools.",
	},
];

export function defaultPlaybookIndexPath(root: string): string {
	return join(root, ".verigen", "playbook-index");
}
