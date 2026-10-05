// Dashboard summary: verdict counts, rejection reasons, and median push-to-verdict time.
// Uses each agent's latest verdict.
import type { VerdictRow } from "./store";

export interface Summary {
	counts: { agents: number; verified: number; rejected: number; needs_review: number; merged: number; merge_rejected: number; waiting: number };
	reasons: Record<string, number>;
	medianPushToVerdictMs: number | null;
}

function median(xs: number[]): number | null {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Reason codes for one verdict: rule findings, LLM answers that blocked it, and merge outcomes.
export function reasonsOf(v: Pick<VerdictRow, "findings" | "llm" | "verdict" | "merge_status">): string[] {
	const r = v.findings.map((f) => f.code as string);
	if (v.verdict === "rejected" && v.llm.some((j) => j.matches === "no")) r.push("LLM_NO");
	if (v.verdict === "needs_review") r.push(v.llm.some((j) => j.error) ? "LLM_ERROR" : "LLM_UNCLEAR");
	if (v.merge_status === "conflict") r.push("MERGE_CONFLICT");
	if (v.merge_status === "error") r.push("MERGE_ERROR");
	return [...new Set(r)];
}

export function summarize(verdicts: VerdictRow[], agentIds?: string[]): Summary {
	const latest = new Map<string, VerdictRow>();
	for (const v of verdicts) latest.set(v.fork, v); // verdicts arrive in order; the last one wins
	const rows = [...latest.values()];
	const agents = agentIds?.length ?? rows.length;

	const counts = { agents, verified: 0, rejected: 0, needs_review: 0, merged: 0, merge_rejected: 0, waiting: Math.max(0, agents - rows.length) };
	const reasons: Record<string, number> = {};
	const latencies: number[] = [];
	for (const v of rows) {
		counts[v.verdict]++;
		if (v.merge_status === "merged") counts.merged++;
		if (v.merge_status === "conflict") counts.merge_rejected++;
		for (const code of reasonsOf(v)) reasons[code] = (reasons[code] ?? 0) + 1;
		if (v.pushed_at) latencies.push(Date.parse(v.created_at) - Date.parse(v.pushed_at));
	}
	const sorted = Object.fromEntries(Object.entries(reasons).sort(([a], [b]) => a.localeCompare(b)));
	return { counts, reasons: sorted, medianPushToVerdictMs: median(latencies) };
}
