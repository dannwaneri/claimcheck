import { describe, expect, it } from "vitest";
import { checkDeterministic, matchesGlob } from "../src/verify/deterministic";
import { DEFAULT_POLICY, type FileChange, type Policy } from "../src/verify/types";
import type { Claim } from "../src/claim";

function claim(paths: string[]): Claim {
	return {
		task_id: "t1",
		agent_id: "agent-a",
		summary: "Test change.",
		scope: { paths },
		changes: paths.map((path) => ({ path, description: `change ${path}` })),
	};
}

function change(path: string, additions = 1, deletions = 0, status: FileChange["status"] = "modified"): FileChange {
	return { path, status, oldHash: status === "added" ? null : "old", newHash: status === "deleted" ? null : "new", additions, deletions };
}

const codes = (findings: { code: string }[]) => findings.map((f) => f.code).sort();

describe("checkDeterministic", () => {
	it("returns no findings when the diff matches the claim exactly", () => {
		expect(checkDeterministic(claim(["src/math.js"]), [change("src/math.js")], DEFAULT_POLICY)).toEqual([]);
	});

	describe("UNCLAIMED_CHANGE", () => {
		it("flags a changed file that is not in scope.paths", () => {
			const f = checkDeterministic(claim(["src/math.js"]), [change("src/math.js"), change("src/strings.js")], DEFAULT_POLICY);
			expect(f).toEqual([expect.objectContaining({ code: "UNCLAIMED_CHANGE", path: "src/strings.js" })]);
		});

		it("flags an added file that is not claimed", () => {
			const f = checkDeterministic(claim(["src/math.js"]), [change("src/math.js"), change("src/new.js", 3, 0, "added")], DEFAULT_POLICY);
			expect(f).toEqual([expect.objectContaining({ code: "UNCLAIMED_CHANGE", path: "src/new.js" })]);
		});

		it("flags a deleted file that is not claimed", () => {
			const f = checkDeterministic(claim(["src/math.js"]), [change("src/math.js"), change("README.md", 0, 1, "deleted")], DEFAULT_POLICY);
			expect(f).toEqual([expect.objectContaining({ code: "UNCLAIMED_CHANGE", path: "README.md" })]);
		});

		it("ignores changes under .claim/", () => {
			const f = checkDeterministic(claim(["src/math.js"]), [change("src/math.js"), change(".claim/claim.json", 10, 0, "added")], DEFAULT_POLICY);
			expect(f).toEqual([]);
		});
	});

	describe("CLAIMED_NOT_CHANGED", () => {
		it("flags a claimed file that did not change", () => {
			const f = checkDeterministic(claim(["src/strings.js"]), [], DEFAULT_POLICY);
			expect(f).toEqual([expect.objectContaining({ code: "CLAIMED_NOT_CHANGED", path: "src/strings.js" })]);
		});

		it("flags only the missing one when some claimed files changed", () => {
			const f = checkDeterministic(claim(["src/math.js", "src/strings.js"]), [change("src/math.js")], DEFAULT_POLICY);
			expect(f).toEqual([expect.objectContaining({ code: "CLAIMED_NOT_CHANGED", path: "src/strings.js" })]);
		});

		it("counts a claimed delete as a change", () => {
			const f = checkDeterministic(claim(["src/old.js"]), [change("src/old.js", 0, 5, "deleted")], DEFAULT_POLICY);
			expect(f).toEqual([]);
		});

		it("does not count a change to .claim/ as a change to a claimed path", () => {
			const f = checkDeterministic(claim(["src/strings.js"]), [change(".claim/claim.json", 5, 0, "added")], DEFAULT_POLICY);
			expect(codes(f)).toEqual(["CLAIMED_NOT_CHANGED"]);
		});
	});

	describe("PROTECTED_PATH", () => {
		it("flags a change under src/auth/ even when the file is claimed", () => {
			const f = checkDeterministic(claim(["src/auth/session.js"]), [change("src/auth/session.js")], DEFAULT_POLICY);
			expect(f).toEqual([expect.objectContaining({ code: "PROTECTED_PATH", path: "src/auth/session.js" })]);
		});

		it("flags a nested protected file", () => {
			const f = checkDeterministic(claim(["src/auth/oauth/google.js"]), [change("src/auth/oauth/google.js")], DEFAULT_POLICY);
			expect(codes(f)).toEqual(["PROTECTED_PATH"]);
		});

		it("does not flag a path that only starts with the same letters", () => {
			const f = checkDeterministic(claim(["src/authz.js"]), [change("src/authz.js")], DEFAULT_POLICY);
			expect(f).toEqual([]);
		});

		it("flags an unclaimed protected change with both codes (Agent B case)", () => {
			const f = checkDeterministic(claim(["src/strings.js"]), [change("src/strings.js"), change("src/auth/session.js")], DEFAULT_POLICY);
			expect(codes(f)).toEqual(["PROTECTED_PATH", "UNCLAIMED_CHANGE"]);
			expect(f.every((x) => x.path === "src/auth/session.js")).toBe(true);
		});

		it("uses the protected list from the policy", () => {
			const policy: Policy = { ...DEFAULT_POLICY, protectedPaths: ["config/*.json"] };
			expect(codes(checkDeterministic(claim(["config/prod.json"]), [change("config/prod.json")], policy))).toEqual(["PROTECTED_PATH"]);
			expect(checkDeterministic(claim(["src/auth/x.js"]), [change("src/auth/x.js")], policy)).toEqual([]);
		});
	});

	describe("DIFF_TOO_LARGE", () => {
		const policy: Policy = { ...DEFAULT_POLICY, maxLines: 10, maxFiles: 2 };

		it("passes at exactly the line limit", () => {
			expect(checkDeterministic(claim(["a.js"]), [change("a.js", 6, 4)], policy)).toEqual([]);
		});

		it("flags one line over the limit (additions + deletions)", () => {
			const f = checkDeterministic(claim(["a.js"]), [change("a.js", 6, 5)], policy);
			expect(f).toEqual([expect.objectContaining({ code: "DIFF_TOO_LARGE" })]);
			expect(f[0].detail).toContain("11");
		});

		it("sums lines across files", () => {
			const f = checkDeterministic(claim(["a.js", "b.js"]), [change("a.js", 6), change("b.js", 5)], policy);
			expect(codes(f)).toEqual(["DIFF_TOO_LARGE"]);
		});

		it("flags too many changed files", () => {
			const f = checkDeterministic(claim(["a.js", "b.js", "c.js"]), [change("a.js"), change("b.js"), change("c.js")], policy);
			expect(codes(f)).toEqual(["DIFF_TOO_LARGE"]);
			expect(f[0].detail).toContain("3 files");
		});

		it("does not count .claim/ toward the limits", () => {
			const f = checkDeterministic(claim(["a.js", "b.js"]), [change("a.js", 5), change("b.js", 5), change(".claim/claim.json", 50, 0, "added")], policy);
			expect(f).toEqual([]);
		});
	});

	it("reports every problem at once, not just the first", () => {
		const policy: Policy = { ...DEFAULT_POLICY, maxLines: 5 };
		const f = checkDeterministic(claim(["src/strings.js", "src/math.js"]), [change("src/strings.js", 3), change("src/auth/session.js", 3)], policy);
		expect(codes(f)).toEqual(["CLAIMED_NOT_CHANGED", "DIFF_TOO_LARGE", "PROTECTED_PATH", "UNCLAIMED_CHANGE"]);
	});
});

describe("matchesGlob", () => {
	it.each([
		["src/auth/session.js", "src/auth/**", true],
		["src/auth/a/b/c.js", "src/auth/**", true],
		["src/auth", "src/auth/**", false],
		["src/authz.js", "src/auth/**", false],
		["config/prod.json", "config/*.json", true],
		["config/env/prod.json", "config/*.json", false],
		["README.md", "README.md", true],
		["docs/README.md", "README.md", false],
		["a.b.js", "a.b.js", true],
		["axb.js", "a.b.js", false],
	])("%s vs %s -> %s", (path, glob, expected) => {
		expect(matchesGlob(path, glob)).toBe(expected);
	});
});
