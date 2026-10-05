// POST /reset may delete only the agent forks claimcheck created (the forks in its own state).
// ARTIFACTS is a test-only stand-in with a mix of repos; RepoDO is the real Store on SQLite.
import { describe, expect, it } from "vitest";
import { handle } from "../src/router";
import { Store } from "../src/store";
import { DEFAULT_POLICY } from "../src/verify/types";
import type { Env } from "../src/env";
import { sqlite } from "./helpers/sqlite";

const SECRET = "s";

function makeEnv(repos: string[]) {
	const store = new Store(sqlite());
	const present = new Set(repos);
	const deleted: string[] = [];
	const stub = Object.assign(store, { async resetAll() { store.reset(); } });
	const env = {
		ARTIFACTS: {
			async list() { return { repos: [...present].map((name) => ({ name, status: "ready" })), cursor: null }; },
			async delete(name: string) { deleted.push(name); return present.delete(name); },
		},
		REPO_DO: { idFromName: (n: string) => n, get: () => stub },
		CANON_REPO: "canon",
		CLAIMCHECK_SECRET: SECRET,
	} as unknown as Env;
	return { env, store, deleted, present };
}

const reset = (env: Env) => handle(new Request("https://x/reset", { method: "POST", headers: { "x-claimcheck-secret": SECRET } }), env);

describe("POST /reset scope", () => {
	it("deletes only forks recorded in claimcheck's state", async () => {
		const { env, store, deleted, present } = makeEnv(["canon", "t1-a", "t1-b", "my-other-repo", "t9-x"]);
		store.createTask({
			id: "t1",
			base: "b",
			policy: DEFAULT_POLICY,
			agents: [
				{ agent_id: "a", fork: "t1-a", remote: "r" },
				{ agent_id: "b", fork: "t1-b", remote: "r" },
			],
		});
		const res = await reset(env);
		expect(res.status).toBe(200);
		expect(deleted.sort()).toEqual(["t1-a", "t1-b"]);
		expect([...present].sort()).toEqual(["canon", "my-other-repo", "t9-x"]);
		expect(store.snapshot().tasks).toEqual([]);
	});

	it("reports a recorded fork that is already gone as missing, not as an error", async () => {
		const { env, store } = makeEnv(["canon"]);
		store.createTask({ id: "t1", base: "b", policy: DEFAULT_POLICY, agents: [{ agent_id: "a", fork: "t1-a", remote: "r" }] });
		const body = await (await reset(env)).json<any>();
		expect(body).toEqual({ deleted: [], missing: ["t1-a"] });
	});

	it("never deletes canon, even if canon is somehow recorded as a fork", async () => {
		const { env, store, deleted } = makeEnv(["canon"]);
		store.createTask({ id: "t1", base: "b", policy: DEFAULT_POLICY, agents: [{ agent_id: "a", fork: "canon", remote: "r" }] });
		await reset(env);
		expect(deleted).toEqual([]);
	});
});
