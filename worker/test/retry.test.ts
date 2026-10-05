import { describe, expect, it } from "vitest";
import { forkWithRetry, withRetry } from "../src/retry";

const err = (code: string) => Object.assign(new Error(code), { code });
const noSleep = async () => {};

describe("withRetry", () => {
	it("returns at once when the first try works", async () => {
		let calls = 0;
		expect(await withRetry(async () => ++calls, { tries: 3, delayMs: 1, retryOn: () => true, sleep: noSleep })).toBe(1);
		expect(calls).toBe(1);
	});

	it("tries again after a retryable error and returns the later result", async () => {
		let calls = 0;
		const r = await withRetry(
			async () => {
				if (++calls < 3) throw err("INTERNAL_ERROR");
				return "ok";
			},
			{ tries: 3, delayMs: 1, retryOn: () => true, sleep: noSleep },
		);
		expect([r, calls]).toEqual(["ok", 3]);
	});

	it("stops after the last try and throws the last error", async () => {
		let calls = 0;
		await expect(
			withRetry(async () => { calls++; throw err("INTERNAL_ERROR"); }, { tries: 3, delayMs: 1, retryOn: () => true, sleep: noSleep }),
		).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
		expect(calls).toBe(3);
	});

	it("does not retry an error that retryOn rejects", async () => {
		let calls = 0;
		await expect(
			withRetry(async () => { calls++; throw err("INVALID_REPO_NAME"); }, { tries: 3, delayMs: 1, retryOn: () => false, sleep: noSleep }),
		).rejects.toMatchObject({ code: "INVALID_REPO_NAME" });
		expect(calls).toBe(1);
	});

	it("waits longer before each new try", async () => {
		const waits: number[] = [];
		await withRetry(async () => { throw err("X"); }, { tries: 3, delayMs: 100, retryOn: () => true, sleep: async (ms) => { waits.push(ms); } }).catch(() => {});
		expect(waits).toEqual([100, 200]);
	});
});

describe("forkWithRetry", () => {
	// Test-only stand-ins for the canon handle and the binding.
	function fakes(failures: string[]) {
		const calls: string[] = [];
		const existing = new Set<string>();
		const canon = {
			async fork(name: string) {
				calls.push(name);
				const f = failures.shift();
				if (f === "INTERNAL_ERROR_BUT_CREATED") {
					existing.add(name);
					throw err("INTERNAL_ERROR");
				}
				if (f) throw err(f);
				if (existing.has(name)) throw err("ALREADY_EXISTS");
				existing.add(name);
				return { name, remote: `https://r/${name}.git`, token: `tok-${name}` };
			},
		};
		const artifacts = {
			async get(name: string) {
				if (!existing.has(name)) throw err("NOT_FOUND");
				return {
					[Symbol.dispose]() {},
					async info() { return { name, remote: `https://r/${name}.git` }; },
					async createToken() { return { plaintext: `tok2-${name}`, expiresAt: "" }; },
				};
			},
		};
		return { canon, artifacts, calls };
	}

	it("forks on the first try", async () => {
		const { canon, artifacts, calls } = fakes([]);
		expect(await forkWithRetry(artifacts as any, canon as any, "t1-a", "d", noSleep)).toEqual({ name: "t1-a", remote: "https://r/t1-a.git", token: "tok-t1-a" });
		expect(calls).toHaveLength(1);
	});

	it("retries INTERNAL_ERROR up to 3 tries (the measured failure)", async () => {
		const { canon, artifacts, calls } = fakes(["INTERNAL_ERROR", "INTERNAL_ERROR"]);
		expect((await forkWithRetry(artifacts as any, canon as any, "t1-a", "d", noSleep)).token).toBe("tok-t1-a");
		expect(calls).toHaveLength(3);
	});

	it("gives up after 3 failed tries", async () => {
		const { canon, artifacts, calls } = fakes(["INTERNAL_ERROR", "INTERNAL_ERROR", "INTERNAL_ERROR"]);
		await expect(forkWithRetry(artifacts as any, canon as any, "t1-a", "d", noSleep)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
		expect(calls).toHaveLength(3);
	});

	it("reuses a fork that a failed try created anyway", async () => {
		const { canon, artifacts } = fakes(["INTERNAL_ERROR_BUT_CREATED"]);
		expect(await forkWithRetry(artifacts as any, canon as any, "t1-a", "d", noSleep)).toEqual({ name: "t1-a", remote: "https://r/t1-a.git", token: "tok2-t1-a" });
	});

	it("does not retry a permanent error", async () => {
		const { canon, artifacts, calls } = fakes(["INVALID_REPO_NAME"]);
		await expect(forkWithRetry(artifacts as any, canon as any, "bad name", "d", noSleep)).rejects.toMatchObject({ code: "INVALID_REPO_NAME" });
		expect(calls).toHaveLength(1);
	});

	it("does not treat ALREADY_EXISTS on the first try as success", async () => {
		const { canon, artifacts } = fakes(["ALREADY_EXISTS"]);
		await expect(forkWithRetry(artifacts as any, canon as any, "t1-a", "d", noSleep)).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
	});
});
