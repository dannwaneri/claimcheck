import { describe, expect, it } from "vitest";
import { summarize } from "../src/summary";
import type { VerdictRow } from "../src/store";

const at = (s: number) => new Date(Date.UTC(2026, 9, 5, 12, 0, s)).toISOString();

function v(agent: string, over: Partial<VerdictRow> = {}, pushS = 0, verdictS = 10): VerdictRow {
	return {
		id: `t1-${agent}@c`, task_id: "t1", agent_id: agent, fork: `t1-${agent}`, commit: "c", summary: "s",
		verdict: "verified", findings: [], llm: [], merge_status: null, merge_detail: null, merged_commit: null,
		pushed_at: at(pushS), created_at: at(verdictS), ...over,
	};
}

const llm = (matches: "yes" | "no" | "unclear") => [{ path: "p", description: "d", matches, evidence: "e", reason: "r" }];

// The five demo agents.
const demo = [
	v("a", { merge_status: "merged", llm: llm("yes") }, 0, 8),
	v("b", { verdict: "rejected", findings: [{ code: "UNCLAIMED_CHANGE", detail: "" }, { code: "PROTECTED_PATH", detail: "" }] }, 0, 4),
	v("c", { verdict: "rejected", findings: [{ code: "CLAIMED_NOT_CHANGED", detail: "" }] }, 0, 5),
	v("d", { merge_status: "conflict", llm: llm("yes") }, 0, 12),
	v("e", { verdict: "rejected", llm: llm("no") }, 0, 9),
];

describe("summarize", () => {
	it("counts verdicts and merges for the demo", () => {
		const s = summarize(demo);
		expect(s.counts).toEqual({ agents: 5, verified: 2, rejected: 3, needs_review: 0, merged: 1, merge_rejected: 1, waiting: 0 });
	});

	it("counts each rejection reason, including LLM no and merge conflicts", () => {
		expect(summarize(demo).reasons).toEqual({ CLAIMED_NOT_CHANGED: 1, LLM_NO: 1, MERGE_CONFLICT: 1, PROTECTED_PATH: 1, UNCLAIMED_CHANGE: 1 });
	});

	it("takes the median of push-to-verdict seconds", () => {
		// 8, 4, 5, 12, 9 -> sorted 4 5 8 9 12 -> 8
		expect(summarize(demo).medianPushToVerdictMs).toBe(8000);
	});

	it("averages the two middle values for an even count", () => {
		expect(summarize([v("a", {}, 0, 4), v("b", {}, 0, 6)]).medianPushToVerdictMs).toBe(5000);
	});

	it("skips verdicts without a push time and reports null when none have one", () => {
		expect(summarize([v("a", { pushed_at: null })]).medianPushToVerdictMs).toBeNull();
		expect(summarize([v("a", { pushed_at: null }), v("b", {}, 0, 3)]).medianPushToVerdictMs).toBe(3000);
	});

	it("uses only each agent's latest verdict", () => {
		const s = summarize([v("a", { verdict: "rejected", findings: [{ code: "CLAIMED_NOT_CHANGED", detail: "" }] }), v("a", { merge_status: "merged" })]);
		expect(s.counts.rejected).toBe(0);
		expect(s.counts.merged).toBe(1);
		expect(s.reasons).toEqual({});
	});

	it("counts needs_review, merge errors, and agents still waiting", () => {
		const s = summarize([v("a", { verdict: "needs_review", llm: llm("unclear") }), v("b", { merge_status: "error" })], ["a", "b", "c"]);
		expect(s.counts).toMatchObject({ agents: 3, needs_review: 1, verified: 1, waiting: 1 });
		expect(s.reasons).toEqual({ LLM_UNCLEAR: 1, MERGE_ERROR: 1 });
	});

	it("returns zeros for no verdicts", () => {
		expect(summarize([])).toEqual({
			counts: { agents: 0, verified: 0, rejected: 0, needs_review: 0, merged: 0, merge_rejected: 0, waiting: 0 },
			reasons: {},
			medianPushToVerdictMs: null,
		});
	});
});
