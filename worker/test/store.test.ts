/// <reference types="node" />
// Runs the real Store SQL on SQLite (node:sqlite), the same engine Durable Objects use.
import { sqlite } from "./helpers/sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Store, verdictKey, type VerdictInput } from "../src/store";
import { DEFAULT_POLICY, type FileChange } from "../src/verify/types";

const change = (path: string, newHash: string): FileChange => ({ path, status: "modified", oldHash: "base", newHash, additions: 1, deletions: 0 });

const verdict = (over: Partial<VerdictInput> = {}): VerdictInput => ({
	task_id: "t1",
	agent_id: "a",
	fork: "t1-a",
	commit: "c1",
	summary: "s",
	verdict: "verified",
	findings: [],
	llm: [],
	changes: [change("src/math.js", "blob-c1")],
	...over,
});

let store: Store;
beforeEach(() => {
	store = new Store(sqlite());
	store.createTask({
		id: "t1",
		base: "base-sha",
		policy: DEFAULT_POLICY,
		agents: [
			{ agent_id: "a", fork: "t1-a", remote: "r" },
			{ agent_id: "d", fork: "t1-d", remote: "r" },
		],
	});
});

describe("Q1: verdicts are bound to one commit", () => {
	it("stores the commit SHA with the verdict", () => {
		store.recordVerdict(verdict());
		expect(store.snapshot().verdicts[0]).toMatchObject({ id: "t1-a@c1", commit: "c1", verdict: "verified" });
	});

	it("queues the exact blobs judged for that commit, even after a later push", () => {
		store.recordVerdict(verdict({ commit: "c1", changes: [change("src/math.js", "blob-c1")] }));
		store.recordVerdict(verdict({ commit: "c2", verdict: "rejected", changes: [change("src/math.js", "blob-c2")] }));
		const next = store.nextQueued()!;
		expect(next.commit).toBe("c1");
		expect(next.changes[0].newHash).toBe("blob-c1");
	});

	it("gives a later push its own verdict row and its own queue entry", () => {
		store.recordVerdict(verdict({ commit: "c1" }));
		store.recordVerdict(verdict({ commit: "c2", changes: [change("src/math.js", "blob-c2")] }));
		expect(store.snapshot().verdicts.map((v) => v.id)).toEqual(["t1-a@c1", "t1-a@c2"]);
		const first = store.nextQueued()!;
		store.setMergeResult(first.id, "merged", null, "m1");
		expect(store.nextQueued()!.commit).toBe("c2"); // merge queue will then see canon changed src/math.js -> conflict
	});
});

describe("Q2: policy comes from the task, not the fork", () => {
	it("returns the policy written at task creation", () => {
		expect(store.lookupFork("t1-a")!.policy).toEqual(DEFAULT_POLICY);
	});

	it("does not know forks outside a task", () => {
		expect(store.lookupFork("canon")).toBeNull();
		expect(store.lookupFork("someone-else")).toBeNull();
	});
});

describe("Q3: idempotency key is repo + SHA", () => {
	it("builds the key from fork and commit", () => {
		expect(verdictKey("t1-a", "abc")).toBe("t1-a@abc");
	});

	it("stores one verdict and one queue entry when the same push is recorded twice", () => {
		expect(store.recordVerdict(verdict())).toBe(true);
		expect(store.recordVerdict(verdict())).toBe(false);
		expect(store.snapshot().verdicts).toHaveLength(1);
		const first = store.nextQueued()!;
		store.setMergeResult(first.id, "merged", null, "m1");
		expect(store.nextQueued()).toBeNull();
	});

	it("keeps the first verdict if a duplicate run reaches a different answer", () => {
		store.recordVerdict(verdict({ verdict: "verified" }));
		store.recordVerdict(verdict({ verdict: "needs_review" }));
		expect(store.snapshot().verdicts[0].verdict).toBe("verified");
	});

	it("reports an existing verdict so the Workflow can skip early", () => {
		expect(store.hasVerdict("t1-a", "c1")).toBe(false);
		store.recordVerdict(verdict());
		expect(store.hasVerdict("t1-a", "c1")).toBe(true);
		expect(store.hasVerdict("t1-a", "c2")).toBe(false);
	});
});

describe("Q4: only verified verdicts enter the merge queue", () => {
	it.each(["needs_review", "rejected"] as const)("does not queue a %s verdict", (v) => {
		expect(store.recordVerdict(verdict({ verdict: v }))).toBe(false);
		expect(store.nextQueued()).toBeNull();
		expect(store.snapshot().verdicts[0].merge_status).toBeNull();
	});
});

describe("merge queue order and reset", () => {
	it("drains in arrival order", () => {
		store.recordVerdict(verdict({ fork: "t1-d", agent_id: "d", commit: "d1" }));
		store.recordVerdict(verdict({ fork: "t1-a", agent_id: "a", commit: "a1" }));
		expect(store.nextQueued()!.fork).toBe("t1-d");
	});

	it("reset clears tasks, agents, and verdicts", () => {
		store.recordVerdict(verdict());
		store.reset();
		expect(store.snapshot()).toEqual({ tasks: [], agents: [], verdicts: [] });
		expect(store.lookupFork("t1-a")).toBeNull();
	});
});
