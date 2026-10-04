import { renderDashboard } from "./dashboard";
import { repoStub, requireArtifacts, type Env } from "./env";
import { DEFAULT_POLICY, type Policy } from "./verify/types";

export { RepoDO } from "./repo-do";
export { VerifyWorkflow } from "./workflow";

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

async function createCanon(env: Env) {
	try {
		using repo = await env.ARTIFACTS.get(env.CANON_REPO);
		const info = await repo.info();
		const token = await repo.createToken("write", 3600);
		return { created: false, name: info.name, remote: info.remote, token: token.plaintext };
	} catch {
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
	const [head] = await canon.log({ ref: "main", limit: 1 });
	if (!head) return Response.json({ error: "canon has no commits on main; push a base commit first" }, { status: 409 });

	// One fork per agent, all at once.
	const forks = await Promise.all(
		(agents as string[]).map(async (agent_id) => {
			const f = await canon.fork(`${id}-${agent_id}`, { defaultBranchOnly: true, description: `claimcheck ${id} ${agent_id}` });
			return { agent_id, fork: f.name, remote: f.remote, token: f.token };
		}),
	);

	await repoStub(env).createTask({ id, base: head.hash, policy, agents: forks.map(({ token: _, ...a }) => a) });
	return Response.json({ task_id: id, base: head.hash, policy, agents: forks }, { status: 201 });
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		requireArtifacts(env);
		const url = new URL(req.url);

		if (req.method === "GET" && url.pathname === "/") {
			const html = renderDashboard(await repoStub(env).snapshot(), env.LLM_MODEL);
			return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
		}
		if (req.method === "GET" && url.pathname === "/api/state") return Response.json(await repoStub(env).snapshot());
		if (req.method === "POST" && url.pathname === "/canon") return Response.json(await createCanon(env));
		if (req.method === "POST" && url.pathname === "/tasks") {
			const body = await req.json().catch(() => null);
			if (!body || typeof body !== "object") return Response.json({ error: "JSON body required" }, { status: 400 });
			return createTask(env, body as any);
		}
		return Response.json({ routes: ["GET /", "GET /api/state", "POST /canon", "POST /tasks {agents, policy?}"] }, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
