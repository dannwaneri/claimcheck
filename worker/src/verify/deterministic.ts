import type { Claim } from "../claim";
import { CLAIM_DIR, type FileChange, type Finding, type Policy } from "./types";

// "**/" matches zero or more folders; a trailing "**" matches one or more path chars.
// "*" and "?" stay inside one segment.
export function matchesGlob(path: string, glob: string, opts: { ignoreCase?: boolean } = {}): boolean {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") {
			re += "(?:.*/)?";
			i += 2;
		} else if (ch === "*" && glob[i + 1] === "*") {
			re += ".+";
			i++;
		} else if (ch === "*") re += "[^/]*";
		else if (ch === "?") re += "[^/]";
		else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`, opts.ignoreCase ? "i" : "").test(path);
}

export function checkDeterministic(claim: Claim, changes: FileChange[], policy: Policy): Finding[] {
	const findings: Finding[] = [];
	const real = changes.filter((c) => !c.path.startsWith(CLAIM_DIR));
	const claimed = new Set(claim.scope.paths);
	const changed = new Set(real.map((c) => c.path));

	for (const c of real) {
		if (!claimed.has(c.path)) {
			findings.push({ code: "UNCLAIMED_CHANGE", path: c.path, detail: `${c.path} was ${c.status} but is not in scope.paths` });
		}
		// Case-insensitive: src/Auth/x.js lands in src/auth/ on macOS and Windows checkouts.
		const hit = policy.protectedPaths.find((g) => matchesGlob(c.path, g, { ignoreCase: true }));
		if (hit) {
			findings.push({ code: "PROTECTED_PATH", path: c.path, detail: `${c.path} matches protected path ${hit}` });
		}
	}

	for (const p of claim.scope.paths) {
		if (!changed.has(p)) findings.push({ code: "CLAIMED_NOT_CHANGED", path: p, detail: `${p} is in scope.paths but did not change` });
	}

	const lines = real.reduce((n, c) => n + c.additions + c.deletions, 0);
	if (lines > policy.maxLines) {
		findings.push({ code: "DIFF_TOO_LARGE", detail: `${lines} lines changed; limit is ${policy.maxLines}` });
	}
	if (real.length > policy.maxFiles) {
		findings.push({ code: "DIFF_TOO_LARGE", detail: `${real.length} files changed; limit is ${policy.maxFiles}` });
	}

	return findings;
}
