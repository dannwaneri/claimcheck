// Test-only fake of the three ArtifactsRepo read methods the diff uses.
// It is never imported by src/; runtime code always uses env.ARTIFACTS.
import { describe, expect, it } from "vitest";
import { diffCommits, type GitReader } from "../src/diff";

type Files = Record<string, string>;

class FakeRepo implements GitReader {
	objects = new Map<string, unknown>();
	treeReads = 0;

	commit(name: string, files: Files): string {
		const treeHash = this.writeTree(files);
		const hash = `commit-${name}`;
		this.objects.set(hash, { hash, treeHash });
		return hash;
	}

	private writeTree(files: Files): string {
		const children = new Map<string, Files | string>();
		for (const [path, content] of Object.entries(files)) {
			const [head, ...rest] = path.split("/");
			if (rest.length === 0) children.set(head, content);
			else {
				const sub = (children.get(head) as Files | undefined) ?? {};
				sub[rest.join("/")] = content;
				children.set(head, sub);
			}
		}
		const entries = [...children.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, v]) => {
			if (typeof v === "string") {
				const hash = `blob:${v}`;
				this.objects.set(hash, v);
				return { name, mode: "100644", hash, type: "blob" as const };
			}
			return { name, mode: "40000", hash: this.writeTree(v), type: "tree" as const };
		});
		const hash = `tree:${JSON.stringify(entries)}`;
		this.objects.set(hash, entries);
		return hash;
	}

	async readCommit(hash: string) {
		return (this.objects.get(hash) as { hash: string; treeHash: string } | undefined) ?? null;
	}
	async readTree(hash: string) {
		this.treeReads++;
		return (this.objects.get(hash) as any[] | undefined) ?? null;
	}
	async readBlob(hash: string) {
		const v = this.objects.get(hash);
		return typeof v === "string" ? new Blob([v]) : null;
	}
}

const base: Files = {
	"README.md": "# sample\n",
	"src/math.js": "export const add = (a, b) => a + b;\n",
	"src/strings.js": "export const up = (s) => s.toUpperCase();\n",
	"src/auth/session.js": "export const check = () => true;\n",
	"lib/deep/a/b/c.js": "c\n",
};

describe("diffCommits", () => {
	it("returns nothing for identical commits", async () => {
		const r = new FakeRepo();
		expect(await diffCommits(r, r.commit("base", base), r.commit("head", base))).toEqual([]);
	});

	it("detects a modified file with line counts", async () => {
		const r = new FakeRepo();
		const b = r.commit("base", base);
		const h = r.commit("head", { ...base, "src/math.js": base["src/math.js"] + "export const sub = (a, b) => a - b;\n" });
		expect(await diffCommits(r, b, h)).toEqual([
			{ path: "src/math.js", status: "modified", oldHash: `blob:${base["src/math.js"]}`, newHash: expect.stringContaining("sub"), additions: 1, deletions: 0 },
		]);
	});

	it("counts a replaced line as one addition and one deletion", async () => {
		const r = new FakeRepo();
		const b = r.commit("base", base);
		const h = r.commit("head", { ...base, "src/strings.js": "export const up = (s) => s.toLowerCase();\n" });
		const [c] = await diffCommits(r, b, h);
		expect(c).toMatchObject({ path: "src/strings.js", additions: 1, deletions: 1 });
	});

	it("detects an added file in a new directory", async () => {
		const r = new FakeRepo();
		const b = r.commit("base", base);
		const h = r.commit("head", { ...base, ".claim/claim.json": "{\n}\n" });
		expect(await diffCommits(r, b, h)).toEqual([
			{ path: ".claim/claim.json", status: "added", oldHash: null, newHash: "blob:{\n}\n", additions: 2, deletions: 0 },
		]);
	});

	it("detects a deleted file", async () => {
		const r = new FakeRepo();
		const b = r.commit("base", base);
		const { ["README.md"]: _, ...rest } = base;
		const h = r.commit("head", rest);
		expect(await diffCommits(r, b, h)).toEqual([
			{ path: "README.md", status: "deleted", oldHash: "blob:# sample\n", newHash: null, additions: 0, deletions: 1 },
		]);
	});

	it("lists every file under a deleted directory", async () => {
		const r = new FakeRepo();
		const b = r.commit("base", base);
		const { ["src/auth/session.js"]: _, ...rest } = base;
		const h = r.commit("head", rest);
		const out = await diffCommits(r, b, h);
		expect(out.map((c) => [c.path, c.status])).toEqual([["src/auth/session.js", "deleted"]]);
	});

	it("finds a change deep in the tree", async () => {
		const r = new FakeRepo();
		const b = r.commit("base", base);
		const h = r.commit("head", { ...base, "lib/deep/a/b/c.js": "c2\n" });
		expect((await diffCommits(r, b, h)).map((c) => c.path)).toEqual(["lib/deep/a/b/c.js"]);
	});

	it("does not read unchanged subtrees", async () => {
		const r = new FakeRepo();
		const b = r.commit("base", base);
		const h = r.commit("head", { ...base, "README.md": "# changed\n" });
		r.treeReads = 0;
		await diffCommits(r, b, h);
		// Only the two root trees. src/ and lib/ have equal hashes and are skipped.
		expect(r.treeReads).toBe(2);
	});

	it("returns several changes sorted by path", async () => {
		const r = new FakeRepo();
		const b = r.commit("base", base);
		const h = r.commit("head", { ...base, "src/strings.js": "x\n", "README.md": "y\n", "src/auth/session.js": "z\n" });
		expect((await diffCommits(r, b, h)).map((c) => c.path)).toEqual(["README.md", "src/auth/session.js", "src/strings.js"]);
	});

	it("throws when a commit is missing", async () => {
		const r = new FakeRepo();
		const b = r.commit("base", base);
		await expect(diffCommits(r, b, "commit-nope")).rejects.toThrow(/commit-nope/);
	});
});
