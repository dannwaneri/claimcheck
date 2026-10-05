import { describe, expect, it } from "vitest";
import { findConflicts, findOwnMerge, isTransientGitError, mergeMessage } from "../src/merge";
import type { FileChange } from "../src/verify/types";

const ch = (path: string): FileChange => ({ path, status: "modified", oldHash: "o", newHash: "n", additions: 1, deletions: 0 });

describe("findOwnMerge (repeat-safe merges)", () => {
	const v = { agent_id: "h04", task_id: "tmuv5sy72", commit: "5846922f94dd1234567890abcdef1234567890ab", summary: "Add double04()." };

	it("builds the merge message with agent, task, and commit", () => {
		expect(mergeMessage(v)).toBe("Merge h04 (tmuv5sy72) at 5846922f94dd: Add double04().");
	});

	it("finds an earlier merge of the same verdict in canon history (seen in full-run series 3, run 5)", () => {
		const log = [
			{ hash: "aaa", message: "Merge h05 (tmuv5sy72) at 1111111111aa: Add double05.\n" },
			{ hash: "0d9a362", message: "Merge h04 (tmuv5sy72) at 5846922f94dd: Add double04().\n" },
			{ hash: "3ee0463", message: "Merge c1 (tmuv5sy72) at 18deaa871fcb: Add half13().\n" },
		];
		expect(findOwnMerge(log, v)).toBe("0d9a362");
	});

	it("does not match another agent, another task, or another commit of the same agent", () => {
		const log = [
			{ hash: "a", message: "Merge h40 (tmuv5sy72) at 5846922f94dd: x" },
			{ hash: "b", message: "Merge h04 (tother) at 5846922f94dd: x" },
			{ hash: "c", message: "Merge h04 (tmuv5sy72) at 999999999999: x" },
		];
		expect(findOwnMerge(log, v)).toBeNull();
	});

	it("returns null for an empty history", () => {
		expect(findOwnMerge([], v)).toBeNull();
	});
});

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
