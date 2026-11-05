# Skills: use proven ones before building your own

**Rule: before building anything, check this list and our own skills first.** If a skill below covers the
job, follow it. If two disagree, AGENTS.md wins, then the "AI Cafe local rules" block at the top of each
SKILL.md, then the upstream text.

Skills live in `.claude/skills/<name>/`. Each has a `SKILL.md` (the instructions) and a `SOURCE.md` (repo,
pinned commit, license, what we removed and why). Nothing here updates itself: a newer upstream version
comes in its own PR, re-read in full.

**Who uses them**
- **Claude Code** loads `.claude/skills/` automatically and picks a skill from its description.
- **Codex, Grok and other coding agents** do not load this folder by themselves. Open the skill's
  `SKILL.md` by path when the task matches a row below.
- **ChatGPT chats** cannot read the repo. Follow the plain-words rules in "Smallest code that works"
  below, and paste a SKILL.md into the chat when you need one.

## The list

| Skill | When to use | Which AI uses it | Source | License |
|---|---|---|---|---|
| `supabase` | Any Supabase work: auth, RLS, views, storage, CLI, migrations. **Local CLI and migration files only, never the live project.** | Claude Code; Codex by path | [supabase/agent-skills](https://github.com/supabase/agent-skills) `c9be0e9` | MIT |
| `supabase-postgres-best-practices` | Writing or changing tables, columns, indexes, RLS policies, functions, migrations; slow queries | Claude Code; Codex by path | [supabase/agent-skills](https://github.com/supabase/agent-skills) `c9be0e9` | MIT |
| `testing-api-security-with-owasp-top-10` | Security review of our API routes (`app/api/**`) against the OWASP API Top 10, alongside the RLS skills. Live tests on localhost with seeded test cafés only. | Claude Code; Codex by path | [mukul975/Anthropic-Cybersecurity-Skills](https://github.com/mukul975/Anthropic-Cybersecurity-Skills) `54a7988` (community, not official Anthropic) | Apache-2.0 |
| `exploiting-idor-vulnerabilities` | Checking café-to-café data isolation: every id a route or tool takes must belong to the caller's café. Localhost and seeded test cafés only. | Claude Code; Codex by path | [mukul975/Anthropic-Cybersecurity-Skills](https://github.com/mukul975/Anthropic-Cybersecurity-Skills) `54a7988` (community, not official Anthropic) | Apache-2.0 |
| `vercel-react-best-practices` | Writing or reviewing React / Next.js code for speed (waterfalls, bundle size, re-renders) | Claude Code; Codex by path | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) `1a2c79d` | MIT |
| `web-design-guidelines` | UI and accessibility review of changed screens (fixed copy of Vercel's Web Interface Guidelines) | Claude Code; Codex by path | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) `1a2c79d` + [web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines) `434b7f9` | MIT |
| `frontend-design` | Judgement on hierarchy, copy and restraint when building UI. **Stay within our design system; no redesigns unless the owner asks.** | Claude Code | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) `ca45fc4` | Apache-2.0 |
| `impeccable` | Design commands: `critique`, `audit`, `polish` (plus distill, clarify, harden, adapt). Slop detector as a checklist in `slop-rules.md`. Inside our design system only. | Claude Code; Codex by path | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) `5af4319` | Apache-2.0 |
| `diagram-design` | Plain-words data-flow diagrams (also flowchart, sequence, state, ER) for PR bodies, plans and docs. System fonts only. | Claude Code; Codex by path | [cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design) `f24d98b` | MIT |
| `playwright-cli` | Driving a browser to check a change end to end. **Localhost and seeded test cafés only.** | Claude Code; Codex by path | [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli) `f50f579` | Apache-2.0 |
| `writing-plans` | Writing the plan for a multi-step PR, after the owner agrees the plain-words plan (AGENTS.md rule 15) | Claude Code; Codex by path | [obra/superpowers](https://github.com/obra/superpowers) `22f0b46` | MIT |
| `verification-before-completion` | Before saying anything is done, fixed or passing | Claude Code; Codex by path | [obra/superpowers](https://github.com/obra/superpowers) `22f0b46` | MIT |
| `systematic-debugging` | Any bug, failing test or surprise: root cause before any fix | Claude Code; Codex by path | [obra/superpowers](https://github.com/obra/superpowers) `22f0b46` | MIT |
| `receiving-code-review` | Answering Codex or human review comments: check each one, push back with evidence, no blind fixes | Claude Code; Codex by path | [obra/superpowers](https://github.com/obra/superpowers) `22f0b46` | MIT |
| `gh-fix-ci` | A PR check is red (usually "AI CAFE PR baseline"): read the logs, reproduce, fix, re-run | Claude Code; Codex | [openai/skills](https://github.com/openai/skills/tree/main/skills/.curated) `49f948f` | Apache-2.0 |
| `gh-address-comments` | Fixing review comments on the PR for the current branch | Claude Code; Codex | [openai/skills](https://github.com/openai/skills/tree/main/skills/.curated) `49f948f` | Apache-2.0 |
| `ponytail` | Every coding task: the smallest change that fully works, reusing what exists | Claude Code; Codex by path; ChatGPT via the rules below | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) `96608e0` | MIT |
| `ponytail-review` | Reviewing one change: correct, safe, tested, lean | Claude Code; Codex by path | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) `96608e0` | MIT |
| `ponytail-audit` | Auditing a folder or the whole repo (report only) | Claude Code; Codex by path | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) `96608e0` | MIT |
| `ponytail-debt` | Listing every `shortcut:` comment and its upgrade trigger (report only) | Claude Code; Codex by path | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) `96608e0` | MIT |
| `postgres` | Index audits, query patterns, partitioning and EXPLAIN-driven tuning of our analytics queries and views. Supabase skill rules win on any conflict. | Claude Code; Codex by path | [planetscale/database-skills](https://github.com/planetscale/database-skills) `f6ed002` | MIT |
| `vitest` | Faster, less flaky unit tests: sharding, `--changed`, concurrency, fixtures. We run Vitest 5.0.2; the skill targets 5.1 beta (differences in its SOURCE.md). | Claude Code; Codex by path | [antfu/skills](https://github.com/antfu/skills) `7de210b` | MIT |
| `e2e-testing-patterns` | Writing non-flaky Playwright e2e tests (fixtures, waits, page objects). Seeded test cafés only. | Claude Code; Codex by path | [wshobson/agents](https://github.com/wshobson/agents) `7e2fb55` | MIT |
| `error-discovery` | Designing Supervisor evals: read real traces and name the failure modes in plain words (with a small local review app) | Claude Code; Codex by path | [ai-evals-course/evals-skills](https://github.com/ai-evals-course/evals-skills) `80d5f7b` | Apache-2.0 |
| `write-code-eval` | Writing a code check for a failure mode with an objective rule (numbers, tool-call shape, required text). First choice before any judge. | Claude Code; Codex by path | [ai-evals-course/evals-skills](https://github.com/ai-evals-course/evals-skills) `80d5f7b` | Apache-2.0 |
| `write-judge-prompt` | Writing a pass/fail LLM judge for one failure mode code cannot check. Offline evals only, never in the Supervisor loop. | Claude Code; Codex by path | [ai-evals-course/evals-skills](https://github.com/ai-evals-course/evals-skills) `80d5f7b` | Apache-2.0 |
| `validate-evaluator` | Checking a judge against the owner's labels before trusting it | Claude Code; Codex by path | [ai-evals-course/evals-skills](https://github.com/ai-evals-course/evals-skills) `80d5f7b` | Apache-2.0 |
| `generate-synthetic-data` | Building realistic test inputs for evals when real traces are few | Claude Code; Codex by path | [ai-evals-course/evals-skills](https://github.com/ai-evals-course/evals-skills) `80d5f7b` | Apache-2.0 |
| `eval-audit` | Checking whether our evals and golden questions can be trusted (report only) | Claude Code; Codex by path | [ai-evals-course/evals-skills](https://github.com/ai-evals-course/evals-skills) `80d5f7b` | Apache-2.0 |
| `to-tickets` | Splitting a plan into small vertical PRs with blocking edges, before a parallel wave. Tracker = `docs/plans/` files and GitHub issues; no issues without the owner's OK. | Claude Code; Codex by path; ChatGPT via the summary below | [mattpocock/skills](https://github.com/mattpocock/skills) `4ae2317` | MIT |
| `incremental-implementation` | Building in thin, verifiable slices; each slice builds and passes tests | Claude Code; Codex by path; ChatGPT via the summary below | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) `301b02b` | MIT |
| `context-engineering` | Keeping context and token use lean: load only the files a task needs, start fresh chats with a handoff | Claude Code; Codex by path | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) `301b02b` | MIT |
| `pr` | Writing every PR body: diagram, before/after evidence, merge danger | Claude Code; Codex by path; ChatGPT via the summary below | [mattpocock/skills](https://github.com/mattpocock/skills) `4ae2317` | MIT |
| `two-axis-code-review` | Reviewing a branch on two separate axes: our standards (AGENTS.md) and the agreed plan | Claude Code; Codex by path | [mattpocock/skills](https://github.com/mattpocock/skills) `4ae2317` (upstream name `code-review`) | MIT |
| `handoff` | Writing a handoff doc so a fresh chat can continue the work | Claude Code; Codex by path | [mattpocock/skills](https://github.com/mattpocock/skills) `4ae2317` | MIT |
| `gha-security-review` | Reviewing our `.github/workflows/` for injection, pwn-request and permission issues (report only) | Claude Code; Codex by path | [getsentry/skills](https://github.com/getsentry/skills) `0c464f4` | Apache-2.0 |
| `find-bugs` | Bug and security hunt on a branch diff before review (report only) | Claude Code; Codex by path | [getsentry/skills](https://github.com/getsentry/skills) `0c464f4` | Apache-2.0 |
| `skill-creator` | Writing a new AI Cafe skill (then add it to this table) | Claude Code | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/skill-creator) `ca45fc4` | Apache-2.0 |
| `graphify` | Optional: tracing how two known pieces of code connect. Not worth it for "where is X" questions (see below). | Claude Code; Codex by path | [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) `59b5ab1`, PyPI `graphifyy==0.9.102` | Apache-2.0 / MIT |

Full commit SHAs and the list of removed files are in each skill's `SOURCE.md`. Accepted licenses: MIT, Apache-2.0 and ISC; each skill folder keeps its upstream LICENSE (and NOTICE where upstream has one).

## Smallest code that works (Ponytail's core rules, in plain words)

For every AI, including ChatGPT chats that cannot load skills:

1. **Read first.** Read the task and the code it touches. List every place the change must reach:
   callers, tests, fixtures, config, exports. That is the scope. Extra features are not.
2. **Take the first option that fully works, in this order:**
   1. Does it need to exist at all? Skip features and options nobody asked for, and say so in one line.
   2. Is it already in this codebase (a helper, component, reader, calculation)? Use it the way the
      surrounding code does. This is AGENTS.md rule 4: one path per capability.
   3. Does the standard library or the platform already do it? Use that.
   4. Does an installed dependency do it? Use it. Never add a dependency for a few lines.
   5. Can it be one clear line? Then one line.
   6. Otherwise, the minimum code that works.
3. **Finish the job.** Be lazy about the solution, never about the change. Update every caller, test and
   fixture your change breaks.
4. **No "for later" code.** No abstraction, wrapper, option or config nobody asked for. Deleting beats
   adding. Keep the structure the codebase already has.
5. **Fix bugs once, at the root.** Find every caller of the function first, then fix the shared code.
6. **Risky logic gets one small test** (a branch, a parser, money, security, data writes). Trivial
   changes need none.
7. **A known shortcut gets a comment:** `shortcut: <the limit>, <when to upgrade>`.
8. **Never cut** input checks at trust boundaries, error handling that prevents data loss, security,
   accessibility, or anything the owner asked for. In AI Cafe that includes RLS, integer-cents money,
   the café's own currency, and the owner's yes before any effect.
9. **End the reply** with one or two lines: what you skipped or did not check, and any risk.

## Splitting work into PRs (to-tickets, in plain words)

1. **Slice vertically.** Each PR cuts a narrow but complete path through every layer it needs (database,
   reader, tool or API, screen, tests). Not "all the tables first, then all the screens".
2. **Each slice works on its own.** When it merges, someone can check it end to end.
3. **Each slice fits one fresh chat.** If it does not, split it.
4. **Prefactor first.** If a small cleanup makes the change easy, that cleanup is its own first PR.
5. **Write down the blockers.** Each PR lists which other PRs must merge before it can start. A PR with
   no blockers can start now. Shared pieces go in one small foundation PR that merges first
   (AGENTS.md rule 16).
6. **Wide renames are the exception.** Expand (add the new form beside the old), move callers over in
   batches (one PR each, CI stays green), then contract (delete the old form) in a last PR.
7. **The owner approves the split** before any PR starts. Plans live in `docs/plans/`; GitHub issues
   only with the owner's OK.

## Building in thin slices (incremental-implementation, in plain words)

1. **Simplest thing first.** Ask "what is the simplest thing that could work?" before writing code.
2. **One small piece at a time:** build it, test it, check it works, commit it, then the next piece.
   Never write more than about 100 lines without running the tests.
3. **One thing per step.** Do not mix a feature, a refactor and a config change in one commit.
4. **Always buildable.** After every step, `npx tsc --noEmit`, `npm run lint`, `npm test` and
   `npm run build` still pass.
5. **Stay in scope.** Do not tidy nearby code. Note what you saw ("noticed but not touching") in the PR.
6. **Unfinished work hides behind a flag** read from settings, and new behavior is off or safe by default.
7. **Easy to undo.** Prefer adding over changing; keep each step revertable.

## PR body template (pr, in plain words)

Every PR body has these three parts, plus what AGENTS.md rules 8, 13, 15 and 17 ask for (what changed,
what was deleted, what was not touched, the agreed plan, each test scenario with pass or fail, the green
CI link, and other open PRs on the same files):

1. **Summary:** the smallest picture that makes the change clear: a short data-flow diagram, a call tree,
   a file tree or a small before/after diff. Keep words short and next to the picture.
2. **Evidence:** before and after. A screenshot for screen changes; otherwise the test or command output
   that failed before and passes now, on real or seeded café data.
3. **Merge danger:**
   - **Door:** one-way (hard to undo: migrations, deletes, anything sent to an owner) or two-way (easy to
     roll back).
   - **Blast radius:** one word for what could break (for example "brief", "money screen", "none"), then
     the possible effects.

## Safety rules for all skills

- Skills never run against production, a real café's account or real owner data. Browser and security
  tests use localhost and seeded test cafés.
- Skills never push to another branch, merge, approve, or post outside the PR they were asked to work on.
- Nothing downloads code at run time. Where upstream did (Vercel guidelines, PlanetScale links, Impeccable's engine), we keep a
  fixed copy or leave the feature out. A skill command that installs a package names a pinned version and
  needs the owner's approval first.

## Graphify setup (optional)

Graphify turns the code into a graph (`graphify-out/graph.json`) using tree-sitter. Code-only use is local
and makes no model calls.

```bash
python3 -m venv /tmp/gvenv && /tmp/gvenv/bin/pip install graphifyy==0.9.102
```

```bash
env -i PATH="/tmp/gvenv/bin:$PATH" HOME="$HOME" graphify update .
```

```bash
env -i PATH="/tmp/gvenv/bin:$PATH" HOME="$HOME" graphify path "app/api/cron/daily-brief/route.ts" "briefSchedule()"
```

- The package name is `graphifyy` (two y's). Pin the version.
- `env -i` removes API keys, so it cannot send code or docs to a model. Never run `graphify install`,
  hooks, `watch`, `clone`, `add <url>`, `label`, or the `/graphify` assistant pipeline.
- `graphify-out/` is in `.gitignore`. Do not commit it: it is about 14 MB for this repo.
- It skips our SQL migrations unless the `graphifyy[sql]` extra is installed.

**Measured on this repo (Nov 5, 2026, main at `8461278`).** The build took 16 seconds (1,816 files,
9,836 nodes) and has to be redone in every fresh cloud session. Three real questions, output size as a
proxy for tokens:

| Question | Graphify | grep / read | Result |
|---|---|---|---|
| "Which code decides when the morning brief is sent, and what calls it?" (`graphify query`) | about 460 tokens, wrong files (test helpers, admin console) | about 185 tokens (`grep -rn briefSchedule`), right answer with the call line | grep wins |
| Who imports `briefSchedule.ts` (`graphify explain`) | about 480 tokens, right answer | about 185 tokens, same answer | grep wins |
| How the daily-brief cron reaches `briefSchedule()` (`graphify path`) | about 50 tokens, right 2-hop path | 2 greps, about 150 to 300 tokens | Graphify wins, slightly |

**Verdict:** no meaningful token savings here. AGENTS.md already names the key files, and grep answers
most questions for less. Graphify helps only with call-path questions between two known points, and the
build step costs more than it saves in a short session. Keep it optional.
