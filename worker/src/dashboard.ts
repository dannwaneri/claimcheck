// One server-rendered page. Refreshes itself every 3 s so a demo run updates live.
import type { RepoDO, VerdictRow } from "./repo-do";
import { summarize, type Summary } from "./summary";

type Snapshot = ReturnType<RepoDO["snapshot"]>;

const esc = (s: unknown) =>
	String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const short = (sha: string | null) => (sha ? esc(sha.slice(0, 7)) : "");

function outcome(v: VerdictRow | undefined): { label: string; cls: string } {
	if (!v) return { label: "waiting for push", cls: "wait" };
	if (v.verdict === "rejected") return { label: "rejected", cls: "bad" };
	if (v.verdict === "needs_review") return { label: "needs review", cls: "warn" };
	switch (v.merge_status) {
		case "merged": return { label: "verified · merged", cls: "good" };
		case "conflict": return { label: "verified · merge rejected", cls: "bad" };
		case "error": return { label: "verified · merge error", cls: "warn" };
		default: return { label: "verified · in merge queue", cls: "wait" };
	}
}

function evidence(v: VerdictRow | undefined): string {
	if (!v) return "";
	const parts: string[] = [];
	for (const f of v.findings) parts.push(`<li><code>${esc(f.code)}</code> ${esc(f.detail)}</li>`);
	for (const j of v.llm) {
		parts.push(
			`<li><code>LLM ${esc(j.matches)}</code> <b>${esc(j.path)}</b>: ${esc(j.reason || j.error)}` +
				(j.evidence ? `<pre>${esc(j.evidence)}</pre>` : "") +
				`</li>`,
		);
	}
	if (v.merge_status === "conflict" && v.merge_detail) {
		const d = JSON.parse(v.merge_detail);
		parts.push(`<li><code>MERGE_CONFLICT</code> canon changed ${d.paths.map((p: string) => `<b>${esc(p)}</b>`).join(", ")} since the task base (canon ${short(d.canon_head)})</li>`);
	}
	if (v.merge_status === "error") parts.push(`<li><code>MERGE_ERROR</code> ${esc(v.merge_detail)}</li>`);
	if (v.merge_status === "merged") parts.push(`<li><code>MERGED</code> canon commit ${short(v.merged_commit)}${v.merge_detail ? ` (${esc(v.merge_detail)})` : ""}</li>`);
	return parts.length ? `<ul>${parts.join("")}</ul>` : "";
}

function summaryBlock(sum: Summary): string {
	const c = sum.counts;
	const secs = sum.medianPushToVerdictMs === null ? "n/a" : `${(sum.medianPushToVerdictMs / 1000).toFixed(1)} s`;
	const reasons = Object.entries(sum.reasons).map(([code, n]) => `<code>${esc(code)}</code> ${n}`).join(" · ") || "none";
	return `<p class="summary"><b>${c.agents}</b> agents · <span class="good">${c.verified} verified</span> (${c.merged} merged, ${c.merge_rejected} merge rejected) · <span class="bad">${c.rejected} rejected</span> · <span class="warn">${c.needs_review} needs review</span>${c.waiting ? ` · ${c.waiting} waiting` : ""} · median push → verdict <b>${secs}</b><br><span class="muted">reasons:</span> ${reasons}</p>`;
}

export function renderDashboard(s: Snapshot, model: string): string {
	const sections = s.tasks.map((t) => {
		const agents = s.agents.filter((a) => a.task_id === t.id);
		const rows = agents.map((a) => {
			const pushes = s.verdicts.filter((v) => v.fork === a.fork);
			const last = pushes[pushes.length - 1];
			const o = outcome(last);
			return `<tr>
				<td><b>${esc(a.agent_id)}</b><div class="muted">${esc(a.fork)}</div></td>
				<td>${last ? esc(last.summary ?? "(no valid claim)") : ""}${last ? `<div class="muted">commit ${short(last.commit)} · ${pushes.length} push${pushes.length === 1 ? "" : "es"}</div>` : ""}</td>
				<td><span class="badge ${o.cls}">${esc(o.label)}</span></td>
				<td>${evidence(last)}</td>
			</tr>`;
		});
		return `<section>
			<h2>Task <code>${esc(t.id)}</code></h2>
			${summaryBlock(summarize(s.verdicts.filter((v) => v.task_id === t.id), agents.map((a) => a.agent_id)))}
			<p class="muted">base ${short(t.base)} · protected ${esc(t.policy.protectedPaths.join(", "))} · max ${esc(t.policy.maxLines)} lines / ${esc(t.policy.maxFiles)} files · created ${esc(t.created_at)}</p>
			<table><thead><tr><th>Agent</th><th>Claim</th><th>Result</th><th>Evidence</th></tr></thead><tbody>${rows.join("")}</tbody></table>
		</section>`;
	});

	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3"><title>claimcheck</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#6b6b6b;--line:#e3e3e3;--good:#0a7d32;--bad:#b42318;--warn:#a15c00;--wait:#555;--code:#f4f4f4}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#ececec;--muted:#9a9a9a;--line:#2c2c2c;--good:#4cc27a;--bad:#ff6b5e;--warn:#f0a73a;--wait:#aaa;--code:#1e1e1e}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0 auto;max-width:1200px;padding:16px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 4px}.muted{color:var(--muted);font-size:12px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}
code,pre{background:var(--code);border-radius:4px;font:12px ui-monospace,monospace;padding:1px 4px}pre{margin:4px 0;padding:6px;white-space:pre-wrap;word-break:break-word}
ul{margin:0;padding-left:16px}.badge{border:1px solid currentColor;border-radius:999px;font-size:12px;padding:2px 8px;white-space:nowrap}
.summary{background:var(--code);border-radius:6px;padding:8px 10px}.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}.wait{color:var(--wait)}
@media (max-width:700px){th:nth-child(2),td:nth-child(2){display:none}}
</style></head><body>
<h1>claimcheck</h1>
<p class="muted">Agents declare claims. Only verified changes merge. Canon repo: <code>canon</code> · LLM: <code>${esc(model)}</code></p>
${s.tasks.length > 1 ? `<h2>All tasks</h2>${summaryBlock(summarize(s.verdicts, s.agents.map((a) => a.fork)))}` : ""}
${sections.join("") || "<p>No tasks yet. Create one with <code>POST /tasks</code>.</p>"}
</body></html>`;
}
