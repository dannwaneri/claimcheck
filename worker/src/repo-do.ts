// One RepoDO per canon repo. Holds tasks, agents, verdicts, and the merge queue (SQL in store.ts).
// The merge queue drains in alarm(), which the runtime never runs twice at once,
// so only one merge touches canon at a time.
import { DurableObject } from "cloudflare:workers";
import { requireArtifacts, type Env } from "./env";
import { diffCommits } from "./diff";
import { applyToCanon, findConflicts, isTransientGitError } from "./merge";
import { withRetry } from "./retry";
import { Store, type QueuedMerge, type Sql, type TaskInput, type VerdictInput } from "./store";

export type { Verdict, VerdictRow } from "./store";

export class RepoDO extends DurableObject<Env> {
	private store: Store;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.store = new Store(ctx.storage.sql as unknown as Sql);
	}

	createTask(t: TaskInput) {
		this.store.createTask(t);
	}

	lookupFork(fork: string, commit: string) {
		const ctx = this.store.lookupFork(fork);
		return ctx ? { ...ctx, alreadyJudged: this.store.hasVerdict(fork, commit) } : null;
	}

	async recordVerdict(v: VerdictInput) {
		if (this.store.recordVerdict(v)) await this.ctx.storage.setAlarm(Date.now());
	}

	async reset() {
		await this.ctx.storage.deleteAlarm();
		this.store.reset();
	}

	snapshot() {
		return this.store.snapshot();
	}

	async alarm() {
		for (let next = this.store.nextQueued(); next; next = this.store.nextQueued()) {
			const r = await this.mergeOne(next).catch((e: Error) => ({ status: "error" as const, detail: e.message, commit: null }));
			this.store.setMergeResult(next.id, r.status, r.detail, r.commit);
		}
	}

	// Applies exactly the verified change: the blob hashes stored with the verdict for that commit.
	// A later push to the fork does not change what gets merged here.
	private async mergeOne(v: QueuedMerge) {
		requireArtifacts(this.env);
		const base = this.store.taskBase(v.task_id);

		using canon = await this.env.ARTIFACTS.get(this.env.CANON_REPO);
		const [head] = await canon.log({ ref: "main", limit: 1 });
		const canonChanges = head.hash === base ? [] : await diffCommits(canon, base, head.hash);
		const conflicts = findConflicts(v.changes, canonChanges);
		if (conflicts.length) {
			return { status: "conflict" as const, detail: JSON.stringify({ code: "MERGE_CONFLICT", paths: conflicts, canon_head: head.hash }), commit: null };
		}

		using fork = await this.env.ARTIFACTS.get(v.fork);
		const info = await canon.info();
		const token = await canon.createToken("write", 600);
		// Up to 3 tries on a short git-service outage (seen once: 503 on a merge push). Each try clones
		// canon again and checks that its head is still the one the conflict check used.
		let tries = 0;
		const sha = await withRetry(() => (tries++, applyToCanon({
			remote: info.remote,
			token: token.plaintext,
			expectedHead: head.hash,
			changes: v.changes,
			readBlob: async (hash) => {
				const blob = await fork.readBlob(hash);
				if (!blob) throw new Error(`blob ${hash} missing in ${v.fork}`);
				return new Uint8Array(await blob.arrayBuffer());
			},
			message: `Merge ${v.agent_id} (${v.task_id}) at ${v.commit.slice(0, 12)}: ${v.summary ?? ""}`.trim(),
			author: { name: "claimcheck", email: "merge@claimcheck.invalid" },
		})), { tries: 3, delayMs: 2000, retryOn: isTransientGitError });
		return { status: "merged" as const, detail: tries > 1 ? `merged on try ${tries}` : null, commit: sha };
	}
}
