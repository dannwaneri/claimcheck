import { describe, expect, it } from "vitest";
import { findConflicts } from "../src/merge";
import type { FileChange } from "../src/verify/types";

const ch = (path: string): FileChange => ({ path, status: "modified", oldHash: "o", newHash: "n", additions: 1, deletions: 0 });

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
		expect(findConflicts([ch("b.js"), ch("a.js"), ch("c.js")], [ch("c.js"), ch("a.js")])).toEqual(["a.js", "c.js"]);
	});

	it("ignores .claim/ (every agent writes it)", () => {
		expect(findConflicts([ch(".claim/claim.json"), ch("x.js")], [ch(".claim/claim.json")])).toEqual([]);
	});
});
