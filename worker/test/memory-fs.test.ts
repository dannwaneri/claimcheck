// isomorphic-git must accept MemoryFS. The helper copied from the Cloudflare docs
// lacked readlink/symlink, which made every git call in merge.ts throw.
import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { MemoryFS } from "../src/memory-fs";

describe("MemoryFS with isomorphic-git", () => {
	it("supports init, add, remove, commit, and reading the tree back", async () => {
		const fs = new MemoryFS();
		const dir = "/repo";
		const author = { name: "t", email: "t@example.invalid" };
		await git.init({ fs, dir, defaultBranch: "main" });

		await fs.promises.writeFile(`${dir}/src/math.js`, "export const add = 1;\n");
		await fs.promises.writeFile(`${dir}/README.md`, "# r\n");
		await git.add({ fs, dir, filepath: "src/math.js" });
		await git.add({ fs, dir, filepath: "README.md" });
		await git.commit({ fs, dir, message: "one", author });

		await fs.promises.unlink(`${dir}/README.md`);
		await git.remove({ fs, dir, filepath: "README.md" });
		const sha = await git.commit({ fs, dir, message: "two", author });

		expect(await git.listFiles({ fs, dir, ref: sha })).toEqual(["src/math.js"]);
	});

	it("round-trips a symlink", async () => {
		const fs = new MemoryFS();
		await fs.promises.symlink("target.txt", "/a/link");
		expect(new TextDecoder().decode(await fs.promises.readlink("/a/link"))).toBe("target.txt");
	});
});
