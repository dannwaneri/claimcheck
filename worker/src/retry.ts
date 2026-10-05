// Bounded retry for Artifacts calls that fail for a short time (measured: forks right after a push to canon).
export interface RetryOptions {
	tries: number;
	delayMs: number; // wait before try n+1 is delayMs * n
	retryOn: (e: unknown) => boolean;
	sleep?: (ms: number) => Promise<void>;
}

const sleepFor = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const codeOf = (e: unknown) => (e as { code?: string })?.code;

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn(attempt);
		} catch (e) {
			if (attempt >= o.tries || !o.retryOn(e)) throw e;
			await (o.sleep ?? sleepFor)(o.delayMs * attempt);
		}
	}
}

const TRANSIENT = new Set(["INTERNAL_ERROR", "UPSTREAM_UNAVAILABLE"]);

export interface ForkResult {
	name: string;
	remote: string;
	token: string;
}

// Fork canon into `name`: up to 3 tries, waiting 1 s then 2 s. Retries only transient errors.
// A failed try may still have created the fork; a later ALREADY_EXISTS then reuses it.
export async function forkWithRetry(
	artifacts: Pick<Artifacts, "get">,
	canon: Pick<ArtifactsRepo, "fork">,
	name: string,
	description: string,
	sleep?: (ms: number) => Promise<void>,
): Promise<ForkResult> {
	return withRetry(
		async (attempt) => {
			try {
				const f = await canon.fork(name, { defaultBranchOnly: true, description });
				return { name: f.name, remote: f.remote, token: f.token };
			} catch (e) {
				if (attempt > 1 && codeOf(e) === "ALREADY_EXISTS") {
					using repo = await artifacts.get(name);
					const info = await repo.info();
					const token = await repo.createToken("write", 3600);
					return { name, remote: info.remote, token: token.plaintext };
				}
				throw e;
			}
		},
		{ tries: 3, delayMs: 1000, retryOn: (e) => TRANSIENT.has(codeOf(e) ?? ""), sleep },
	);
}
