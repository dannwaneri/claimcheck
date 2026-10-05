// SQL for RepoDO. Separate from the Durable Object so tests can run it on real SQLite (node:sqlite).
import type { FileChange, Finding, Policy } from "./verify/types";
import type { Judgement } from "./verify/llm";

export type Verdict = "verified" | "rejected" | "needs_review";
export type MergeStatus = "queued" | "merged" | "conflict" | "error";

// The subset of Durable Object SqlStorage that the store uses.
export interface Sql {
	exec<T = Record<string, any>>(query: string, ...bindings: unknown[]): { toArray(): T[]; one(): T; rowsWritten: number };
}

export interface TaskInput {
	id: string;
	base: string;
	policy: Policy;
	agents: { agent_id: string; fork: string; remote: string }[];
}

export interface VerdictInput {
	task_id: string;
	agent_id: string;
	fork: string;
	commit: string;
	summary: string | null;
	verdict: Verdict;
	findings: Finding[];
	llm: Judgement[];
	changes: FileChange[];
	pushed_at?: string | null; // when the push event happened (ISO); used for push-to-verdict time
}

export interface VerdictRow extends Omit<VerdictInput, "changes" | "pushed_at"> {
	id: string;
	pushed_at: string | null;
	created_at: string;
	merge_status: MergeStatus | null;
	merge_detail: string | null;
	merged_commit: string | null;
}

export interface QueuedMerge {
	id: string;
	fork: string;
	task_id: string;
	agent_id: string;
	commit: string;
	summary: string | null;
	changes: FileChange[];
}

// Idempotency key: one verdict per (repo, commit). A repeated push event for the same commit is a no-op.
export const verdictKey = (fork: string, commit: string) => `${fork}@${commit}`;

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, base TEXT NOT NULL, policy TEXT NOT NULL, created_at TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS agents (fork TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, remote TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS verdicts (
		id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, fork TEXT NOT NULL, "commit" TEXT NOT NULL,
		summary TEXT, verdict TEXT NOT NULL, findings TEXT NOT NULL, llm TEXT NOT NULL, changes TEXT NOT NULL,
		created_at TEXT NOT NULL, seq INTEGER NOT NULL,
		merge_status TEXT, merge_detail TEXT, merged_commit TEXT, pushed_at TEXT
	);
`;

export class Store {
	constructor(private sql: Sql) {
		this.init();
	}

	init() {
		this.sql.exec(SCHEMA);
		// Migration for tables created before pushed_at existed.
		const cols = this.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('verdicts')").toArray().map((c) => c.name);
		if (!cols.includes("pushed_at")) this.sql.exec("ALTER TABLE verdicts ADD COLUMN pushed_at TEXT");
	}

	reset() {
		this.sql.exec("DROP TABLE IF EXISTS verdicts; DROP TABLE IF EXISTS agents; DROP TABLE IF EXISTS tasks;");
		this.init();
	}

	createTask(t: TaskInput) {
		this.sql.exec("INSERT INTO tasks VALUES (?, ?, ?, ?)", t.id, t.base, JSON.stringify(t.policy), new Date().toISOString());
		for (const a of t.agents) this.sql.exec("INSERT INTO agents VALUES (?, ?, ?, ?)", a.fork, t.id, a.agent_id, a.remote);
	}

	// Policy comes from the task row written at POST /tasks. Nothing from the fork can change it.
	lookupFork(fork: string): { task_id: string; agent_id: string; base: string; policy: Policy } | null {
		const row = this.sql
			.exec<{ task_id: string; agent_id: string; base: string; policy: string }>(
				"SELECT a.task_id, a.agent_id, t.base, t.policy FROM agents a JOIN tasks t ON t.id = a.task_id WHERE a.fork = ?",
				fork,
			)
			.toArray()[0];
		return row ? { task_id: row.task_id, agent_id: row.agent_id, base: row.base, policy: JSON.parse(row.policy) } : null;
	}

	hasVerdict(fork: string, commit: string): boolean {
		return this.sql.exec("SELECT 1 FROM verdicts WHERE id = ?", verdictKey(fork, commit)).toArray().length > 0;
	}

	// Returns true if this call queued a merge (only for a new, verified verdict).
	recordVerdict(v: VerdictInput): boolean {
		const seq = this.sql.exec<{ n: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM verdicts").one().n;
		const merge = v.verdict === "verified" ? "queued" : null;
		const res = this.sql.exec(
			`INSERT OR IGNORE INTO verdicts (id, task_id, agent_id, fork, "commit", summary, verdict, findings, llm, changes, created_at, seq, merge_status, pushed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			verdictKey(v.fork, v.commit), v.task_id, v.agent_id, v.fork, v.commit, v.summary, v.verdict,
			JSON.stringify(v.findings), JSON.stringify(v.llm), JSON.stringify(v.changes), new Date().toISOString(), seq, merge, v.pushed_at ?? null,
		);
		return merge !== null && res.rowsWritten > 0;
	}

	nextQueued(): QueuedMerge | null {
		const r = this.sql
			.exec<Omit<QueuedMerge, "changes"> & { changes: string }>(
				`SELECT id, fork, task_id, agent_id, "commit", summary, changes FROM verdicts WHERE merge_status = 'queued' ORDER BY seq LIMIT 1`,
			)
			.toArray()[0];
		return r ? { ...r, changes: JSON.parse(r.changes) } : null;
	}

	setMergeResult(id: string, status: Exclude<MergeStatus, "queued">, detail: string | null, commit: string | null) {
		this.sql.exec("UPDATE verdicts SET merge_status = ?, merge_detail = ?, merged_commit = ? WHERE id = ?", status, detail, commit, id);
	}

	taskBase(taskId: string): string {
		return this.sql.exec<{ base: string }>("SELECT base FROM tasks WHERE id = ?", taskId).one().base;
	}

	snapshot() {
		const tasks = this.sql.exec<{ id: string; base: string; policy: string; created_at: string }>("SELECT * FROM tasks ORDER BY created_at DESC").toArray();
		const agents = this.sql.exec<{ fork: string; task_id: string; agent_id: string; remote: string }>("SELECT * FROM agents ORDER BY agent_id").toArray();
		const verdicts = this.sql
			.exec<Record<string, any>>(
				`SELECT id, task_id, agent_id, fork, "commit", summary, verdict, findings, llm, pushed_at, created_at, merge_status, merge_detail, merged_commit FROM verdicts ORDER BY seq`,
			)
			.toArray()
			.map((r) => ({ ...r, findings: JSON.parse(r.findings), llm: JSON.parse(r.llm) }) as VerdictRow);
		return { tasks: tasks.map((t) => ({ ...t, policy: JSON.parse(t.policy) as Policy })), agents, verdicts };
	}
}
