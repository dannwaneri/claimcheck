// Measures the LLM verifier against the real Workers AI model.
// Uses the same judgeChange/decide/unifiedDiff code as the Worker; only the transport differs
// (Workers AI REST API instead of the env.AI binding).
//
// Usage: CF_ACCOUNT_ID=... CF_API_TOKEN=... npx tsx test/llm-cases/run.ts [runs=5] [model]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unifiedDiff } from "../../src/diff";
import { decide, evidenceInDiff, judgeChange, type Judgement } from "../../src/verify/llm";

interface Case {
	id: string;
	kind: string;
	path: string;
	description: string;
	old: string;
	new: string;
	expected: "yes" | "no" | "unclear";
	acceptable?: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const cases: Case[] = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
const runs = Number(process.argv[2] ?? 5);
const model = process.argv[3] ?? "@cf/qwen/qwen3.8-27b";
const { CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;
if (!CF_ACCOUNT_ID || !CF_API_TOKEN) throw new Error("set CF_ACCOUNT_ID and CF_API_TOKEN");

const usage: { neurons: number; prompt: number; completion: number }[] = [];
const ai = {
	async run(m: string, input: unknown) {
		const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${m}`, {
			method: "POST",
			headers: { authorization: `Bearer ${CF_API_TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify(input),
		});
		const body: any = await res.json();
		if (!body.success) throw new Error(JSON.stringify(body.errors));
		const u = body.result.usage ?? {};
		usage.push({ neurons: u.neurons ?? 0, prompt: u.prompt_tokens ?? 0, completion: u.completion_tokens ?? 0 });
		return body.result;
	},
} as unknown as Ai;

type Row = { id: string; kind: string; expected: string; answers: string[]; verdicts: string[]; evidenceOk: boolean[]; errors: string[]; ms: number[] };
const rows: Row[] = [];

for (const c of cases) {
	const diff = unifiedDiff(c.path, c.old, c.new);
	const row: Row = { id: c.id, kind: c.kind, expected: c.expected, answers: [], verdicts: [], evidenceOk: [], errors: [], ms: [] };
	// Runs of one case go in parallel; cases go one after another.
	const results = await Promise.all(
		Array.from({ length: runs }, async () => {
			const t = Date.now();
			const j: Judgement = await judgeChange(ai, model, c.path, c.description, diff);
			return { j, ms: Date.now() - t };
		}),
	);
	for (const { j, ms } of results) {
		row.answers.push(j.error ? "error" : j.matches);
		row.verdicts.push(decide([j], { [c.path]: diff }));
		row.evidenceOk.push(j.evidence ? evidenceInDiff(j.evidence, diff) : false);
		if (j.error) row.errors.push(j.error);
		row.ms.push(ms);
	}
	rows.push(row);
	console.log(`${c.id.padEnd(28)} expected=${c.expected.padEnd(7)} answers=${row.answers.join(",")} evidence=${row.evidenceOk.map((x) => (x ? "Y" : "n")).join("")}`);
}

const ok = (r: Row, a: string) => {
	const c = cases.find((x) => x.id === r.id)!;
	return (c.acceptable ?? [c.expected]).includes(a);
};
const total = rows.reduce((n, r) => n + r.answers.length, 0);
const correct = rows.reduce((n, r) => n + r.answers.filter((a) => ok(r, a)).length, 0);
const flaky = rows.filter((r) => new Set(r.answers).size > 1);
const neurons = usage.reduce((n, u) => n + u.neurons, 0);
const summary = {
	model,
	runs,
	calls: usage.length,
	judgements: total,
	correct,
	flakyCases: flaky.map((r) => r.id),
	flakeRate: flaky.length / rows.length,
	neurons,
	usd: (neurons / 1000) * 0.011,
	avgPromptTokens: usage.reduce((n, u) => n + u.prompt, 0) / usage.length,
	avgCompletionTokens: usage.reduce((n, u) => n + u.completion, 0) / usage.length,
	avgMs: rows.flatMap((r) => r.ms).reduce((a, b) => a + b, 0) / total,
};
console.log(JSON.stringify(summary, null, 2));

mkdirSync(join(here, "results"), { recursive: true });
const out = join(here, "results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
console.log("wrote", out);
