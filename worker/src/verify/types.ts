export type FindingCode =
	| "CLAIM_INVALID"
	| "UNCLAIMED_CHANGE"
	| "CLAIMED_NOT_CHANGED"
	| "PROTECTED_PATH"
	| "DIFF_TOO_LARGE"
	| "MERGE_CONFLICT";

export interface Finding {
	code: FindingCode;
	path?: string;
	detail: string;
}

export interface FileChange {
	path: string;
	status: "added" | "modified" | "deleted";
	oldHash: string | null;
	newHash: string | null;
	additions: number;
	deletions: number;
}

export interface Policy {
	protectedPaths: string[];
	maxLines: number;
	maxFiles: number;
}

export const DEFAULT_POLICY: Policy = {
	protectedPaths: ["src/auth/**"],
	maxLines: 200,
	maxFiles: 20,
};

export const CLAIM_PATH = ".claim/claim.json";
export const CLAIM_DIR = ".claim/";
