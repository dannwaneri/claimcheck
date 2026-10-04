// One RepoDO per canon repo. Holds tasks, agents, verdicts, and the merge queue.
// The merge queue drains in alarm(), which the runtime never runs twice at once,
// so only one merge touches canon at a time.
import { DurableObject } from "cloudflare:workers";
import { requireArtifacts, type Env } from "./env";
import { diffCommits } from "./diff";
import { applyToCanon, findConflicts } from "./merge";
import type { FileChange, Finding, Policy } from "./verify/types";
import type { Judgement } from "./verify/llm";

export type Verdict = "verified" | "rejected" | "needs_review";
export type MergeStatus = "queued" | "merged" | "conflict" | "error";

export interface TaskInput {
	id: string;
	base: string;
	policy: Policy;
	agents: { agent_id: string; fork: string; remote: string }[];
}

export interface VerdictInput {
	id: string; // Workflow instance id; makes retries of the record step idempotent
	task_id: string;
	agent_id: string;
	fork: string;
	commit: string;
	summary: string | null;
	verdict: Verdict;
	findings: Finding[];
	llm: Judgement[];
	changes: FileChange[];
}

export interface VerdictRow extends Omit<VerdictInput, "changes"> {
	created_at: string;
	merge_status: MergeStatus | null;
	merge_detail: string | null;
	merged_commit: string | null;
}

export class RepoDO extends DurableObject<Env> {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, base TEXT NOT NULL, policy TEXT NOT NULL, created_at TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS agents (fork TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, remote TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS verdicts (
				id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, fork TEXT NOT NULL, "commit" TEXT NOT NULL,
				summary TEXT, verdict TEXT NOT NULL, findings TEXT NOT NULL, llm TEXT NOT NULL, changes TEXT NOT NULL,
				created_at TEXT NOT NULL, seq INTEGER NOT NULL,
				merge_status TEXT, merge_detail TEXT, merged_commit TEXT
			);
		`);
	}

	createTask(t: TaskInput) {
		this.sql.exec("INSERT INTO tasks VALUES (?, ?, ?, ?)", t.id, t.base, JSON.stringify(t.policy), new Date().toISOString());
		for (const a of t.agents) this.sql.exec("INSERT INTO agents VALUES (?, ?, ?, ?)", a.fork, t.id, a.agent_id, a.remote);
	}

	lookupFork(fork: string): { task_id: string; agent_id: string; base: string; policy: Policy } | null {
		const row = this.sql
			.exec<{ task_id: string; agent_id: string; base: string; policy: string }>(
				"SELECT a.task_id, a.agent_id, t.base, t.policy FROM agents a JOIN tasks t ON t.id = a.task_id WHERE a.fork = ?",
				fork,
			)
			.toArray()[0];
		return row ? { ...row, policy: JSON.parse(row.policy) } : null;
	}

	async recordVerdict(v: VerdictInput) {
		const seq = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM verdicts").one().n + 1;
		const merge = v.verdict === "verified" ? "queued" : null;
		const res = this.sql.exec(
			`INSERT OR IGNORE INTO verdicts (id, task_id, agent_id, fork, "commit", summary, verdict, findings, llm, changes, created_at, seq, merge_status)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			v.id, v.task_id, v.agent_id, v.fork, v.commit, v.summary, v.verdict,
			JSON.stringify(v.findings), JSON.stringify(v.llm), JSON.stringify(v.changes), new Date().toISOString(), seq, merge,
		);
		if (merge && res.rowsWritten > 0) await this.ctx.storage.setAlarm(Date.now());
	}

	async alarm() {
		for (;;) {
			const next = this.sql
				.exec<{ id: string; fork: string; task_id: string; agent_id: string; changes: string; summary: string | null }>(
					"SELECT id, fork, task_id, agent_id, changes, summary FROM verdicts WHERE merge_status = 'queued' ORDER BY seq LIMIT 1",
				)
				.toArray()[0];
			if (!next) return;
			const result = await this.mergeOne(next).catch((e: Error) => ({ status: "error" as const, detail: e.message, commit: null }));
			this.sql.exec(
				"UPDATE verdicts SET merge_status = ?, merge_detail = ?, merged_commit = ? WHERE id = ?",
				result.status, result.detail, result.commit, next.id,
			);
		}
	}

	private async mergeOne(v: { fork: string; task_id: string; agent_id: string; changes: string; summary: string | null }) {
		requireArtifacts(this.env);
		const base = this.sql.exec<{ base: string }>("SELECT base FROM tasks WHERE id = ?", v.task_id).one().base;
		const changes: FileChange[] = JSON.parse(v.changes);

		using canon = await this.env.ARTIFACTS.get(this.env.CANON_REPO);
		const [head] = await canon.log({ ref: "main", limit: 1 });
		const canonChanges = head.hash === base ? [] : await diffCommits(canon, base, head.hash);
		const conflicts = findConflicts(changes, canonChanges);
		if (conflicts.length) {
			return { status: "conflict" as const, detail: JSON.stringify({ code: "MERGE_CONFLICT", paths: conflicts, canon_head: head.hash }), commit: null };
		}

		using fork = await this.env.ARTIFACTS.get(v.fork);
		const info = await canon.info();
		const token = await canon.createToken("write", 600);
		const sha = await applyToCanon({
			remote: info.remote,
			token: token.plaintext,
			expectedHead: head.hash,
			changes,
			readBlob: async (hash) => {
				const blob = await fork.readBlob(hash);
				if (!blob) throw new Error(`blob ${hash} missing in ${v.fork}`);
				return new Uint8Array(await blob.arrayBuffer());
			},
			message: `Merge ${v.agent_id} (${v.task_id}): ${v.summary ?? ""}`.trim(),
			author: { name: "claimcheck", email: "merge@claimcheck.invalid" },
		});
		return { status: "merged" as const, detail: null, commit: sha };
	}

	snapshot() {
		const tasks = this.sql.exec<{ id: string; base: string; policy: string; created_at: string }>("SELECT * FROM tasks ORDER BY created_at DESC").toArray();
		const agents = this.sql.exec<{ fork: string; task_id: string; agent_id: string; remote: string }>("SELECT * FROM agents ORDER BY agent_id").toArray();
		const verdicts = this.sql
			.exec<Record<string, any>>(`SELECT id, task_id, agent_id, fork, "commit", summary, verdict, findings, llm, created_at, merge_status, merge_detail, merged_commit FROM verdicts ORDER BY seq`)
			.toArray()
			.map((r) => ({ ...r, findings: JSON.parse(r.findings), llm: JSON.parse(r.llm) }) as VerdictRow);
		return { tasks: tasks.map((t) => ({ ...t, policy: JSON.parse(t.policy) })), agents, verdicts };
	}
}
