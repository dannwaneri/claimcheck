// No GET route may expose a token, a tokenized remote URL, or the shared secret.
// The write route (POST /tasks) returns tokens on purpose; this test proves they are not stored or echoed later.
// ARTIFACTS here is a test-only stand-in that hands out recognizable tokens. RepoDO is the real Store on SQLite.
import { describe, expect, it } from "vitest";
import { handle } from "../src/router";
import { Store } from "../src/store";
import type { Env } from "../src/env";
import { sqlite } from "./helpers/sqlite";

const SECRET = "shared-secret-value-123";
// Real tokens seen: art_v1_<hex>?expires=... and (since 2026-10-05) art_v2_x_<hex>?expires=...
const tok = (name: string) => `art_v2_x_${name.padEnd(40, "0")}?expires=1999999999`;
const remote = (name: string) => `https://acct.artifacts.cloudflare.net/git/claimcheck/${name}.git`;

function makeEnv() {
	const store = new Store(sqlite());
	const repoHandle = (name: string) => ({
		[Symbol.dispose]() {},
		async info() { return { name, remote: remote(name) }; },
		async createToken() { return { plaintext: tok(`canon-${Date.now()}`), expiresAt: "" }; },
		async log() { return [{ hash: "b".repeat(40) }]; },
		async fork(fork: string) { return { name: fork, remote: remote(fork), token: tok(fork), defaultBranch: "main", id: fork }; },
	});
	const env = {
		ARTIFACTS: { get: async (name: string) => repoHandle(name) },
		REPO_DO: { idFromName: (n: string) => n, get: () => store },
		CANON_REPO: "canon",
		LLM_MODEL: "@cf/qwen/qwen3.8-27b",
		CLAIMCHECK_SECRET: SECRET,
	} as unknown as Env;
	return { env, store };
}

const req = (method: string, path: string, body?: unknown) =>
	new Request(`https://x${path}`, {
		method,
		headers: { "x-claimcheck-secret": SECRET, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

function assertNoSecrets(text: string, tokens: string[]) {
	expect(text).not.toMatch(/art_v\d+_/);
	expect(text).not.toContain(SECRET);
	for (const t of tokens) expect(text).not.toContain(t.split("?")[0]);
	expect(text).not.toMatch(/https:\/\/[^\/\s"]*:[^@\s"]*@/); // user:password@host
}

describe("GET routes do not leak secrets", () => {
	it("GET /, GET /api/state, and unknown GET routes contain no token, tokenized URL, or secret", async () => {
		const { env, store } = makeEnv();
		const created = await handle(req("POST", "/tasks", { agents: ["a", "b", "c", "d", "e"] }), env);
		expect(created.status).toBe(201);
		const tokens: string[] = (await created.json<any>()).agents.map((a: any) => a.token);
		expect(tokens).toHaveLength(5);
		expect(tokens[0]).toMatch(/^art_v\d+_/); // the write route does return tokens; that is its job

		// A verdict and a merge error, so every dashboard section renders.
		store.recordVerdict({
			task_id: store.snapshot().tasks[0].id, agent_id: "a", fork: store.snapshot().agents[0].fork, commit: "c".repeat(40),
			summary: "Add sub()", verdict: "verified", findings: [], changes: [],
			llm: [{ path: "src/math.js", description: "d", matches: "yes", evidence: "export function sub(a, b) {", reason: "ok" }],
		});
		const q = store.nextQueued()!;
		store.setMergeResult(q.id, "error", "push to canon failed: 403", null);

		for (const path of ["/", "/api/state", "/nope"]) {
			const res = await handle(req("GET", path), env);
			const text = await res.text();
			expect(text.length).toBeGreaterThan(10);
			assertNoSecrets(text, tokens);
		}
	});

	it("stores no token in the database rows behind GET /api/state", async () => {
		const { env, store } = makeEnv();
		const created = await handle(req("POST", "/tasks", { agents: ["a"] }), env);
		const tokens: string[] = (await created.json<any>()).agents.map((a: any) => a.token);
		assertNoSecrets(JSON.stringify(store.snapshot()), tokens);
	});
});
