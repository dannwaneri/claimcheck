import { CLAIM_PATH, type Finding } from "./verify/types";

export interface Claim {
	task_id: string;
	agent_id: string;
	summary: string;
	scope: { paths: string[] };
	changes: { path: string; description: string }[];
}

export type ParseResult = { ok: true; claim: Claim } | { ok: false; findings: Finding[] };

const isStr = (v: unknown): v is string => typeof v === "string";

// Exact repo-relative path: no leading slash or "./", no "..", no globs.
function pathError(p: unknown): string | null {
	if (!isStr(p) || p.length === 0) return "path must be a non-empty string";
	if (p.startsWith("/") || p.startsWith("./")) return `path "${p}" must be repo-relative (no leading / or ./)`;
	if (p.split("/").includes("..")) return `path "${p}" must not contain ..`;
	if (/[*?[\]{}]/.test(p)) return `path "${p}" must be exact, not a glob`;
	return null;
}

export function parseClaim(text: string | null, expected: { task_id: string; agent_id: string }): ParseResult {
	const fail = (...details: string[]): ParseResult => ({
		ok: false,
		findings: details.map((detail) => ({ code: "CLAIM_INVALID", path: CLAIM_PATH, detail })),
	});

	if (text === null) return fail(`${CLAIM_PATH} is missing from the pushed commit`);

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return fail(`${CLAIM_PATH} is not valid JSON: ${(e as Error).message}`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("claim must be a JSON object");

	const c = raw as Record<string, unknown>;
	const errors: string[] = [];

	for (const field of ["task_id", "agent_id"] as const) {
		if (!isStr(c[field]) || c[field] === "") errors.push(`${field} must be a non-empty string`);
		else if (c[field] !== expected[field]) errors.push(`${field} "${c[field]}" does not match expected "${expected[field]}"`);
	}

	if (!isStr(c.summary) || c.summary.trim() === "") errors.push("summary must be a non-empty string");
	else if (c.summary.length > 200) errors.push(`summary is ${c.summary.length} chars; max is 200`);

	const scope = c.scope as { paths?: unknown } | undefined;
	let scopePaths: string[] = [];
	if (typeof scope !== "object" || scope === null || !Array.isArray(scope.paths) || scope.paths.length === 0) {
		errors.push("scope.paths must be a non-empty array");
	} else {
		for (const p of scope.paths) {
			const err = pathError(p);
			if (err) errors.push(`scope.paths: ${err}`);
		}
		scopePaths = scope.paths.filter(isStr);
	}

	if (!Array.isArray(c.changes) || c.changes.length === 0) {
		errors.push("changes must be a non-empty array");
	} else {
		c.changes.forEach((ch: any, i: number) => {
			if (typeof ch !== "object" || ch === null) return errors.push(`changes[${i}] must be an object`);
			const err = pathError(ch.path);
			if (err) errors.push(`changes[${i}]: ${err}`);
			else if (!scopePaths.includes(ch.path)) errors.push(`changes[${i}].path "${ch.path}" is not in scope.paths`);
			if (!isStr(ch.description) || ch.description.trim() === "") errors.push(`changes[${i}].description must be a non-empty string`);
		});
	}

	if (errors.length) return fail(...errors);

	return {
		ok: true,
		claim: {
			task_id: c.task_id as string,
			agent_id: c.agent_id as string,
			summary: c.summary as string,
			scope: { paths: scopePaths },
			changes: (c.changes as any[]).map((ch) => ({ path: ch.path, description: ch.description })),
		},
	};
}
