// In-memory filesystem for isomorphic-git, copied from the Cloudflare Artifacts isomorphic-git example:
// https://developers.cloudflare.com/artifacts/examples/isomorphic-git/

type Entry =
	| {
			kind: "dir";
			children: Set<string>;
			mtimeMs: number;
	  }
	| {
			kind: "file";
			data: Uint8Array;
			mtimeMs: number;
	  };

class MemoryStats {
	entry: Entry;

	constructor(entry: Entry) {
		this.entry = entry;
	}

	get size() {
		return this.entry.kind === "file" ? this.entry.data.byteLength : 0;
	}

	get mtimeMs() {
		return this.entry.mtimeMs;
	}

	get ctimeMs() {
		return this.entry.mtimeMs;
	}

	get mode() {
		return this.entry.kind === "file" ? 0o100644 : 0o040000;
	}

	isFile() {
		return this.entry.kind === "file";
	}

	isDirectory() {
		return this.entry.kind === "dir";
	}

	isSymbolicLink() {
		return false;
	}
}

// isomorphic-git checks err.code (for example "ENOENT") to tell a missing file from a real failure.
function fsError(code: string, path: string) {
	return Object.assign(new Error(`${code}: ${path}`), { code });
}

export class MemoryFS {
	encoder = new TextEncoder();
	decoder = new TextDecoder();
	entries = new Map<string, Entry>([
		["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }],
	]);

	promises = {
		readFile: this.readFile.bind(this),
		writeFile: this.writeFile.bind(this),
		unlink: this.unlink.bind(this),
		readdir: this.readdir.bind(this),
		mkdir: this.mkdir.bind(this),
		rmdir: this.rmdir.bind(this),
		stat: this.stat.bind(this),
		lstat: this.lstat.bind(this),
		readlink: this.readlink.bind(this),
		symlink: this.symlink.bind(this),
	};

	normalize(input: string) {
		const segments: string[] = [];

		for (const part of input.split("/")) {
			if (!part || part === ".") {
				continue;
			}

			if (part === "..") {
				segments.pop();
				continue;
			}

			segments.push(part);
		}

		return `/${segments.join("/")}` || "/";
	}

	parent(path: string) {
		const normalized = this.normalize(path);
		if (normalized === "/") {
			return "/";
		}

		const parts = normalized.split("/").filter(Boolean);
		parts.pop();
		return parts.length ? `/${parts.join("/")}` : "/";
	}

	basename(path: string) {
		return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
	}

	getEntry(path: string) {
		return this.entries.get(this.normalize(path));
	}

	requireEntry(path: string) {
		const entry = this.getEntry(path);
		if (!entry) {
			throw fsError("ENOENT", path);
		}

		return entry;
	}

	requireDir(path: string) {
		const entry = this.requireEntry(path);
		if (entry.kind !== "dir") {
			throw fsError("ENOTDIR", path);
		}

		return entry;
	}

	async mkdir(path: string, options?: { recursive?: boolean } | number) {
		const target = this.normalize(path);
		if (target === "/") {
			return;
		}

		const recursive =
			typeof options === "object" && options !== null && options.recursive;
		const parent = this.parent(target);

		if (!this.entries.has(parent)) {
			if (!recursive) {
				throw fsError("ENOENT", parent);
			}

			await this.mkdir(parent, { recursive: true });
		}

		if (this.entries.has(target)) {
			return;
		}

		this.entries.set(target, {
			kind: "dir",
			children: new Set(),
			mtimeMs: Date.now(),
		});

		this.requireDir(parent).children.add(this.basename(target));
	}

	async writeFile(path: string, data: string | Uint8Array | ArrayBuffer) {
		const target = this.normalize(path);
		await this.mkdir(this.parent(target), { recursive: true });

		const bytes =
			typeof data === "string"
				? this.encoder.encode(data)
				: data instanceof Uint8Array
					? data
					: new Uint8Array(data);

		this.entries.set(target, {
			kind: "file",
			data: bytes,
			mtimeMs: Date.now(),
		});

		this.requireDir(this.parent(target)).children.add(this.basename(target));
	}

	async readFile(path: string, options?: string | { encoding?: string }) {
		const entry = this.requireEntry(path);
		if (entry.kind !== "file") {
			throw fsError("EISDIR", path);
		}

		const encoding = typeof options === "string" ? options : options?.encoding;
		return encoding ? this.decoder.decode(entry.data) : entry.data;
	}

	async readdir(path: string) {
		return [...this.requireDir(path).children].sort();
	}

	async unlink(path: string) {
		const target = this.normalize(path);
		const entry = this.requireEntry(target);
		if (entry.kind !== "file") {
			throw fsError("EISDIR", path);
		}

		this.entries.delete(target);
		this.requireDir(this.parent(target)).children.delete(this.basename(target));
	}

	async rmdir(path: string) {
		const target = this.normalize(path);
		const entry = this.requireDir(target);
		if (entry.children.size > 0) {
			throw fsError("ENOTEMPTY", path);
		}

		this.entries.delete(target);
		this.requireDir(this.parent(target)).children.delete(this.basename(target));
	}

	async stat(path: string) {
		return new MemoryStats(this.requireEntry(path));
	}

	async lstat(path: string) {
		return this.stat(path);
	}

	// isomorphic-git requires these two. Symlinks are stored as files holding the target path.
	async readlink(path: string) {
		return (await this.readFile(path)) as Uint8Array;
	}

	async symlink(target: string, path: string) {
		await this.writeFile(path, target);
	}
}
