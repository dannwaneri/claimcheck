// Reads GET /api/state JSON on stdin and answers questions for demo/run.
//   node state.mjs outcome <task> <agent>   -> prints one outcome word
//   node state.mjs settled <task> <n>       -> exit 0 when n agents have a final outcome
//   node state.mjs missing <task>           -> lists agents without a final outcome
//   node state.mjs report <task>            -> prints the result table; exit 1 if it differs from the plan
const [cmd, task, arg] = process.argv.slice(2);
const input = await new Promise((resolve) => {
	let s = "";
	process.stdin.on("data", (d) => (s += d)).on("end", () => resolve(s));
});
const state = JSON.parse(input);

const PLAN = {
	a: { outcome: "merged", codes: [] },
	b: { outcome: "rejected", codes: ["PROTECTED_PATH", "UNCLAIMED_CHANGE"] },
	c: { outcome: "rejected", codes: ["CLAIMED_NOT_CHANGED"] },
	d: { outcome: "conflict", codes: ["MERGE_CONFLICT"] },
	e: { outcome: "rejected", codes: ["LLM_NO"] },
};

function latest(agent) {
	const vs = state.verdicts.filter((v) => v.task_id === task && v.agent_id === agent);
	return vs[vs.length - 1];
}

// waiting | queued | merged | conflict | error | rejected | needs_review
function outcome(agent) {
	const v = latest(agent);
	if (!v) return "waiting";
	if (v.verdict !== "verified") return v.verdict;
	return v.merge_status ?? "queued";
}

function codes(agent) {
	const v = latest(agent);
	if (!v) return [];
	const c = v.findings.map((f) => f.code);
	if (v.llm.some((j) => j.matches === "no")) c.push("LLM_NO");
	if (v.merge_status === "conflict") c.push("MERGE_CONFLICT");
	return [...new Set(c)].sort();
}

const FINAL = new Set(["merged", "conflict", "error", "rejected", "needs_review"]);

if (cmd === "outcome") {
	console.log(outcome(arg));
} else if (cmd === "settled") {
	const agents = state.agents.filter((a) => a.task_id === task).map((a) => a.agent_id);
	process.exit(agents.length >= Number(arg) && agents.every((a) => FINAL.has(outcome(a))) ? 0 : 1);
} else if (cmd === "detail") {
	// One agent's verdict and evidence, for the real-agent scene.
	const v = latest(arg);
	if (!v) {
		console.log("no verdict");
	} else {
		console.log(`verdict: ${outcome(arg)}${codes(arg).length ? " (" + codes(arg).join(", ") + ")" : ""}`);
		for (const f of v.findings) console.log(`  ${f.code}: ${f.detail}`);
		for (const j of v.llm) console.log(`  LLM ${j.matches} on ${j.path}: ${j.reason || j.error}${j.evidence ? `\n    evidence: ${j.evidence}` : ""}`);
		if (v.merge_detail) console.log(`  merge: ${v.merge_detail}`);
	}
} else if (cmd === "missing") {
	const agents = state.agents.filter((a) => a.task_id === task).map((a) => a.agent_id);
	console.log(agents.filter((a) => !FINAL.has(outcome(a))).map((a) => `${a} (${outcome(a)})`).join(", ") || "none");
} else if (cmd === "report") {
	let ok = true;
	console.log("agent  expected                                   actual");
	for (const [agent, plan] of Object.entries(PLAN)) {
		const got = { outcome: outcome(agent), codes: codes(agent) };
		const match = got.outcome === plan.outcome && JSON.stringify(got.codes) === JSON.stringify(plan.codes);
		ok &&= match;
		const fmt = (x) => `${x.outcome}${x.codes.length ? " " + x.codes.join("+") : ""}`;
		console.log(`${agent.padEnd(6)} ${fmt(plan).padEnd(42)} ${fmt(got)} ${match ? "OK" : "MISMATCH"}`);
	}
	console.log(ok ? "PLAN OK" : "PLAN MISMATCH");
	process.exit(ok ? 0 : 1);
} else {
	console.error("unknown command");
	process.exit(2);
}
