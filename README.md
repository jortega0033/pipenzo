# Pipenzo

Open-source Electron desktop app that turns a GitHub issue into a small, human-reviewable pull
request, built by wrapping autonomous coding agents (Claude Code, Codex) in a structured
Plan → Refine → Implement → Review pipeline. You point it at a repo, click **Implement** on an
issue, and an agent does the work — but it never pushes anything or opens a PR without you saying
so first.

No monetization plan. This is a portfolio / open-source project, built on top of
[agentdock](https://github.com/jortega0033/agentdock), an Electron + local-daemon boilerplate for
apps that drive the Claude Code and Codex CLIs.

**Status: early, actively being built.** The daemon-side pipeline logic — GitHub client, phase
machine, ticket store, refine/implement orchestration, review gates, screenshot verification, and
the publish service — is real, working, tested code. The desktop UI you'd actually see if you ran
the app today is still mostly agentdock's own demo shell; Pipenzo's kanban/ticket UI exists as
built, individually-tested components that aren't wired into the running app yet. See
[What exists today](#what-exists-today) for the honest breakdown.

## Who this is for

Developers who already pay for Claude Code or Codex, already work in GitHub issues and PRs, and
want a second pair of hands on the kind of ticket that's well-specified but tedious — not a
replacement for writing code themselves, and not aimed at someone with no git/GitHub experience
(the Plan phase's conversational issue-drafting is the one on-ramp for that, and it's still
planned, not built).

## Why this exists

Autonomous issue-to-PR agents are a crowded category and the market moved fast in 2026 — several
direct competitors (Sweep, Terragon, Roo Code) shut down, and per-agent PR-acceptance data varies
a lot by *task type*, not by diff size, which cuts against this project's own small-PRs-by-default
thesis being an obviously correct bet. Pipenzo doesn't pretend otherwise. It exists to explore the
problem properly — small PRs by construction, an honest publish gate, no fabricated metrics —
rather than to out-market that category. The full research (landscape, stack choices, model
routing, PR-size strategy, feature plan, build order, and a competitive pass against Devin,
Copilot, Cursor, OpenHands, Kiro, Jules, Codegen, and Graphite) lives in
[`docs/research-report.html`](docs/research-report.html); this README stays at product-decision
altitude and links there for the reasoning and evidence behind each one.

## How this differs from Devin, OpenHands, Codex-style agents

Devin and similar cloud-agent products run in a hosted sandbox you don't control, and the agent
itself decides when to open the PR — you review after the fact. OpenHands and most
point-an-agent-at-a-repo tools are frameworks: powerful and general-purpose, but they don't ship an
opinionated stance on diff size, review gates, or what happens when the agent is wrong. Codex/Cursor-style
CLI agents are excellent single-shot coders, but "write the code" is the whole job — there's no
separate spec step, no diff-size gate, no point in the loop where a human has to say yes before
anything leaves the machine.

Pipenzo's bet is narrower and less flashy: run on the same models everyone else uses (no
proprietary model, no hosted sandbox — it drives the Claude Code / Codex CLI you already have
installed and authenticated), and spend the actual product effort on the four things around the
model that decide whether a PR is worth a reviewer's time — refuse work that won't fit a small PR
*before* any code is written, grade the diff against what got estimated, and never let the agent
push or open a PR itself. That last one isn't a policy the agent is asked to respect, it's
architectural: `apps/daemon/src/publish-service.ts` is the only code in this repo that can call
`git push` or open a pull request, it runs daemon-side, and there's a dedicated test
(`publish-token-boundary.test.ts`) asserting the GitHub token can never reach an agent-callable
path. That property is built today, not just designed. See the research report's landscape and
competitive-positioning sections for the fuller per-competitor comparison, including where
Pipenzo's plan is genuinely ahead and where it's at parity or behind (Kiro, for one, already ships
spec-driven refinement as a GA product — Pipenzo's Refine step is a subset of that, not an advance
on it).

## How it works

**Plan → Refine → Implement → Review**

1. **Plan** *(optional entry point, planned, not built)* — no issue yet? A conversational agent
   turns a rough idea into a real GitHub issue: describe the problem in plain language, the agent
   asks clarifying questions, drafts the issue, creates it on confirmation.
2. **Refine** — a read-only subagent (`Read`/`Grep`/`Glob` only, no write tool exists in its
   definition) turns the issue into a structured spec: acceptance criteria, an explicit
   out-of-scope list, files likely touched, and a self-estimated diff size. An oversized or
   underspecified ticket stops here and asks a human, before any code is written.
3. **Implement** — a fresh session seeded with the spec, plus symbol-graph context where a
   user-configured MCP server provides one (that's an agentdock runtime capability Pipenzo
   consumes, not a Pipenzo module — it falls back to `Grep`/`Glob` when nothing's configured).
   Retries split by rung: a same-tier retry forks the session and keeps provider-native context; a
   tier escalation starts a fresh session, seeded with the spec, the prior diff, and the failing
   gate output, because agentdock freezes the selected model into a fork's continuation scope and a
   fork genuinely cannot change model.
4. **Review** — deterministic gates first (build/typecheck, spec-generated tests the implementer
   never wrote itself, gitleaks, Semgrep, a diff-scope check against the Phase-1 estimate), then an
   LLM review pass in a fresh session seeing only the spec and the diff, followed by a separate
   adversarial verifier that's never a weaker model than the implementer.

Nothing is pushed or opened as a PR without an explicit human approval step — see
[How this differs](#how-this-differs-from-devin-openhands-codex-style-agents) above and the
research report's *Autonomy & the publish gate* section. Approvals are meant to be risk-graded
(routine edits inside the owned worktree proceed on their own and are only logged; anything
irreversible or off-machine always stops for a person) — the risk classifier that grades them isn't
built yet, so today every push/PR action is gated, full stop, with no LOW/MEDIUM/HIGH distinction
in the running code.

## Small PRs, by construction

The diff-size gate runs at Refine, before any code is written, on a clean total order over changed
lines and files touched:

- ≤ 100 changed lines **and** ≤ 10 files → one PR.
- ≤ 400 changed lines **and** ≤ 20 files → a dependency-ordered stack of 2–4 PRs is required.
- anything above that, or no clean layering at any size → refuse, flag `pipenzo:needs-pre-scoping`,
  hand it to a human with the estimate and a proposed split.

Refusal is a real ticket state, not an error — the point is that "this ticket is too big" is a
legitimate, visible outcome, not something the agent silently muddles through. The estimate is also
checked against the real diff at Review: blowing it by more than 50% moves the ticket to
`pipenzo:awaiting-stack-approval` with the real numbers next to the predicted ones, rather than
silently opening an oversized PR.

Every label Pipenzo writes is `pipenzo:`-prefixed, so it can't collide with labels a real repo
already uses:

| Label | Lane | Meaning |
|---|---|---|
| `pipenzo:queued` | Queued | Accepted, not started |
| `pipenzo:working` | Working | A phase is running |
| `pipenzo:ready-for-review` | Ready for review | Gates passed, awaiting the human push gate |
| `pipenzo:needs-human` | Needs human | Parked — 3 consecutive failures, or a denied approval |
| `pipenzo:needs-pre-scoping` | Needs human | Refused at the diff-size gate |
| `pipenzo:awaiting-stack-approval` | Needs human | A decomposition, or a blown estimate, awaiting sign-off |
| `pipenzo:ci-failed` | Needs human → Ready for review once fixed | A post-merge-request check failed |
| `pipenzo:merge-conflict` | Needs human | The approved branch no longer merges cleanly |
| `pipenzo:interrupted` | Needs human | The daemon died mid-run |
| `pipenzo:schema-v1` | — | Marker: this issue is managed by a v1-schema Pipenzo |

There's deliberately no `pipenzo:done` label: a merged PR closes its issue, GitHub already tells
Pipenzo that, and the polling reconciler only ever queries open issues — a merged ticket's card
just stops appearing on the next poll. Full label/lane/state reasoning is in the research report's
*Small PRs, by construction* section.

## What exists today

**Built and tested (daemon side).** `apps/daemon/src/github-client.ts` is a real `@octokit/core`
client (issue/label CRUD, PR metadata, check runs), authenticated today with a PAT read from a
single env var (`PIPENZO_GITHUB_TOKEN`, single-repo pin via `PIPENZO_GITHUB_REPO`) — that's a
stated walking-skeleton simplification, not the finished auth story; OAuth device-flow and the
Electron-main token vault come later. The phase machine reads and writes real `pipenzo:` labels,
with labels authoritative for a ticket's lane. The ticket store persists to disk with atomic
writes. The publish service is real — `execFile('git', …)` for the push, an Octokit call for the
PR — behind its own route, with the token-boundary test described above. Refine, Implement
orchestration, the deterministic review gates, screenshot verification (a schema-validated capture
manifest the daemon executes, never agent-authored code), and spec-test adjudication are all
implemented with their own test suites.

**Designed, not wired in yet.**
- **The kanban/ticket desktop UI.** The components exist under `apps/desktop/src/pipenzo/`
  (implement dialog, diff review, publish actions, screenshot evidence, the deterministic-gates
  panel — each individually tested), but the app's actual render tree still shows agentdock's
  inherited demo UI (provider panel, MCP panel, worktree panel, activity timeline). If you run
  `pnpm dev:desktop` today, that's what you'll see, not Pipenzo's board. The clickable prototype
  under [`design/`](#design) is the accurate preview of the finished product.
- **GitHub OAuth device-flow and the token vault** — today it's a PAT via env var, as above.
- **The risk classifier** (`risk-classifier.ts` doesn't exist yet) — so risk-graded approval, the
  cumulative-risk strip, and pre-commitment records aren't built either.
- **Bounded concurrency/queue, `gh stack` publishing, CI-failure auto-fix, GitLab/Jira adapters,
  the humanizing prose pass.**
- **Product branding.** The app is still packaged and named "AgentDock" throughout
  (`package.json`'s `agent-dock`, `electron-builder.yml`'s `AgentDock` app id/product name) —
  renaming to Pipenzo is pending.

## Model routing

A **routing class** (`refine` / `implement-small` / `implement-standard` / `implement-hard` /
`review` / `verify`) maps to a **model tier** (cheap / mid / frontier). The adversarial verifier is
never a weaker tier than the implementer it's checking; retries escalate tier before they escalate
to a human, with a capped number of attempts throughout. Deterministic overrides force the frontier
tier regardless of the estimate: any prior failed attempt, paths matching security/auth/migration
globs, a `priority:high`/`breaking` label, or more than 8 files *and* more than 100 lines touched.
Full routing-class table and the reasoning behind the reviewer/verifier tier asymmetry is in the
research report's *Model routing* section.

## Requirements

Pipenzo brings no models and no inference credits of its own — it runs models through agentdock,
which drives the Claude Code and Codex CLIs as local subprocesses under your own authentication:

- At least one authenticated provider: a Claude Pro/Max subscription (Claude Code CLI), a ChatGPT
  Plus/Pro subscription (Codex CLI), or API keys for either. Pipenzo never sees or stores these
  credentials.
- Git, on `PATH`.
- A GitHub account with write access to the repos it manages.
- Optionally, the repo's own Playwright for screenshot verification, and a symbol-graph MCP server
  for better Implement-phase localization. Both are capability-detected and degrade to a stated
  reduced mode rather than erroring.

## Quick Start

```bash
git clone https://github.com/jortega0033/pipenzo.git
cd pipenzo
pnpm install      # runs scripts/preflight.mjs first, fails fast with a fix if Node/pnpm don't match
pnpm typecheck
pnpm test
```

Needs Node 22.x and the exact pnpm version pinned in the root `package.json`'s
`packageManager` field (`pnpm@10.29.2` as of this writing). If the preflight check fails on the
pnpm version:

```bash
corepack enable
corepack prepare pnpm@10.29.2 --activate
pnpm install
```

If Corepack itself isn't available (some newer Node releases no longer bundle it):

```bash
npm install -g corepack
corepack enable
```

or skip Corepack entirely: `npm install -g pnpm@10`.

To run something:

```bash
pnpm dev:daemon    # daemon only, tsx watch, auto-restart on change
pnpm dev:desktop   # full desktop app — spawns the daemon automatically
```

Remember what you'll actually see: the desktop app is agentdock's own demo shell today, not
Pipenzo's kanban board (see [What exists today](#what-exists-today)). To see what the finished
product is meant to look like, open [`design/pipenzo-prototype.html`](design/pipenzo-prototype.html)
directly in a browser — no server needed.

## Design

A clickable design canvas covers the product's key screens: kanban home, live ticket progress,
inline approval, a reviewer-grade diff view, and a plain-language "Simple mode" for non-developer
users. Dark-mode only for now.

- [`design/pipenzo-prototype.html`](design/pipenzo-prototype.html) — the full seeded canvas, open
  directly in a browser
- [`design/artboards/`](design/artboards/) — the individual screens as editable `.dc.html` source
  (`Foundations`, `Main`, `TicketDetail`, `ApprovalPrompt`, `DiffReview`, `SimpleMode`, `Connect`,
  `Activity`, `Models`, `Settings`)
- [`design/canvas.json`](design/canvas.json) — canvas layout manifest

## Stack

| Concern | Choice | Why (short version) |
|---|---|---|
| UI components | shadcn/ui + Tailwind v4 | Component source you own, not a black-box library |
| Kanban board | dnd-kit | Standard pairing with shadcn; shadcn has no kanban primitive |
| Diff review | react-diff-view | Parses real unified diffs; tens of kB, not Monaco |
| GitHub API client | `@octokit/core` + `paginate-rest` | Pure JS, tree-shaken into the daemon bundle — never the `gh` binary |
| Stacked PRs | `gh stack` (optional, runtime-detected) | The one place `gh` is used, and only for stack maintenance GitHub now does natively |
| Screenshot verification | the repo's own Playwright, driven by the daemon from an agent-proposed **capture manifest** | The agent proposes a schema-validated manifest, never executable code; the daemon makes every Playwright call |
| GitHub auth | PAT via env var today; `@octokit/auth-oauth-device` planned | See [What exists today](#what-exists-today) |
| Git operations | `execFile('git', …)` | Argv array, `shell:false`, sanitized env — same trust model as agentdock's worktree manager |
| Ticket/queue store | JSON file store | Matches agentdock's `FileSessionStore` pattern; no native-addon DB needed |

Full rationale for each choice, plus the GitHub rate-limit strategy and OAuth-scope discussion, is
in [`docs/research-report.html`](docs/research-report.html)'s *The stack* section.

## Team usage, briefly

Pipenzo is one desktop app per developer, not a shared server — there's no backend, so "does this
work for a team on one repo" needed real answers, not just an assumption:

- **Ticket sync across teammates is polling, not push.** The state model is GitHub labels, a real
  shared resource on GitHub's own servers; each Pipenzo instance polls for changes rather than
  getting pushed them.
- **Two people clicking Implement on the same ticket** is handled with a best-effort claim (GitHub
  issue assignment, re-checked uncached immediately before dispatch) — not a mutex. GitHub has no
  compare-and-swap on labels/assignees, so the rare true race is possible; when it happens, the
  loser finds the issue already assigned on its next poll and parks with "claimed by
  @someone-else" instead of silently diverging.
- **GitHub labels are authoritative for a ticket's lane**; the local JSON ticket store holds
  everything GitHub can't (worktree path, session lineage, budget, risk score). When they disagree,
  the label wins and the divergence is logged.
- **Every concurrent ticket gets its own worktree and branch** — never shared — with cleanup wired
  to every terminal state (merged, closed, abandoned, superseded).

Full FAQ-style writeup (including why a local loopback server doesn't solve cross-teammate push,
and what a future hosted relay would look like) previously lived only in this README; it's a
candidate for a dedicated doc if it grows further.

## Build order

1. Design system, before any screen.
2. Walking skeleton — hardcoded repo, PAT from env, no queue. One ticket through
   refine → implement → review → diff screen → open PR, end to end.
3. Ticket store + phase machine over labels, plus crash recovery for both stores. **← roughly here
   today** (see [What exists today](#what-exists-today)).
4. GitHub OAuth + the token vault, properly, plus the diff-size gate enforced at refine.
5. Queue + dual-audience mode — kanban UI wired up, bounded concurrency.
6. Polish — notifications, the risk classifier, terminal-state worktree cleanup, an audit entry for
   every publish and gate result.
7. First post-MVP milestone — `gh stack` publishing, then CI-failure auto-fix.

Full step-by-step detail, including what "properly" means at each step and the two real agentdock
gaps this build order surfaced, is in the research report's *Build order* section.

## Testing — Pipenzo's own code

Vitest, matching agentdock's existing layout. See
[CONTRIBUTING.md](CONTRIBUTING.md#before-opening-a-pr) for the exact commands expected to pass
before a PR, and [DEVELOPMENT.md](DEVELOPMENT.md#testing-without-paid-providers) for how this
project tests provider adapters without a real, paid Claude/Codex CLI in CI.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, and
[DEVELOPMENT.md](DEVELOPMENT.md) for an "I want to change X, start here" map. Given the current
state above, the highest-leverage contributions right now are wiring the existing
`apps/desktop/src/pipenzo/*` components into the app's render tree, and GitHub OAuth device-flow —
both are scoped, both are things this README can now point at honestly instead of pretending
they're already done.

## Naming

Named after the product owner's two kids — decided over every researched alternative on that basis
alone.

## License

[Apache-2.0](LICENSE) — matching agentdock, the foundation this is built on and the source of the
packaging, worktree, and session machinery (merged in directly, see *Relationship to agentdock*
below). The UI dependencies (shadcn/ui, dnd-kit, react-diff-view) are MIT, compatible either way.

## Relationship to agentdock

This repo's application code (`apps/`, `packages/`) started as agentdock's codebase, merged in with
full git history via `git remote add upstream-agentdock` + `git merge --allow-unrelated-histories`,
not a copy-paste — `git fetch upstream-agentdock` still pulls in upstream fixes, including three
real gaps found and filed against agentdock while building this plan:
[agentdock#116](https://github.com/jortega0033/agentdock/issues/116) (a discarded rate-limit
event), [#117](https://github.com/jortega0033/agentdock/issues/117) (worktree cleanup refuses on
any untracked file, never deletes the branch), and
[#118](https://github.com/jortega0033/agentdock/issues/118) (concurrent worktree creation throws
instead of queuing) — all three matter directly to Pipenzo's own build order.

agentdock's own README is preserved at
[`docs/agentdock-upstream-README.md`](docs/agentdock-upstream-README.md) for reference rather than
duplicated here.

## Everyday commands (inherited from agentdock)

```bash
pnpm build             # compile every package and application
pnpm typecheck         # strict TypeScript across the workspace
pnpm test              # unit + integration tests; no real provider calls
pnpm lint              # ESLint
pnpm package:win       # Windows NSIS installer
```

Full setup, architecture, provider-transport details, and the rest of agentdock's own docs live in
[`docs/agentdock-upstream-README.md`](docs/agentdock-upstream-README.md) and the `docs/*.md` files
carried over with it (`architecture.md`, `daemon.md`, `providers.md`, `protocol-v1.md`,
`protocol-v2.md`, `client-sdk.md`, `packaging.md`, `troubleshooting.md`) — not duplicated here
since they describe the inherited runtime, not Pipenzo's own product decisions.
