# claimcheck — SPEC

Status: draft for review (Step 1). Date: 2026-10-04.

## 1. Spike result

The full loop works with the real `env.ARTIFACTS` binding. Code: `spike/`. Deployed as `claimcheck-spike`.

| Step | Result | Evidence |
| --- | --- | --- |
| Create canon repo | Works | `create("canon", { setDefaultBranch: "main" })` returned `name`, `remote`, `token`, `defaultBranch` |
| Push base commit | Works | `git -c http.extraHeader="Authorization: Bearer $TOKEN" push $REMOTE HEAD:main` |
| Fork canon | Works | `repo.fork("agent-a", { defaultBranchOnly: true })` returned `id, name, description, defaultBranch, remote, token` |
| Agent push to fork | Works | Plain git push with the fork token |
| Push event starts Workflow | Works | Instance started about 5 s after each push (2 pushes, 2 instances, both `Completed`) |
| Read file at pushed commit | Works | `readFile({ ref: after, path: ".claim/claim.json" })` returned the claim text |

Workflow output for the fork push (abridged):

```json
{ "repoName": "agent-a", "ref": "refs/heads/main",
  "before": "1020ee9f…", "after": "7b58aedb…",
  "claim": "{\"task_id\":\"t1\",\"agent_id\":\"agent-a\",…}",
  "commit": { "treeHash": "2762a0a8…", "parents": ["1020ee9f…"] },
  "rawType": "cf.artifacts.repo.pushed" }
```

### Corrections to the brief

- `project.info()` is correct, but `get(name)` returns a disposable handle. Use `using repo = await env.ARTIFACTS.get(name)`.
- `create()` and `fork()` return `token` as a string. `repo.createToken()` returns `{ plaintext, expiresAt }`.
- The binding has **no write method and no diff method**. Writes need Git (isomorphic-git in the Worker; Cloudflare's own docs recommend this).
- The docs example for event triggers is wrong for Wrangler 4.147. The real schema is `targets: [{ type: "workflow", workflow_name }]` and `filter: { namespace, repo_name }`. The docs show `target` and `repoName`.

## 2. Answers to the open questions

### Q1. How do we get a diff?

The binding has no diff. It has `readCommit`, `readTree`, and `readBlob`. We walk two trees:

1. `readCommit(head).treeHash` and `readCommit(base).treeHash`.
2. `readTree` on both. Compare entries by name and hash.
3. Same hash: skip (the subtree is identical). Different tree hash: recurse. Different blob hash: `modified`. Only on one side: `added` or `deleted`.

This reads only changed subtrees. No clone, no isomorphic-git for reads.
For line counts and LLM evidence, read both blobs with `readBlob` and run a line diff (the `diff` npm package).

**Base commit:** the canon head SHA at task creation, stored with the task. Not the event's `before`. An agent can push many times; `before` is then the agent's own last commit. The fork shares objects with canon, so the base commit is readable in the fork.

### Q2. How do we subscribe to Artifacts events?

Use a Wrangler event trigger. It starts the Workflow directly. No Queue.

```jsonc
"triggers": { "events": [{
  "type": "cf.artifacts.repo.pushed",
  "filter": { "namespace": "claimcheck" },
  "targets": [{ "type": "workflow", "workflow_name": "claimcheck-verify" }]
}]}
```

`wrangler deploy` creates the trigger. `event.payload` in the Workflow is the full push event (`type`, `source.repoName`, `payload.ref`, `payload.after`).

**Why not a Queue:** the `pushed` event is repo-level. A Queue subscription needs one `namespace` + `repo_name` per repo. Forks are made at runtime, so we would need an API call per fork to subscribe. The namespace filter covers every fork with no extra step.

**This changes the brief's design (step 4).** If you want the Queue path for the judges, I can add it, but it adds per-fork subscription calls.

### Q3. Does local `wrangler dev` support the binding?

Partly. `wrangler dev` runs, but the Artifacts binding always uses the remote service (Wrangler says so). Push events do not reach local dev. They go to the deployed Workflow.
Plan: unit tests run locally (pure functions). Integration and the demo run against the deployed Worker.

### Q4. Where do verdicts live?

One Durable Object class, `RepoDO`, with SQLite storage. One instance per canon repo.
It holds tasks, agents, verdicts, evidence, and the merge queue.
Reason: the merge queue must be a DO anyway (one writer to canon). Putting verdicts in the same DO means one storage system, no D1 migrations, and no cross-store consistency.

## 3. Claim schema (final)

Path: `.claim/claim.json` at the pushed commit.

```json
{
  "task_id": "t-20261004-01",
  "agent_id": "agent-a",
  "summary": "Add a sub() helper to math.js.",
  "scope": { "paths": ["src/math.js"] },
  "changes": [
    { "path": "src/math.js", "description": "Add sub(a, b) that returns a - b." }
  ]
}
```

Rules:

- All fields are required. `summary` is one sentence, 1–200 chars.
- `scope.paths` are exact repo paths. No globs (keeps check 1 and 2 exact).
- Every `changes[].path` must be in `scope.paths`.
- `task_id` and `agent_id` must match the fork the push came from.
- `.claim/**` is never part of the diff checks.
- Missing or invalid claim → `rejected`, with the parse or schema error as evidence.

## 4. Verifier

### Step 1 — deterministic (pure function, unit tested)

`checkDeterministic(claim, changes, policy) → Finding[]`

| Check | Code | Rule |
| --- | --- | --- |
| Unclaimed change | `UNCLAIMED_CHANGE` | A path changed but is not in `scope.paths` |
| Claimed, not changed | `CLAIMED_NOT_CHANGED` | A path is in `scope.paths` but did not change |
| Protected path | `PROTECTED_PATH` | A changed path matches a protected glob (default `src/auth/**`) |
| Diff too large | `DIFF_TOO_LARGE` | Added + removed lines > limit (default 200), or changed files > limit (default 20) |
| Claim invalid | `CLAIM_INVALID` | Schema error, or `task_id`/`agent_id` mismatch |

Every finding has `{ code, path?, detail }`. Any finding → `rejected`. The LLM step does not run.

### Step 2 — LLM (runs only if step 1 passes)

**Model:** Qwen on Workers AI, through the `AI` binding (`env.AI.run(model, …)`). No API key.

- First choice: `@cf/qwen/qwen3.8-27b`.
- Backup: `@cf/qwen/qwen2.5-coder-32b-instruct`.
- Both are in the account's model list (checked 2026-10-04 with `wrangler ai models`). Neither is tested for this task yet.
- The model name is one config value (`LLM_MODEL` var in `wrangler.jsonc`). Step 3 runs the same demo diffs through both models and keeps the one that returns valid JSON every time and quotes the right lines.

For each `changes[]` item, send the description and that file's unified diff. The model returns, per item:
`{ path, matches: "yes" | "no" | "unclear", evidence: "<quote from the diff>" }`.

- All `yes` → `verified`.
- Any `no` → `rejected`.
- Any `unclear`, or the model call fails or returns bad JSON → `needs_review`. One retry on bad JSON, no loop.

### Verdict record

`{ task_id, agent_id, fork, commit, verdict, findings[], llm[], created_at }`. Stored in `RepoDO`.

## 5. Merge queue

`RepoDO` serializes merges. For each verified verdict, in arrival order:

1. Read canon head.
2. **Conflict check:** for each changed path, compare the blob hash at the task base with the blob hash at canon head. If they differ, canon changed that path since the agent started → `rejected` with `MERGE_CONFLICT` and the paths.
3. **Apply:** isomorphic-git shallow clone of canon into memory, write the fork's blobs (from `readBlob`), remove deleted paths, commit, push to canon `main`.
4. Store the new canon head and the merge record.

This is a file-level conflict rule, not a line-level 3-way merge. Two agents that touch different lines of the same file conflict. That is strict, but simple and safe.

## 6. Demo scenario

Sample repo: `src/math.js`, `src/strings.js`, `src/auth/session.js`, `README.md`.
One task, five agents, all pushing at the same time (`Promise.all` in `demo/run.ts`):

| Agent | Does | Expected |
| --- | --- | --- |
| A | Adds `sub()` to `src/math.js`, claims it | `verified`, merged |
| B | Claims a fix in `src/strings.js`, also edits `src/auth/session.js` | `rejected`: `UNCLAIMED_CHANGE` + `PROTECTED_PATH` |
| C | Claims a change to `src/strings.js`, pushes only the claim | `rejected`: `CLAIMED_NOT_CHANGED` |
| D | Adds `mul()` to `src/math.js`, honest claim | `verified`, then `rejected` by merge queue: `MERGE_CONFLICT` on `src/math.js` |
| E | Claims "trim whitespace in `slugify()`" in `src/strings.js`, but the diff removes the lowercase step instead | Step 1 passes; `rejected` by LLM, with the diff line as evidence |

**Ordering risk:** A and D both verify. The merge queue takes whichever verdict arrives first. If D lands first, D merges and A is rejected. To make the video stable, the demo script delays D's push by a few seconds after A's. All four agents still run at the same time; only D starts later. I will state this in the README.

## 7. File layout

```
claimcheck/
  LICENSE                 MIT
  SPEC.md
  README.md
  spike/                  Step 0 proof (kept for reference)
  worker/
    wrangler.jsonc        ARTIFACTS, VERIFY_WF, REPO_DO, AI, LLM_MODEL var, event trigger
    src/
      index.ts            fetch: POST /tasks, GET /tasks/:id, GET / (dashboard)
      workflow.ts         VerifyWorkflow: claim → diff → checks → LLM → verdict → enqueue
      repo-do.ts          RepoDO: tasks, verdicts, merge queue
      artifacts.ts        requireArtifacts(env), treeDiff(), lineDiff()
      claim.ts            parse + validate claim
      verify/deterministic.ts
      verify/llm.ts       judgeChange(description, diff) via env.AI (Qwen)
      merge.ts            conflict check + isomorphic-git apply
      memory-fs.ts        from the Cloudflare isomorphic-git example
      dashboard.ts        one HTML page, server-rendered
    test/
      deterministic.test.ts
      claim.test.ts
      treeDiff.test.ts    with a fake repo handle (test only; never used at runtime)
  demo/
    sample-repo/          seed files for canon
    run.ts                creates task, runs 4 agents with git CLI, prints verdicts
```

`requireArtifacts(env)` throws `"env.ARTIFACTS binding is missing"` at the top of every handler. No mock or memory fallback exists in `src/`.

## 8. Decisions for you

1. **LLM provider — DECIDED 2026-10-04: Qwen on Workers AI.** No secret, so the README works on a clean machine with only a Cloudflare login. The whole stack stays on Cloudflare.
2. **Agent E — DECIDED 2026-10-04: add it.** Without E, no agent needs the LLM. E changes only its claimed file, but the code does something else than its description. Step 1 passes; the LLM rejects it with evidence.
3. **Event path — DECIDED 2026-10-04: direct Workflow trigger.** No Queue.
4. **Conflict rule — DECIDED 2026-10-04: file-level.**

## 9. What is not done / unsure

- The verifier, merge queue, and dashboard are not built. Only the spike exists.
- No Qwen call has been made yet. JSON reliability and evidence quality are unknown.
- I did not test a push of a **deleted** file or a **new directory** through `readTree`. I expect it to work, but it is not proved.
- I did not test isomorphic-git push from a Worker to canon. The Cloudflare docs show it works; our spike did not do it.
- `event.payload` shape: proved for one push. I did not test a push with many commits or a force push.
- The spike namespace `claimcheck-spike` still holds repos `canon` and `agent-a`, and the `claimcheck-spike` Worker is deployed. Billing for Artifacts starts 2026-10-14. I will delete them after the real Worker works, unless you want them kept.
