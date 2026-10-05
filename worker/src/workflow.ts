// Runs once per push to any repo in the namespace (wrangler.jsonc triggers.events).
// event.payload is the full cf.artifacts.repo.pushed event (proved in the spike).
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { parseClaim } from "./claim";
import { diffCommits, readText, unifiedDiff } from "./diff";
import { repoStub, requireArtifacts, type Env } from "./env";
import type { Verdict } from "./repo-do";
import { checkDeterministic } from "./verify/deterministic";
import { decide, judgeChange, type Judgement } from "./verify/llm";
import { CLAIM_PATH, type Finding } from "./verify/types";

interface PushEvent {
	type: string;
	source: { namespace: string; repoName: string };
	payload: { ref: string; before: string; after: string };
	metadata?: { eventTimestamp?: string };
}

const ZERO = /^0+$/;

export class VerifyWorkflow extends WorkflowEntrypoint<Env, PushEvent> {
	async run(event: WorkflowEvent<PushEvent>, step: WorkflowStep) {
		requireArtifacts(this.env);
		const ev = event.payload;
		const fork = ev?.source?.repoName;
		const commit = ev?.payload?.after;

		if (ev?.type !== "cf.artifacts.repo.pushed" || !fork || !commit) return { skipped: "not a push event" };
		if (ZERO.test(commit)) return { skipped: "branch deleted" };
		if (fork === this.env.CANON_REPO) return { skipped: "push to canon (our own merge)" };

		const ctx = await step.do("look up fork", async () => {
			const r = await repoStub(this.env).lookupFork(fork, commit);
			// Copy out of the RPC result so the step returns plain data.
			return r
				? { task_id: r.task_id, agent_id: r.agent_id, base: r.base, alreadyJudged: r.alreadyJudged, policy: { ...r.policy, protectedPaths: [...r.policy.protectedPaths] } }
				: null;
		});
		if (!ctx) return { skipped: `${fork} is not a claimcheck agent fork` };
		// Same push event delivered twice: the verdict for (fork, commit) already exists.
		if (ctx.alreadyJudged) return { skipped: `${fork}@${commit} already has a verdict` };

		const data = await step.do("read claim and diff", async () => {
			using repo = await this.env.ARTIFACTS.get(fork);
			const claimBlob = await repo.readFile({ ref: commit, path: CLAIM_PATH });
			return {
				claimText: claimBlob ? await claimBlob.text() : null,
				changes: await diffCommits(repo, ctx.base, commit),
			};
		});

		const parsed = parseClaim(data.claimText, { task_id: ctx.task_id, agent_id: ctx.agent_id });
		const findings: Finding[] = parsed.ok ? checkDeterministic(parsed.claim, data.changes, ctx.policy) : parsed.findings;

		let verdict: Verdict = "rejected";
		let llm: Judgement[] = [];
		if (parsed.ok && findings.length === 0) {
			const claim = parsed.claim;
			// Each model call is limited to 45 s and tried twice (llm.ts), so 3 minutes is a hard ceiling.
			const result = await step.do("llm check", { timeout: "3 minutes", retries: { limit: 1, delay: "5 seconds" } }, async () => {
				using repo = await this.env.ARTIFACTS.get(fork);
				const diffs: Record<string, string> = {};
				for (const c of data.changes) {
					const [o, n] = await Promise.all([readText(repo, c.oldHash), readText(repo, c.newHash)]);
					diffs[c.path] = unifiedDiff(c.path, o, n);
				}
				const judgements = await Promise.all(
					claim.changes.map((ch) => judgeChange(this.env.AI, this.env.LLM_MODEL, ch.path, ch.description, diffs[ch.path] ?? "")),
				);
				return { judgements, verdict: decide(judgements, diffs) };
			});
			llm = result.judgements;
			verdict = result.verdict;
		}

		await step.do("record verdict", () =>
			repoStub(this.env).recordVerdict({
				task_id: ctx.task_id,
				agent_id: ctx.agent_id,
				fork,
				commit,
				summary: parsed.ok ? parsed.claim.summary : null,
				verdict,
				findings,
				llm,
				changes: data.changes,
				// Push time: the event's own timestamp, else when this Workflow run started.
				pushed_at: ev.metadata?.eventTimestamp ?? event.timestamp.toISOString(),
			}),
		);
		return { fork, commit, verdict, findings, llm };
	}
}
