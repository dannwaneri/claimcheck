// Diff two commits with the Artifacts binding's read methods only.
// The binding has no diff API, so we walk both trees and skip subtrees whose hashes match.
import { createTwoFilesPatch, diffLines } from "diff";
import type { FileChange } from "./verify/types";

interface TreeEntry {
	name: string;
	hash: string;
	type: string;
}

// The subset of ArtifactsRepo this module needs. A real `using repo = await env.ARTIFACTS.get(...)` satisfies it.
export interface GitReader {
	readCommit(hash: string): Promise<{ treeHash: string } | null>;
	readTree(hash: string): Promise<TreeEntry[] | null>;
	readBlob(hash: string): Promise<Blob | null>;
}

type RawChange = Omit<FileChange, "additions" | "deletions">;

async function tree(repo: GitReader, hash: string | null): Promise<Map<string, TreeEntry>> {
	if (hash === null) return new Map();
	const entries = await repo.readTree(hash);
	if (entries === null) throw new Error(`tree ${hash} not found`);
	return new Map(entries.map((e) => [e.name, e]));
}

async function walk(repo: GitReader, oldTree: string | null, newTree: string | null, prefix: string, out: RawChange[]) {
	const [a, b] = await Promise.all([tree(repo, oldTree), tree(repo, newTree)]);
	const names = new Set([...a.keys(), ...b.keys()]);
	const subwalks: Promise<void>[] = [];

	for (const name of names) {
		const o = a.get(name);
		const n = b.get(name);
		if (o && n && o.hash === n.hash) continue;
		const path = prefix + name;
		const oDir = o?.type === "tree";
		const nDir = n?.type === "tree";

		if (oDir || nDir) {
			subwalks.push(walk(repo, oDir ? o!.hash : null, nDir ? n!.hash : null, `${path}/`, out));
		}
		const oFile = o && !oDir ? o : undefined;
		const nFile = n && !nDir ? n : undefined;
		if (oFile || nFile) {
			out.push({
				path,
				status: oFile && nFile ? "modified" : oFile ? "deleted" : "added",
				oldHash: oFile?.hash ?? null,
				newHash: nFile?.hash ?? null,
			});
		}
	}
	await Promise.all(subwalks);
}

export async function readText(repo: GitReader, hash: string | null): Promise<string> {
	if (hash === null) return "";
	const blob = await repo.readBlob(hash);
	if (blob === null) throw new Error(`blob ${hash} not found`);
	return blob.text();
}

const isBinary = (s: string) => s.includes("\0");

// A binary file counts as one changed line per side; a text diff of it means nothing.
export function lineCounts(oldText: string, newText: string) {
	if (isBinary(oldText) || isBinary(newText)) {
		return { additions: newText === "" ? 0 : 1, deletions: oldText === "" ? 0 : 1 };
	}
	let additions = 0;
	let deletions = 0;
	for (const part of diffLines(oldText, newText)) {
		if (part.added) additions += part.count ?? 0;
		else if (part.removed) deletions += part.count ?? 0;
	}
	return { additions, deletions };
}

export async function diffCommits(repo: GitReader, baseCommit: string, headCommit: string): Promise<FileChange[]> {
	const [base, head] = await Promise.all([repo.readCommit(baseCommit), repo.readCommit(headCommit)]);
	if (!base) throw new Error(`commit ${baseCommit} not found`);
	if (!head) throw new Error(`commit ${headCommit} not found`);

	const raw: RawChange[] = [];
	await walk(repo, base.treeHash, head.treeHash, "", raw);
	raw.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

	return Promise.all(
		raw.map(async (c) => {
			const [o, n] = await Promise.all([readText(repo, c.oldHash), readText(repo, c.newHash)]);
			return { ...c, ...lineCounts(o, n) };
		}),
	);
}

export function unifiedDiff(path: string, oldText: string, newText: string): string {
	if (isBinary(oldText) || isBinary(newText)) return `Binary file ${path} changed`;
	return createTwoFilesPatch(`a/${path}`, `b/${path}`, oldText, newText, "", "", { context: 3 })
		.split("\n")
		.filter((l) => !l.startsWith("==="))
		.join("\n");
}
