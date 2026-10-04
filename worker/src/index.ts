import type { Env } from "./env";
import { handle } from "./router";

export { RepoDO } from "./repo-do";
export { VerifyWorkflow } from "./workflow";

export default {
	fetch: (req: Request, env: Env) => handle(req, env),
} satisfies ExportedHandler<Env>;
