// Step 2 of the verifier: ask Qwen (Workers AI) whether each change description matches its diff.
export type Match = "yes" | "no" | "unclear";

export interface Judgement {
	path: string;
	description: string;
	matches: Match;
	evidence: string;
	reason: string;
	error?: string;
}

type Parsed = { matches: Match; evidence: string; reason: string };

function extractJson(text: string): unknown {
	const noThink = text.replace(/<think>[\s\S]*?<\/think>/g, "");
	const fenced = noThink.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = fenced ? fenced[1] : noThink;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start === -1 || end <= start) throw new Error("no JSON object in model output");
	return JSON.parse(body.slice(start, end + 1));
}

export function parseJudgement(raw: unknown): { ok: true; value: Parsed } | { ok: false; error: string } {
	let obj: any;
	try {
		obj = typeof raw === "string" ? extractJson(raw) : raw;
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
	if (typeof obj !== "object" || obj === null) return { ok: false, error: "model output is not an object" };
	const matches = typeof obj.matches === "string" ? obj.matches.trim().toLowerCase() : "";
	if (!["yes", "no", "unclear"].includes(matches)) return { ok: false, error: `bad "matches" value: ${JSON.stringify(obj.matches)}` };
	if (typeof obj.evidence !== "string") return { ok: false, error: `missing "evidence"` };
	return { ok: true, value: { matches: matches as Match, evidence: obj.evidence, reason: typeof obj.reason === "string" ? obj.reason : "" } };
}

const stripPrefix = (line: string) => line.replace(/^[+\- ]/, "").trim();

// Guard against made-up evidence: every quoted line must appear in the diff.
export function evidenceInDiff(evidence: string, diff: string): boolean {
	const lines = evidence.split("\n").map(stripPrefix).filter(Boolean);
	if (lines.length === 0) return false;
	const diffLines = diff.split("\n").map(stripPrefix);
	return lines.every((ev) => diffLines.some((d) => d.includes(ev)));
}

export function decide(items: Judgement[], diffs: Record<string, string>): "verified" | "rejected" | "needs_review" {
	if (items.length === 0) return "needs_review";
	const provenNo = items.some((j) => j.matches === "no" && !j.error && evidenceInDiff(j.evidence, diffs[j.path] ?? ""));
	if (provenNo) return "rejected";
	if (items.every((j) => j.matches === "yes" && !j.error)) return "verified";
	return "needs_review";
}

const SYSTEM = "You are a strict code reviewer. You check whether a code diff does what its description says. You answer with one JSON object and nothing else.";

function prompt(description: string, diff: string) {
	return `Description of the change:
${description}

Diff:
\`\`\`diff
${diff}
\`\`\`

Does the diff do what the description says, and nothing materially different?
- "yes": the diff does what the description says.
- "no": the diff does something else, or something the description does not mention that changes behavior.
- "unclear": you cannot tell.

Reply with JSON only:
{"matches": "yes" | "no" | "unclear", "evidence": "<copy one line from the diff, exactly>", "reason": "<one sentence>"}`;
}

function responseOf(out: unknown): unknown {
	const o = out as any;
	if (o?.response !== undefined) return o.response;
	// OpenAI-style shape, returned by some Workers AI models.
	if (o?.choices?.[0]?.message?.content !== undefined) return o.choices[0].message.content;
	return o;
}

// Each model call has a time limit: in testing, one Workers AI call never answered and held a
// verdict for 5 minutes. A call that runs out of time counts as a failed try.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const limit = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`model call timed out after ${ms} ms`)), ms);
	});
	return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

// One retry on bad output, an error, or a timeout; then give up with needs_review. No open-ended loop.
export async function judgeChange(
	ai: Ai,
	model: string,
	path: string,
	description: string,
	diff: string,
	opts: { timeoutMs?: number } = {},
): Promise<Judgement> {
	const timeoutMs = opts.timeoutMs ?? 45_000;
	let lastError = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const out = await withTimeout(
				ai.run(model as any, {
					messages: [
						{ role: "system", content: SYSTEM },
						{ role: "user", content: prompt(description, diff) },
					],
					max_tokens: 1024,
					temperature: 0,
				} as any) as Promise<unknown>,
				timeoutMs,
			);
			const parsed = parseJudgement(responseOf(out));
			if (parsed.ok) return { path, description, ...parsed.value };
			lastError = parsed.error;
		} catch (e) {
			lastError = (e as Error).message;
		}
	}
	return { path, description, matches: "unclear", evidence: "", reason: "", error: `model failed twice: ${lastError}` };
}
