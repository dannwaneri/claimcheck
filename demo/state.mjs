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
} else if (cmd === "scale-report") {
	// Plan for demo/scale: 12 honest, a conflict pair (c1, c2), and 8 misreporting agents.
	const SCALE = {
		...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`h${String(i + 1).padStart(2, "0")}`, { outcome: "merged", codes: [] }])),
		x1: { outcome: "rejected", codes: ["UNCLAIMED_CHANGE"] },
		x2: { outcome: "rejected", codes: ["UNCLAIMED_CHANGE"] },
		y1: { outcome: "rejected", codes: ["CLAIMED_NOT_CHANGED"] },
		y2: { outcome: "rejected", codes: ["CLAIMED_NOT_CHANGED"] },
		p1: { outcome: "rejected", codes: ["PROTECTED_PATH"] },
		p2: { outcome: "rejected", codes: ["PROTECTED_PATH", "UNCLAIMED_CHANGE"] },
		w1: { outcome: "rejected", codes: ["LLM_NO"] },
		w2: { outcome: "rejected", codes: ["LLM_NO"] },
	};
	const fmt = (x) => `${x.outcome}${x.codes.length ? " " + x.codes.join("+") : ""}`;
	let ok = true;
	const bad = [];
	for (const [agent, plan] of Object.entries(SCALE)) {
		const got = { outcome: outcome(agent), codes: codes(agent) };
		if (got.outcome !== plan.outcome || JSON.stringify(got.codes) !== JSON.stringify(plan.codes)) {
			ok = false;
			bad.push(`${agent}: expected ${fmt(plan)}, got ${fmt(got)}`);
		}
	}
	// The conflict pair: whichever merges first wins; the other must be rejected by the merge queue.
	const pair = ["c1", "c2"].map((a) => outcome(a)).sort().join(",");
	if (pair !== "conflict,merged") {
		ok = false;
		bad.push(`c1/c2: expected one merged and one conflict, got ${pair}`);
	}
	const agents = state.agents.filter((a) => a.task_id === task).map((a) => a.agent_id);
	const rows = agents.map(latest).filter(Boolean);
	const count = (f) => rows.filter(f).length;
	const lat = rows.filter((v) => v.pushed_at).map((v) => Date.parse(v.created_at) - Date.parse(v.pushed_at)).sort((a, b) => a - b);
	const median = lat.length ? (lat.length % 2 ? lat[(lat.length - 1) / 2] : (lat[lat.length / 2 - 1] + lat[lat.length / 2]) / 2) : null;
	const reasons = {};
	for (const a of agents) for (const c of codes(a)) reasons[c] = (reasons[c] ?? 0) + 1;
	console.log(`agents ${agents.length} · verified ${count((v) => v.verdict === "verified")} (merged ${count((v) => v.merge_status === "merged")}, merge conflict ${count((v) => v.merge_status === "conflict")}) · rejected ${count((v) => v.verdict === "rejected")} · needs_review ${count((v) => v.verdict === "needs_review")} · merge error ${count((v) => v.merge_status === "error")}`);
	console.log(`median push -> verdict ${median === null ? "n/a" : (median / 1000).toFixed(1) + " s"} · max ${lat.length ? (lat[lat.length - 1] / 1000).toFixed(1) + " s" : "n/a"}`);
	console.log(`reasons: ${Object.entries(reasons).sort().map(([k, n]) => `${k} ${n}`).join(" · ")}`);
	console.log(`conflict pair: c1 ${outcome("c1")}, c2 ${outcome("c2")}`);
	for (const b of bad) console.log(`MISMATCH ${b}`);
	console.log(ok ? "SCALE PLAN OK" : "SCALE PLAN MISMATCH");
	process.exit(ok ? 0 : 1);
} else if (cmd === "table") {
	// Final summary table for the screen, in plain words. The API keeps the short codes.
	const REASON = {
		PROTECTED_PATH: "touched a protected file",
		UNCLAIMED_CHANGE: "changed a file it did not claim",
		CLAIMED_NOT_CHANGED: "claimed a change it did not make",
		LLM_NO: "the claim does not match the diff",
		CLAIM_INVALID: "the claim file is missing or invalid",
		DIFF_TOO_LARGE: "the change is too large",
	};
	const plain = (a) => {
		const o = outcome(a);
		if (o === "merged") return "verified, merged";
		if (o === "conflict") return "verified, but blocked: another change already edited the same file";
		if (o === "error") return "verified, but the merge failed";
		if (o === "queued") return "verified, waiting to merge";
		if (o === "needs_review") return "needs review: the checker could not decide";
		if (o === "waiting") return "waiting for a verdict";
		return "rejected: " + codes(a).map((c) => REASON[c] ?? c).join("; ");
	};
	const agents = state.agents.filter((a) => a.task_id === task).map((a) => a.agent_id);
	const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
	const rows = agents.map((a) => [a, cut(latest(a)?.summary ?? "(no valid claim)", 42), plain(a)]);
	const head = ["agent", "claim", "result"];
	const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
	const line = (r) => "| " + r.map((c, i) => c.padEnd(w[i])).join(" | ") + " |";
	const sep = "+-" + w.map((n) => "-".repeat(n)).join("-+-") + "-+";
	console.log([sep, line(head), sep, ...rows.map(line), sep].join("\n"));
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
