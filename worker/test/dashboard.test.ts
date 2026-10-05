import { describe, expect, it } from "vitest";
import { renderDashboard } from "../src/dashboard";
import { DEFAULT_POLICY } from "../src/verify/types";
import type { VerdictRow } from "../src/store";

const row = (agent: string, over: Partial<VerdictRow>): VerdictRow => ({
	id: `t1-${agent}@c`, task_id: "t1", agent_id: agent, fork: `t1-${agent}`, commit: "c".repeat(40), summary: "s",
	verdict: "verified", findings: [], llm: [], merge_status: null, merge_detail: null, merged_commit: null,
	pushed_at: "2026-10-05T12:00:00.000Z", created_at: "2026-10-05T12:00:07.000Z", ...over,
});

const snapshot = {
	tasks: [{ id: "t1", base: "b".repeat(40), policy: DEFAULT_POLICY, created_at: "2026-10-05T11:59:00.000Z" }],
	agents: ["a", "b", "c"].map((a) => ({ fork: `t1-${a}`, task_id: "t1", agent_id: a, remote: "r" })),
	verdicts: [
		row("a", { merge_status: "merged", merged_commit: "m".repeat(40) }),
		row("b", { verdict: "rejected", findings: [{ code: "PROTECTED_PATH", path: "src/auth/x.js", detail: "d" }] }),
	],
};

describe("dashboard summary", () => {
	it("shows counts, reasons, and the median push-to-verdict time", () => {
		const html = renderDashboard(snapshot as any, "m");
		expect(html).toContain("<b>3</b> agents");
		expect(html).toContain("1 verified</span> (1 merged, 0 merge rejected)");
		expect(html).toContain("1 rejected");
		expect(html).toContain("0 needs review");
		expect(html).toContain("1 waiting");
		expect(html).toContain("<code>PROTECTED_PATH</code> 1");
		expect(html).toContain("median push → verdict <b>7.0 s</b>");
	});
});
