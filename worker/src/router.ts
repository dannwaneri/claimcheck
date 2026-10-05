// HTTP routes. Kept apart from index.ts so tests can import it without the Workers runtime.
import { renderDashboard } from "./dashboard";
import { repoStub, requireArtifacts, type Env } from "./env";
import { DEFAULT_POLICY, type Policy } from "./verify/types";

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SECRET_HEADER = "x-claimcheck-secret";

// Constant-time compare, so response time does not leak how much of the secret matched.
function sameSecret(given: string, expected: string): boolean {
	const a = new TextEncoder().encode(given);
	const b = new TextEncoder().encode(expected);
	let diff = a.length ^ b.length;
	for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
	return diff === 0;
}

function authorize(req: Request, env: Env): Response | null {
	if (!env.CLAIMCHECK_SECRET) {
		return Response.json({ error: "CLAIMCHECK_SECRET is not set. Run: npx wrangler secret put CLAIMCHECK_SECRET" }, { status: 500 });
	}
	if (!sameSecret(req.headers.get(SECRET_HEADER) ?? "", env.CLAIMCHECK_SECRET)) {
		return Response.json({ error: `missing or wrong ${SECRET_HEADER} header` }, { status: 401 });
	}
	return null;
}

// Label an Artifacts call so an error says which step failed. Keeps the error code.
async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		const err = e as { message?: string; code?: string };
		throw Object.assign(new Error(`${label}: ${err.message ?? String(e)}`), { code: err.code });
	}
}

async function createCanon(env: Env) {
	try {
		using repo = await env.ARTIFACTS.get(env.CANON_REPO);
		const info = await repo.info();
		const token = await repo.createToken("write", 3600);
		return { created: false, name: info.name, remote: info.remote, token: token.plaintext };
	} catch (e) {
		if ((e as { code?: string }).code !== "NOT_FOUND") throw e;
		const created = await env.ARTIFACTS.create(env.CANON_REPO, { setDefaultBranch: "main" });
		return { created: true, name: created.name, remote: created.remote, token: created.token };
	}
}

async function createTask(env: Env, body: { agents?: unknown; policy?: Partial<Policy> }) {
	const agents = body.agents;
	if (!Array.isArray(agents) || agents.length === 0 || !agents.every((a) => typeof a === "string" && AGENT_ID.test(a))) {
		return Response.json({ error: "agents must be a non-empty array of ids matching " + AGENT_ID }, { status: 400 });
	}
	if (new Set(agents).size !== agents.length) return Response.json({ error: "agent ids must be unique" }, { status: 400 });

	const policy: Policy = { ...DEFAULT_POLICY, ...body.policy };
	const id = `t${Date.now().toString(36)}`;

	using canon = await env.ARTIFACTS.get(env.CANON_REPO);
	const [head] = await step("log canon", () => canon.log({ ref: "main", limit: 1 }));
	if (!head) return Response.json({ error: "canon has no commits on main; push a base commit first" }, { status: 409 });

	// One fork per agent, one after another. Parallel forks right after a push to canon failed
	// with INTERNAL_ERROR in 5 of 6 tries; parallel forks alone and a single fork after a push did not.
	const forks: { agent_id: string; fork: string; remote: string; token: string }[] = [];
	for (const agent_id of agents as string[]) {
		const name = `${id}-${agent_id}`;
		const f = await step(`fork ${name}`, () => canon.fork(name, { defaultBranchOnly: true, description: `claimcheck ${id} ${agent_id}` }));
		forks.push({ agent_id, fork: f.name, remote: f.remote, token: f.token });
	}

	await repoStub(env).createTask({ id, base: head.hash, policy, agents: forks.map(({ token: _, ...a }) => a) });
	return Response.json({ task_id: id, base: head.hash, policy, agents: forks }, { status: 201 });
}

// Clean slate for a demo take: clear RepoDO, then delete every agent fork in the namespace.
// Canon is kept: recreating a just-deleted repo name failed with ALREADY_EXISTS / INTERNAL_ERROR
// in testing. demo/run force-pushes the seed to canon instead.
async function reset(env: Env) {
	await repoStub(env).reset();
	const names: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.ARTIFACTS.list({ limit: 100, cursor });
		names.push(...page.repos.map((r) => r.name).filter((n) => n !== env.CANON_REPO));
		cursor = page.cursor ?? undefined;
	} while (cursor);
	const results = await Promise.all(names.map(async (n) => [n, await env.ARTIFACTS.delete(n)] as const));
	return Response.json({ deleted: results.filter(([, ok]) => ok).map(([n]) => n).sort(), failed: results.filter(([, ok]) => !ok).map(([n]) => n) });
}

export async function handle(req: Request, env: Env): Promise<Response> {
	requireArtifacts(env);
	try {
		return await route(req, env);
	} catch (e) {
		// Surface Artifacts errors (they carry a code such as NOT_FOUND or ALREADY_EXISTS) instead of a bare 500.
		const err = e as { message?: string; code?: string };
		return Response.json({ error: err.message ?? String(e), code: err.code ?? null }, { status: 500 });
	}
}

async function route(req: Request, env: Env): Promise<Response> {
	const url = new URL(req.url);

	if (req.method === "GET" && url.pathname === "/") {
		const html = renderDashboard(await repoStub(env).snapshot(), env.LLM_MODEL);
		return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
	}
	if (req.method === "GET" && url.pathname === "/api/state") return Response.json(await repoStub(env).snapshot());

	if (req.method === "POST" && ["/canon", "/tasks", "/reset"].includes(url.pathname)) {
		const denied = authorize(req, env);
		if (denied) return denied;
		if (url.pathname === "/canon") return Response.json(await createCanon(env));
		if (url.pathname === "/reset") return reset(env);
		const body = await req.json().catch(() => null);
		if (!body || typeof body !== "object") return Response.json({ error: "JSON body required" }, { status: 400 });
		return createTask(env, body as any);
	}

	return Response.json(
		{ routes: ["GET /", "GET /api/state", `POST /canon, POST /tasks {agents, policy?}, POST /reset (header ${SECRET_HEADER})`] },
		{ status: 404 },
	);
}
