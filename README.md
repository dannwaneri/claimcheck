# claimcheck

A Git platform layer for AI agents, built on Cloudflare Workers and [Artifacts](https://developers.cloudflare.com/artifacts/).

Several agents work on the same codebase at the same time. Each agent works in its own fork and must push a **claim**: which files it changed and what each change does. claimcheck checks the claim against the real diff. Only verified changes merge into the main repo.

Entry for the Cloudflare "build the next Git platform" competition. License: MIT.

## The problem

An AI agent's commit message is a claim, and nobody checks it. An agent says "fixed a typo" and also edits an auth file. It says "trimmed whitespace" and removes a different line. When many agents push at once, a human cannot read every diff. claimcheck makes the claim a required, machine-checked part of every push.

## How it works

```
 agent A   agent B   agent C   agent D   agent E        (git CLI, one fork each)
    │         │         │         │         │
    └─────────┴────┬────┴─────────┴─────────┘
                   │ git push  (fork contains .claim/claim.json)
                   ▼
        Artifacts namespace "claimcheck"
        canon + one fork per agent
                   │ event cf.artifacts.repo.pushed
                   ▼
        Workflow  VerifyWorkflow  (one run per push)
          1. read .claim/claim.json at the pushed commit
          2. diff the commit against the task base (tree walk with the binding)
          3. rule checks ─── any finding ──► verdict: rejected
          4. LLM check (Workers AI, Qwen) on each change description vs its diff
                   │ verdict + evidence
                   ▼
        Durable Object  RepoDO  (SQLite)
          tasks · verdicts · merge queue (one merge at a time)
                   │ verified only
                   ▼
        merge: file-level conflict check, then isomorphic-git push to canon
                   │
                   ▼
        Dashboard  GET /   (refreshes every 3 s)
```

- **Coordinator:** `POST /tasks` forks canon once per agent and returns each fork's remote and write token.
- **Claim file:** `.claim/claim.json` with `task_id`, `agent_id`, `summary`, `scope.paths`, and `changes[{path, description}]`. Schema: [SPEC.md §3](SPEC.md).
- **Rule checks** ([deterministic.ts](worker/src/verify/deterministic.ts)): `UNCLAIMED_CHANGE`, `CLAIMED_NOT_CHANGED`, `PROTECTED_PATH` (default `src/auth/**`, any letter case), `DIFF_TOO_LARGE`, `CLAIM_INVALID`.
- **LLM check** ([llm.ts](worker/src/verify/llm.ts)): runs only if the rule checks pass. Model `@cf/qwen/qwen3.8-27b`, `temperature: 0`, no `seed`, `reasoning_effort` not set (model default `xhigh`). A "no" must quote a line that is really in the diff; otherwise the verdict is `needs_review`. One retry on bad output, then `needs_review`.
- **Verdicts:** `verified`, `rejected`, or `needs_review`, stored with the evidence and the commit SHA. A repeated push event for the same fork and commit is ignored (key `fork@commit`).
- **Merge queue:** only `verified` verdicts enter it. The **first verified change wins**: a later change that touches a file canon already changed since the task started is rejected with `MERGE_CONFLICT` and the paths. `needs_review` verdicts stay on the dashboard; nothing merges them.

## The demo: five scripted agents

The five agents are **shell scripts, not autonomous AI**. Each one makes a fixed edit with the real git CLI, so the results repeat. They run at the same time.

| Agent | What it does | Result |
| --- | --- | --- |
| A | Adds `sub()` to `src/math.js`; honest claim | verified, merged |
| B | Claims a fix in `src/strings.js`; also edits `src/auth/session.js` | rejected: `UNCLAIMED_CHANGE` + `PROTECTED_PATH` |
| C | Claims a change to `src/strings.js`; changes nothing | rejected: `CLAIMED_NOT_CHANGED` |
| D | Adds `mul()` to `src/math.js`; honest claim | verified, then rejected by the merge queue: `MERGE_CONFLICT` on `src/math.js` |
| E | Claims "trim whitespace in slugify()"; the diff removes the lowercase step | rejected by the LLM check, which quotes the changed line |

Agent D does its work at the same time as the others but **pushes only after the API shows a final result for A** (no fixed delay). This makes A the first verified change, so D's conflict is the same on every run. If A has no result within `CLAIMCHECK_A_TIMEOUT` seconds (default 180), `demo/run` stops and says so.

`demo/run` force-pushes `demo/sample-repo` to canon at the start of each run, so every run starts from the same files.

**Tested** (Windows 11, Git Bash):
- `demo/reset` then `demo/run`, 5 times in a row: all 5 matched the table above, 40–74 s per run including the reset. (This series ran before the fork retry was added.)
- From a fresh clone in an empty folder, following the steps below: `demo/run`, `demo/reset`, `demo/run`, and `npm test` all passed. (Also before the fork retry.)
- On a brand-new, empty namespace with the current code, where the run creates canon: matched, 43 s. Two earlier fresh-namespace runs on older code also matched.

## Run it

### What you need

- A Cloudflare account on the **Workers Paid** plan (Artifacts needs it). Artifacts is in open beta.
- Workers AI (included with Workers; the demo uses about 240 neurons per run, inside the 10,000 free neurons per day).
- `git`, `bash`, `curl`, and Node.js. Tested with Node 24.15, git 2.53, Wrangler 4.147, on Windows 11 with Git Bash. **Not tested on macOS or Linux.**

### Deploy to your own Cloudflare account

Commands in order:

```bash
git clone https://github.com/dannwaneri/claimcheck.git
cd claimcheck/worker
npm ci
npx wrangler login
npx wrangler deploy
```

`wrangler deploy` prints your URL, `https://claimcheck.<your-subdomain>.workers.dev`. It also creates the push-event trigger that starts the Workflow. The Artifacts namespace `claimcheck` is created on the first repo.

Set the one secret. It protects `POST /canon`, `POST /tasks`, and `POST /reset`:

```bash
export CLAIMCHECK_SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
printf '%s' "$CLAIMCHECK_SECRET" | npx wrangler secret put CLAIMCHECK_SECRET
```

Keep that shell open (or save the value somewhere safe). **Wait about 30 seconds**: in testing, the first request right after `wrangler secret put` got `401`, and the same request a few seconds later worked. Then run the demo from the repo root:

```bash
cd ..
export CLAIMCHECK_URL=https://claimcheck.<your-subdomain>.workers.dev
demo/run
```

Open `$CLAIMCHECK_URL/` in a browser to watch the dashboard. For a clean dashboard before another take:

```bash
demo/reset
demo/run
```

`demo/reset` deletes the agent forks that claimcheck created (the forks listed in its own state), then clears all tasks and verdicts. It keeps canon, because recreating a just-deleted repo name failed in testing (see below).

> **Warning:** use the `claimcheck` Artifacts namespace only for claimcheck. `demo/reset` does not touch repos it did not create (tested: an unrelated repo in the namespace survived a reset), but `demo/run` force-pushes over `canon`, and Cloudflare cleanup commands below act on the whole namespace.

The dashboard keeps showing verdicts after the demo repos are deleted: verdicts live in the Durable Object, not in the repos (tested: all six demo repos deleted, all 5 verdicts still shown). Only `demo/reset` clears them.

### Run the tests

```bash
cd worker
npm test
```

143 tests, all local, no Cloudflare account needed. Tested on Node 24.15. The store tests use the built-in `node:sqlite` module, so an older Node may fail them.

### Clean up and billing

Artifacts billing starts **October 14, 2026** according to the [Artifacts pricing docs](https://developers.cloudflare.com/artifacts/platform/pricing/), and **October 15, 2026** according to the [Cloudflare blog post of October 1, 2026](https://blog.cloudflare.com/next-git-platform-on-cloudflare/). Plan for the earlier date: **delete the demo repos before October 14**.

```bash
cd worker
npx wrangler artifacts repos list --namespace claimcheck
npx wrangler artifacts repos delete <name> --namespace claimcheck --force   # for each repo
npx wrangler delete --name claimcheck
```

## API

| Route | Auth | Does |
| --- | --- | --- |
| `GET /` | none | Dashboard |
| `GET /api/state` | none | Tasks, agents, verdicts as JSON (no tokens) |
| `POST /canon` | `x-claimcheck-secret` | Create canon if missing; return its remote and a write token |
| `POST /tasks` `{agents: [...], policy?}` | `x-claimcheck-secret` | Fork canon once per agent; return remotes and write tokens |
| `POST /reset` | `x-claimcheck-secret` | Delete the agent forks in claimcheck's state; clear all state. Canon and other repos are kept |

## Limits

- **File-level conflicts only.** Two agents that change different lines of the same file conflict. There is no line-level merge.
- **The first verified change wins.** A later verified change to the same file is rejected, not rebased.
- **One shared secret, no full auth system.** The secret protects the write routes. The dashboard and `GET /api/state` are public to anyone with the URL. Everyone with the secret has full write access.
- **The LLM can be wrong.** On 15 labeled cases × 5 runs, Qwen's answers matched the expected label 75 of 75 times, with no case changing its answer between runs ([cases](worker/test/llm-cases/cases.json), [results](worker/test/llm-cases/results/)). That is a small set of short, one-file diffs. Vague claims ("Improve the code.") were rejected, not sent to review. The real model never returned "unclear" in that test, so the `needs_review` path is only covered by unit tests.
- **The policy is set when the task is created** (request body or defaults), not read from a file in canon. A fork cannot change it.
- **Renames** show as a delete plus an add; both paths must be in the claim.
- `needs_review` verdicts have no approve button.

## Found while building

- **The in-memory filesystem in the Cloudflare isomorphic-git example does not work with `git.clone`.** The helper on the [isomorphic-git example page](https://developers.cloudflare.com/artifacts/examples/isomorphic-git/) has no `readlink` or `symlink` methods. isomorphic-git binds both at startup, so every call failed with `Cannot read properties of undefined (reading 'bind')`. The helper also throws errors without a `code` property, and isomorphic-git checks `err.code === "ENOENT"` to tell a missing file from a real failure. Our fixed copy is [memory-fs.ts](worker/src/memory-fs.ts), with a test in [memory-fs.test.ts](worker/test/memory-fs.test.ts).
- **The event trigger example in the docs does not match Wrangler 4.147.** The [build-and-deploy guide](https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/) shows `target` and `filter.repoName`. Wrangler wants `targets: [{ type: "workflow", workflow_name }]` and `filter.repo_name`.
- **Forking several times in parallel right after a push fails often.** A push to canon followed at once by 5 parallel forks failed with `INTERNAL_ERROR` in **5 of 6** tries (each time one of the five forks failed). Without the push, 5 parallel forks worked 5 of 5 times. One fork right after a push worked 5 of 5 times. Forking one at a time right after a push worked 6 of 6 times. claimcheck now forks one at a time (about 12 s for 5 forks instead of about 3 s) and retries each fork up to 3 times on `INTERNAL_ERROR` or `UPSTREAM_UNAVAILABLE`. We do not know the cause on the Artifacts side.
- **Recreating a just-deleted repo name fails for a while.** After deleting `canon`, creating `canon` again returned `ALREADY_EXISTS`, and forking a just-recreated canon returned `INTERNAL_ERROR`. That is why `demo/reset` keeps canon.
- **The token format changed during the build** from `art_v1_<hex>` to `art_v2_x_<hex>`. Code that matches only `art_v1_` misses new tokens.
- **The binding has no diff method and no write method.** The diff is a tree walk with `readCommit`, `readTree`, and `readBlob` ([diff.ts](worker/src/diff.ts)), checked against `git diff --numstat` on a real fork. Writes to canon go through isomorphic-git.

## Repo layout

```
worker/            the Worker: routes, Workflow, Durable Object, verifier, tests
demo/run           five scripted agents (bash + git + curl + node)
demo/reset         clean state for a new take
demo/sample-repo/  the files canon starts from
spike/             Step 0 proof of the Artifacts loop (not deployed any more)
SPEC.md            design decisions and test records
```
