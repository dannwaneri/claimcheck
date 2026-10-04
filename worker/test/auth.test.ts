// Write routes need the shared secret. These tests stop at the auth gate or at body
// validation, so they never reach Artifacts; the env is a stand-in for that reason only.
import { describe, expect, it } from "vitest";
import { handle } from "../src/router";
import type { Env } from "../src/env";

const env = (secret?: string) => ({ ARTIFACTS: {}, CANON_REPO: "canon", LLM_MODEL: "m", CLAIMCHECK_SECRET: secret }) as unknown as Env;
const post = (path: string, headers: Record<string, string> = {}, body = "") =>
	new Request(`https://x${path}`, { method: "POST", headers, body: body || undefined });

describe("shared secret on write routes", () => {
	it.each(["/tasks", "/canon", "/reset"])("POST %s without the header gets 401", async (path) => {
		const res = await handle(post(path), env("s3cret"));
		expect(res.status).toBe(401);
	});

	it("POST /tasks with a wrong secret gets 401", async () => {
		const res = await handle(post("/tasks", { "x-claimcheck-secret": "nope" }), env("s3cret"));
		expect(res.status).toBe(401);
	});

	it("POST /tasks with a secret of a different length gets 401", async () => {
		const res = await handle(post("/tasks", { "x-claimcheck-secret": "s3cret-and-more" }), env("s3cret"));
		expect(res.status).toBe(401);
	});

	it("POST /tasks with the right secret passes auth (then fails body validation)", async () => {
		const res = await handle(post("/tasks", { "x-claimcheck-secret": "s3cret", "content-type": "application/json" }, "{}"), env("s3cret"));
		expect(res.status).toBe(400);
	});

	it("fails closed with 500 when the Worker has no secret set", async () => {
		const res = await handle(post("/tasks", { "x-claimcheck-secret": "" }), env(undefined));
		expect(res.status).toBe(500);
		expect(await res.text()).toMatch(/CLAIMCHECK_SECRET/);
	});

	it("fails with a clear error when the Artifacts binding is missing", async () => {
		const noBinding = { CANON_REPO: "canon", CLAIMCHECK_SECRET: "s" } as unknown as Env;
		await expect(handle(post("/tasks"), noBinding)).rejects.toThrow(/ARTIFACTS binding is missing/);
	});
});
