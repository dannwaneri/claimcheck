import { describe, expect, it } from "vitest";
import { parseClaim } from "../src/claim";

const expected = { task_id: "t1", agent_id: "agent-a" };

const valid = {
	task_id: "t1",
	agent_id: "agent-a",
	summary: "Add a sub() helper to math.js.",
	scope: { paths: ["src/math.js"] },
	changes: [{ path: "src/math.js", description: "Add sub(a, b) that returns a - b." }],
};

const parse = (obj: unknown) => parseClaim(JSON.stringify(obj), expected);

function invalid(obj: unknown) {
	const r = parse(obj);
	if (r.ok) throw new Error("expected invalid claim");
	expect(r.findings.every((f) => f.code === "CLAIM_INVALID")).toBe(true);
	return r.findings.map((f) => f.detail).join(" | ");
}

describe("parseClaim", () => {
	it("accepts a valid claim", () => {
		const r = parse(valid);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.claim).toEqual(valid);
	});

	it("rejects a missing claim file", () => {
		const r = parseClaim(null, expected);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.findings[0]).toMatchObject({ code: "CLAIM_INVALID", path: ".claim/claim.json" });
		if (!r.ok) expect(r.findings[0].detail).toMatch(/missing/i);
	});

	it("rejects text that is not JSON", () => {
		const r = parseClaim("{ not json", expected);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.findings[0].detail).toMatch(/json/i);
	});

	it("rejects a JSON value that is not an object", () => {
		expect(invalid([1, 2])).toMatch(/object/i);
	});

	it.each(["task_id", "agent_id", "summary", "scope", "changes"])("rejects a claim without %s", (field) => {
		const obj: Record<string, unknown> = { ...valid };
		delete obj[field];
		expect(invalid(obj)).toContain(field);
	});

	it("rejects an empty summary", () => {
		expect(invalid({ ...valid, summary: "  " })).toContain("summary");
	});

	it("rejects a summary over 200 chars", () => {
		expect(invalid({ ...valid, summary: "x".repeat(201) })).toContain("summary");
	});

	it("rejects an empty scope.paths", () => {
		expect(invalid({ ...valid, scope: { paths: [] } })).toContain("scope.paths");
	});

	it("rejects an empty changes list", () => {
		expect(invalid({ ...valid, changes: [] })).toContain("changes");
	});

	it("rejects a change without a description", () => {
		expect(invalid({ ...valid, changes: [{ path: "src/math.js", description: "" }] })).toContain("description");
	});

	it("rejects a change whose path is not in scope.paths", () => {
		const d = invalid({ ...valid, changes: [...valid.changes, { path: "src/other.js", description: "x" }] });
		expect(d).toContain("src/other.js");
	});

	it.each(["/src/math.js", "./src/math.js", "src/../secret.js", "src/*.js", ""])("rejects the path %j", (p) => {
		expect(invalid({ ...valid, scope: { paths: [p] }, changes: [{ path: p, description: "x" }] })).toMatch(/path/i);
	});

	it("rejects a claim for another task", () => {
		expect(invalid({ ...valid, task_id: "t2" })).toContain("task_id");
	});

	it("rejects a claim from another agent (agent pushed to the wrong fork)", () => {
		expect(invalid({ ...valid, agent_id: "agent-b" })).toContain("agent_id");
	});

	it("reports all schema errors at once", () => {
		const r = parse({ ...valid, summary: "", task_id: "t2" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.findings.length).toBeGreaterThanOrEqual(2);
	});
});
