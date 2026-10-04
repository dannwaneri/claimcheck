// Spike: prove fork -> push -> push event -> Workflow -> readFile at the pushed commit.
// Uses the real env.ARTIFACTS binding. No fallback.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

interface Env {
	ARTIFACTS: Artifacts;
	PUSH_WF: Workflow;
}

import { diffCommits } from "../../worker/src/diff";

const CANON = "canon";

function requireBinding(env: Env) {
	if (!env.ARTIFACTS) throw new Error("env.ARTIFACTS binding is missing. Check the artifacts entry in wrangler.jsonc.");
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		requireBinding(env);
		const url = new URL(req.url);

		// Create the canon repo (or mint a write token if it exists).
		if (req.method === "POST" && url.pathname === "/canon") {
			try {
				using repo = await env.ARTIFACTS.get(CANON);
				const info = await repo.info();
				const token = await repo.createToken("write", 3600);
				return Response.json({ created: false, info, token: token.plaintext });
			} catch (e) {
				const created = await env.ARTIFACTS.create(CANON, { setDefaultBranch: "main" });
				return Response.json({ created: true, name: created.name, remote: created.remote, token: created.token, defaultBranch: created.defaultBranch });
			}
		}

		// Fork canon into ?name=<fork>.
		if (req.method === "POST" && url.pathname === "/fork") {
			const name = url.searchParams.get("name");
			if (!name) return new Response("name required", { status: 400 });
			using repo = await env.ARTIFACTS.get(CANON);
			const forked = await repo.fork(name, { defaultBranchOnly: true });
			return Response.json(forked);
		}

		// Read a file at a ref, to compare with what the Workflow saw.
		if (req.method === "GET" && url.pathname === "/file") {
			const repoName = url.searchParams.get("repo")!;
			using repo = await env.ARTIFACTS.get(repoName);
			const f = await repo.readFile({ ref: url.searchParams.get("ref")!, path: url.searchParams.get("path")! });
			return f ? new Response(await f.text()) : new Response("null", { status: 404 });
		}

		// Diff two commits with the real worker diff code.
		if (req.method === "GET" && url.pathname === "/diff") {
			using repo = await env.ARTIFACTS.get(url.searchParams.get("repo")!);
			return Response.json(await diffCommits(repo, url.searchParams.get("base")!, url.searchParams.get("head")!));
		}

		// Inspect a Workflow instance by id.
		if (req.method === "GET" && url.pathname === "/instance") {
			const inst = await env.PUSH_WF.get(url.searchParams.get("id")!);
			return Response.json(await inst.status());
		}

		return new Response("POST /canon | POST /fork?name= | GET /file?repo=&ref=&path= | GET /diff?repo=&base=&head= | GET /instance?id=", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

export class PushWorkflow extends WorkflowEntrypoint<Env, unknown> {
	async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
		// The shape of the trigger payload is not documented for Workflow targets. Log it raw.
		const raw = event.payload as any;
		console.log("SPIKE event.payload", JSON.stringify(raw));

		const ev = raw?.type ? raw : raw?.event ?? raw;
		const repoName: string | undefined = ev?.source?.repoName;
		const after: string | undefined = ev?.payload?.after;

		return await step.do("read claim at pushed commit", async () => {
			if (!repoName || !after) return { ok: false, reason: "could not find repoName/after", raw };
			using repo = await this.env.ARTIFACTS.get(repoName);
			const claim = await repo.readFile({ ref: after, path: ".claim/claim.json" });
			const commit = await repo.readCommit(after);
			return {
				ok: true,
				repoName,
				ref: ev.payload.ref,
				before: ev.payload.before,
				after,
				claim: claim ? await claim.text() : null,
				commit,
				rawType: ev.type,
			};
		});
	}
}
