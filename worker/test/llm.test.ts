import { describe, expect, it } from "vitest";
import { decide, parseJudgement, type Judgement } from "../src/verify/llm";

const diff = [
	"--- a/src/strings.js",
	"+++ b/src/strings.js",
	"@@ -1,3 +1,3 @@",
	" export function slugify(s) {",
	"-  return s.trim().toLowerCase().replace(/\\s+/g, '-');",
	"+  return s.trim().replace(/\\s+/g, '-');",
	" }",
].join("\n");

describe("parseJudgement", () => {
	it("reads a plain JSON answer", () => {
		const r = parseJudgement('{"matches":"yes","evidence":"+  return s.trim()","reason":"ok"}');
		expect(r).toEqual({ ok: true, value: { matches: "yes", evidence: "+  return s.trim()", reason: "ok" } });
	});

	it("strips a <think> block before the JSON", () => {
		const r = parseJudgement('<think>let me look {not json}</think>\n{"matches":"no","evidence":"x","reason":"r"}');
		expect(r.ok && r.value.matches).toBe("no");
	});

	it("reads JSON inside a ```json fence", () => {
		const r = parseJudgement('Here:\n```json\n{"matches":"unclear","evidence":"","reason":"r"}\n```');
		expect(r.ok && r.value.matches).toBe("unclear");
	});

	it("accepts an already-parsed object (Workers AI JSON mode)", () => {
		const r = parseJudgement({ matches: "yes", evidence: "e", reason: "r" });
		expect(r.ok).toBe(true);
	});

	it("normalizes case and spaces in matches", () => {
		const r = parseJudgement('{"matches":" YES ","evidence":"e","reason":"r"}');
		expect(r.ok && r.value.matches).toBe("yes");
	});

	it.each([
		["no JSON at all", "I think it matches."],
		["broken JSON", '{"matches":"yes",'],
		["bad matches value", '{"matches":"maybe","evidence":"e","reason":"r"}'],
		["missing evidence", '{"matches":"yes","reason":"r"}'],
		["empty", ""],
	])("fails on %s", (_name, raw) => {
		expect(parseJudgement(raw).ok).toBe(false);
	});
});

describe("decide", () => {
	const j = (path: string, matches: Judgement["matches"], evidence = "", error?: string): Judgement => ({
		path,
		description: "d",
		matches,
		evidence,
		reason: "r",
		...(error ? { error } : {}),
	});

	it("verifies when every change matches", () => {
		expect(decide([j("a.js", "yes"), j("b.js", "yes")], { "a.js": diff, "b.js": diff })).toBe("verified");
	});

	it("rejects when a change does not match and the evidence is in the diff (Agent E case)", () => {
		const items = [j("src/strings.js", "no", "+  return s.trim().replace(/\\s+/g, '-');")];
		expect(decide(items, { "src/strings.js": diff })).toBe("rejected");
	});

	it("matches evidence that ignores the +/- prefix and outer spaces", () => {
		const items = [j("src/strings.js", "no", "return s.trim().replace(/\\s+/g, '-');")];
		expect(decide(items, { "src/strings.js": diff })).toBe("rejected");
	});

	it("matches evidence that quotes a removed line with the - prefix and different spacing", () => {
		const items = [j("src/strings.js", "no", "- return s.trim().toLowerCase().replace(/\\s+/g, '-');")];
		expect(decide(items, { "src/strings.js": diff })).toBe("rejected");
	});

	it("does not verify a 'yes' that carries an error", () => {
		expect(decide([j("a.js", "yes", "", "partial output")], { "a.js": diff })).toBe("needs_review");
	});

	it("sends to review when a 'no' quotes evidence that is not in the diff", () => {
		const items = [j("src/strings.js", "no", "deleteEverything()")];
		expect(decide(items, { "src/strings.js": diff })).toBe("needs_review");
	});

	it("sends to review when a 'no' has empty evidence", () => {
		expect(decide([j("src/strings.js", "no", "  ")], { "src/strings.js": diff })).toBe("needs_review");
	});

	it("sends to review on any unclear answer", () => {
		expect(decide([j("a.js", "yes"), j("b.js", "unclear")], { "a.js": diff, "b.js": diff })).toBe("needs_review");
	});

	it("sends to review when the model call failed", () => {
		expect(decide([j("a.js", "unclear", "", "bad JSON twice")], { "a.js": diff })).toBe("needs_review");
	});

	it("rejects over review when one change is a proven 'no' and another is unclear", () => {
		const items = [j("src/strings.js", "no", "return s.trim().replace(/\\s+/g, '-');"), j("b.js", "unclear")];
		expect(decide(items, { "src/strings.js": diff, "b.js": diff })).toBe("rejected");
	});

	it("sends to review when there are no judgements", () => {
		expect(decide([], {})).toBe("needs_review");
	});
});
