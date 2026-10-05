// Merge one verified change into canon. Called only from RepoDO, so merges never overlap.
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs";
import { CLAIM_DIR, type FileChange } from "./verify/types";

// File-level rule: a path conflicts if both the agent and canon changed it since the task base.
export function findConflicts(agentChanges: FileChange[], canonChanges: FileChange[]): string[] {
	const canon = new Set(canonChanges.map((c) => c.path));
	return agentChanges
		.map((c) => c.path)
		.filter((p) => !p.startsWith(CLAIM_DIR) && canon.has(p))
		.sort();
}

export interface ApplyInput {
	remote: string;
	token: string; // full token, "art_v<N>_<secret>?expires=..."
	expectedHead: string;
	changes: FileChange[];
	readBlob: (hash: string) => Promise<Uint8Array>;
	message: string;
	author: { name: string; email: string };
}

export async function applyToCanon(input: ApplyInput): Promise<string> {
	const fs = new MemoryFS();
	const dir = "/canon";
	const onAuth = () => ({ username: "x", password: input.token.split("?expires=")[0] });

	await git.clone({ fs, http, dir, url: input.remote, ref: "main", singleBranch: true, depth: 1, onAuth });
	const head = await git.resolveRef({ fs, dir, ref: "HEAD" });
	if (head !== input.expectedHead) throw new Error(`canon moved during merge: expected ${input.expectedHead}, found ${head}`);

	for (const c of input.changes) {
		if (c.path.startsWith(CLAIM_DIR)) continue;
		if (c.status === "deleted") {
			await fs.promises.unlink(`${dir}/${c.path}`);
			await git.remove({ fs, dir, filepath: c.path });
		} else {
			await fs.promises.writeFile(`${dir}/${c.path}`, await input.readBlob(c.newHash!));
			await git.add({ fs, dir, filepath: c.path });
		}
	}

	const sha = await git.commit({ fs, dir, message: input.message, author: input.author });
	const res = await git.push({ fs, http, dir, url: input.remote, ref: "main", onAuth });
	if (!res.ok) throw new Error(`push to canon failed: ${JSON.stringify(res.refs)}`);
	return sha;
}
