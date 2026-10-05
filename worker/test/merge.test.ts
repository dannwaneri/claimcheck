import { describe, expect, it } from "vitest";
import { findConflicts, isTransientGitError } from "../src/merge";
import type { FileChange } from "../src/verify/types";

const ch = (path: string): FileChange => ({ path, status: "modified", oldHash: "o", newHash: "n", additions: 1, deletions: 0 });

describe("isTransientGitError", () => {
	it.each([
		["HTTP Error: 503 Service Unavailable", true], // seen in a real merge, full-run series 3
		["HTTP Error: 502 Bad Gateway", true],
		["HTTP Error: 504 Gateway Timeout", true],
		["remote: artifacts_git_receive_pack_service_unavailable", true],
		["HTTP Error: 401 Unauthorized", false],
		["HTTP Error: 404 Not Found", false],
		["canon moved during merge: expected a, found b", false],
		["push to canon failed: {}", false],
	])("%s -> %s", (message, expected) => {
		expect(isTransientGitError(new Error(message))).toBe(expected);
	});
});

describe("findConflicts", () => {
	it("returns nothing when canon did not change since the base", () => {
		expect(findConflicts([ch("src/math.js")], [])).toEqual([]);
	});

	it("returns nothing when canon changed other files", () => {
		expect(findConflicts([ch("src/math.js")], [ch("src/strings.js")])).toEqual([]);
	});

	it("returns the shared path when both changed the same file (Agent D case)", () => {
		expect(findConflicts([ch("src/math.js")], [ch("src/math.js"), ch("README.md")])).toEqual(["src/math.js"]);
	});

	it("returns every shared path, sorted", () => {
		expect(findConflicts([ch("c.js"), ch("b.js"), ch("a.js")], [ch("a.js"), ch("c.js")])).toEqual(["a.js", "c.js"]);
	});

	it("ignores .claim/ (every agent writes it)", () => {
		expect(findConflicts([ch(".claim/claim.json"), ch("x.js")], [ch(".claim/claim.json")])).toEqual([]);
	});
});
