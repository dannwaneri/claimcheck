import type { RepoDO } from "./repo-do";

export interface Env {
	ARTIFACTS: Artifacts;
	AI: Ai;
	REPO_DO: DurableObjectNamespace<RepoDO>;
	CANON_REPO: string;
	LLM_MODEL: string;
}

// No fallback: without the real binding, fail loudly.
export function requireArtifacts(env: Partial<Env>): asserts env is Env {
	if (!env.ARTIFACTS) {
		throw new Error("env.ARTIFACTS binding is missing. Add an `artifacts` entry to wrangler.jsonc and deploy on the Workers Paid plan.");
	}
}

export function repoStub(env: Env) {
	return env.REPO_DO.get(env.REPO_DO.idFromName(env.CANON_REPO));
}
