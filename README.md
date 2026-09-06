# Pipenzo

Open-source Electron desktop app that turns a GitHub issue into an agent-implemented, human-approved pull request. Point it at a repo, click **Implement** on an issue, and an autonomous agent loop (refine → implement → review) does the work — landing as a small, reviewable PR, never pushed without your say-so.

No monetization plan. This is a portfolio / open-source project, built on the same foundations as [agentdock](https://github.com/jortega0033/agentdock).

Status: pre-implementation. This repo currently holds the product research, architecture decisions, and a clickable design canvas — no app code yet.

## Why this exists, and why it's honest about its limits

Autonomous issue-to-PR agents are a crowded category, and the market moved fast in 2026. Updated PR-acceptance data (7,156 agent PRs, MSR 2026 mining challenge, [arXiv 2602.08915](https://arxiv.org/html/2602.08915v2)) puts per-agent merge rates at Codex 77.9%, Cursor 74.5%, Claude Code 71.9%, Copilot 68.0%, Devin 61.6% — the earlier 55%/82.6% figure is retired. Acceptance varies by *task type* (chore 84.0%, docs 82.1%, feature 66.1%, perf 55.4%), not by diff size — Pipenzo's small-PRs-by-construction thesis is intuitive but not yet established by evidence; several direct competitors (Sweep, Terragon, Roo Code) shut down anyway, and Bloop's Vibe Kanban is now community-maintained. Pipenzo doesn't pretend otherwise — it exists to explore the problem properly (small PRs by construction, honest review gates, no fabricated evidence) rather than to out-market that category. See [`docs/research-report.html`](docs/research-report.html) for the original research (landscape, stack choices, model routing, PR-size strategy, feature plan, build order) and its **Competitive positioning addendum** for the September 2026 competitive pass against shipped competitors (Devin, Copilot, Cursor, OpenHands, Kiro, Jules, Codegen, Graphite) and the nine decisions taken from it.

## How it works

**Plan → Refine → Implement → Review**

1. **Plan** *(optional entry point)* — no issue yet? A conversational agent turns a rough idea into a real GitHub issue: describe the problem in plain language, the agent asks clarifying questions, drafts the issue, creates it on confirmation. This is also the on-ramp for non-developers who've never written an issue.
2. **Refine** — a read-only subagent (`Read`/`Grep`/`Glob` only, cannot write) turns the issue into a structured spec: acceptance criteria in EARS notation, an explicit out-of-scope list, files likely touched, and a self-estimated diff size. Missing info or an oversized ticket stops here and asks a human, while it's still cheap.
3. **Implement** — a fresh session seeded only with the spec plus symbol-graph context (not raw file search). Retries use `session.fork` to keep spec context and audit lineage intact, never a brand-new run.
4. **Review** — deterministic gates first (build/typecheck, spec-generated tests the implementer never wrote itself, gitleaks, Semgrep, a diff-scope check against the Phase-1 estimate). Only then an LLM review pass in a fresh session seeing just the spec and the diff, followed by a separate adversarial verifier — always at the same model tier or higher than the implementer, never a weaker model reviewing a stronger one.

Nothing is pushed or opened as a PR without an explicit human approval step — see **Autonomy & the publish gate** in the research report. Approvals are risk-graded rather than uniform: routine edits inside the owned worktree proceed on their own and are only logged, while anything irreversible or off-machine always stops for a person. Publishing is permanently in the second category — no auto-allow exists for it at any risk level.

## Model routing

Task tiers (`refine` / `implement-small` / `implement-standard` / `implement-hard` / `review` / `verify`) route to different model strengths, with a hard rule: the adversarial verifier is never a weaker tier than the implementer it's checking, and cross-vendor review is used only as a tiebreaker among equal tiers. Retries escalate tier before they escalate to a human, capped attempts throughout — no unbounded retry loop.

## Small PRs, by construction

- ≤ 100 lines / ≤ 10 files → implement as one PR.
- 100–400 lines, layered → refuse to start until the agent has written down a dependency-ordered stack of 2–4 independently-buildable PRs.
- \> 500 additions, > 20 files, or no clean layering → don't implement; flag `pipenzo:needs-pre-scoping`, post the estimate and proposed split as a comment, hand it to a human.

This gate runs at Refine, before any code is written.

**Refusal is a ticket state, not an error.** The gate produces two real states, both backed by GitHub labels and both landing in the existing *Needs human* lane:

- `pipenzo:needs-pre-scoping` — the agent declined the ticket. The card shows the estimate, which threshold tripped, and the proposed split, presented as a finished outcome rather than a failure. Nothing retries it automatically.
- `pipenzo:awaiting-stack-approval` — the agent produced a 2–4 PR decomposition and is waiting for a human to accept, reorder, or reject it. Approving materialises one dependency-ordered child ticket per entry, each with its own worktree and branch; the parent becomes a container card showing 1/3, 2/3 progress.

**Stack maintenance is GitHub's job, not Pipenzo's.** Pipenzo owns the split decision, the ordering, and the human approval of it. GitHub owns base-branch rewriting, restacking after a merge, and the PR-to-PR relationship view — via native stacked PRs (public preview, Jul 2026) and the `gh stack` CLI, invoked from the daemon-side publish service under the same `execFile` trust model as `git`, never as an agent tool. `gh` stays an optional, runtime-detected capability, not a dependency of the core loop (the GitHub API client remains `@octokit/core`). Without it, an approved stack still ships — as dependency-ordered sequential PRs with an explicit base-branch note. Pipenzo never builds its own restacker.

## Feature plan (from the research report)

**MVP**
- Kanban home: Queued / Working / Ready-for-review / Needs-human lanes, backed by GitHub labels as the state model (survives app restart, no separate source of truth). **Cross-device/cross-teammate sync is polling, not push** — see *Team usage* below.
- Implement dialog with optional prompt + branch override — never a bare button
- Plan phase / "New from idea" conversational issue creation
- Agent-state enum with an OS notification exactly on "awaiting input" — which now means a HIGH-risk approval, a refusal, or a stack awaiting sign-off, never a routine MEDIUM card that resolves in a few seconds
- **Risk-graded approval (LOW / MEDIUM / HIGH)** — LOW auto-proceeds with a passive line in the activity stream; MEDIUM blocks on a compact inline card; HIGH gets the full approval card plus an OS notification. Reject-reason field on every card that blocks. Replaces the earlier flat "one approve/reject card for everything" model.
- **Cumulative-risk strip, per ticket** — unreviewed LOW actions and mispredictions accumulate; crossing the threshold promotes the *next* MEDIUM action to a full HIGH card and says why ("14 low-risk actions since your last look")
- Separate "Push branch" / "Push & open PR" buttons
- Verification-evidence block in the PR body and in the diff view, split into two visually distinct zones — machine-verified deterministic gates vs. agent-captured self-reported evidence, never merged into one list
  - **Pre-commitment records** — before every MEDIUM/HIGH action the implementer posts what it is about to run, what it expects to happen, and what it will do if wrong; the real outcome is appended and diffed against the prediction. Mismatches are counted, never auto-collapsed, and feed both the cumulative-risk strip and the confidence line on the PR body
  - **Screenshot verification, capability-detected** — uses the repo's own Playwright (or a configured capture command), captured by the daemon and never by the agent's own browser access; before/after pair against the base commit; the hero evidence in Simple mode; carries a fixed provenance line and can never satisfy a gate
- Subscription-headroom rail — not a fake dollar figure
- Per-ticket token/run budget (0 = unlimited)
- Classified retry — never auto-retries a denied approval
- Park after 3 consecutive failures → the Needs-human lane
- Diff-size gate at refine, with refusal and stack approval as real ticket states (see above)
- Simple mode by default, expert mode persisted per user
- **Worktree cleanup on every terminal state** (PR merged, PR closed without merge, ticket abandoned, stack child superseded) — calls agentdock's existing `worktrees.cleanup(id)` / `POST /v2/worktrees/cleanup`, already built and already exposed, just never wired to anything Pipenzo-specific yet. One worktree per ticket without a teardown path is an unbounded disk leak by construction; this closes it from day one rather than as later polish.

**Near-term post-MVP** — committed, with the trigger that unblocks each
- **Bounded concurrency** *(trigger: build step 5, the queue)* — a configurable execution limit, default 2, hard cap 4, one worktree per ticket. Two tickets whose Refine-phase "files likely touched" lists overlap are serialised rather than run together, which is a decomposition Pipenzo already has for free and Devin's sandbox model doesn't.
- **`gh stack` publishing** *(trigger: after the publish service ships, build step 4)* — upgrades approved stacks from sequential PRs to real GitHub-native stacked PRs
- **CI-failure auto-fix** *(trigger: after the publish gate and one real PR-open flow work end to end)* — a failing check moves the ticket to a `ci-failed` state; the fix runs as a `session.fork` of the original implement session to keep spec lineage; one attempt only, only for failures the deterministic gate set can classify (build/typecheck/test/lint), everything else parks to Needs-human. The fix commit goes back through the same human push gate — unlike Jules, it is never resubmitted automatically
- **GitLab as a second code host** *(trigger: after the GitHub loop — Refine through Review through publish — is proven end to end)* — GitLab's issues/MRs/labels map closely enough onto Pipenzo's existing GitHub model (issue → label-state → MR in place of PR) that this is a second adapter behind the same `GitHubClient`-shaped interface, not a redesign. OAuth device flow is analogous. No `gh stack`-equivalent exists yet, so GitLab tickets fall back to the sequential-PR stack path permanently, not just until a native feature ships.
- **Jira as a ticket source, not a second code host** *(trigger: same as GitLab)* — Jira has no git hosting of its own; teams that file work in Jira still ship code through GitHub or GitLab. So this is a narrower adapter than GitLab: read/write Jira issue status to mirror Pipenzo's label-state model, keep the actual branch/PR/MR flow on whichever code host the repo already uses. Scoping it as "GitHub or GitLab, optionally mirrored to Jira" instead of "replace GitHub with Jira" avoids inventing a git-hosting story Jira doesn't have.
- Reviewer-grade diff layout with a findings sidebar by severity
- Plan-review gate before implementation starts
- Steer mid-run; Stop preserves commits
- Remaining PR-event reactions (merge conflict, review comments)
- Local, human-gated lesson memory

**Out of scope — decided, not deferred**
- **A persistent, queryable repo knowledge base** (DeepWiki / Amp's Librarian). The measured win — symbol-graph localisation, +12.2% accuracy and −53.9% completion time — comes from a *fresh* per-session graph, which cannot go stale. A durable index needs invalidation, an embedding store, and a staleness story, and its failure mode is an implementer confidently misled by an out-of-date wiki. That is a worse outcome than no wiki, for infrastructure this project deliberately doesn't have (JSON file store, no DB, no native addons). The human-gated lesson memory above is the deliberate small substitute.
- **Pipenzo-shipped MCP servers.** MCP already exists one layer down: agentdock ships a trusted local-stdio MCP catalog with a route-level approval gate and fail-closed destructive-tool classification, so any server a user wants is configured at the runtime and inherited — Pipenzo adds no MCP UI of its own. Jules' servers (Linear, Neon, Stitch) are hosted/HTTP, a transport agentdock explicitly doesn't support. And the one integration that matters here, GitHub, must *not* go through MCP: that would put the token inside the agent process and break the property the whole design rests on — publishing is a daemon-side service the agent cannot call.
- **Matching Devin's 10+ parallel sandboxes.** Bounded local concurrency above is the honest ceiling for a single machine sharing one subscription's rate limit. Cloud sandbox fleets are a funded-product feature, not a missing one.
- **A home-grown PR-stack maintenance UI.** Deferring to `gh stack` is the decision, not a placeholder for building one later.

## What the September 2026 competitive pass changed

A deep-research pass against shipped competitors (Devin, GitHub Copilot, Cursor, OpenHands, Kiro, Jules, Codegen, Graphite) found the plan ahead on a few points (refusal-as-outcome at the diff gate, the same-or-higher-tier adversarial verifier rule, per-ticket budget, dual-audience mode) and at parity or behind on others (approval gating is now table stakes; Kiro already ships EARS spec-driven dev + property-based verification, so the Refine step is a subset of Kiro's, not ahead of it; the market moved toward dollar-quota cost display, away from abstract headroom). Full writeup: **Competitive positioning addendum** in [`docs/research-report.html`](docs/research-report.html).

Nine items came out of it. All nine are now decided and folded into the feature plan above — none are left open.

**In for MVP.** Diff-gate repositioning (refusal and stack approval as real ticket states), pre-commitment records, screenshot verification, and risk-graded approval with a cumulative-risk strip.

**In, near-term post-MVP, with a trigger.** Bounded concurrency (build step 5), `gh stack` publishing (after the publish service), CI-failure auto-fix (after the publish gate and one real PR flow).

**Out of scope, with a reason.** A persistent repo knowledge base and Pipenzo-shipped MCP servers — see the reasoning under *Out of scope* above. The short version: the knowledge base trades a staleness bug for a caching win the fresh symbol graph already delivers, and MCP is a runtime-layer capability Pipenzo inherits rather than a product surface it should own.

**The Kiro reconciliation is a docs fix, and this is it.** Pipenzo does not claim EARS-notation spec-driven refinement as a differentiator — Kiro has shipped requirements/design/tasks specs with property-based verification as a GA AWS product since May 2026, and the Refine step is a subset of that, not an advance on it. What is actually additive here is narrower and worth stating plainly: the refine subagent is **read-only by construction** (`Read`/`Grep`/`Glob`, no write tool exists in its definition, so it cannot start implementing while it is still deciding whether the ticket is even sane), and it emits a **numeric diff-size estimate that a refusal policy is enforced against**. Those two things, not the notation.

## Team usage — three questions, resolved

Pipenzo is one desktop app per developer, not a shared server — these three came up as "what happens when more than one person touches the same repo" and needed real answers before the plan could call itself team-ready.

**Does moving a ticket sync across teammates' boards?** Eventually, not instantly — **decided: polling, for MVP and for the foreseeable future.** The state model is GitHub labels — a real shared resource on GitHub's servers, not a local file — so if Jake moves `ticket-123` from Queued to Working, that's a label change on the actual GitHub issue. John's Pipenzo instance sees it the next time it polls the GitHub API for that repo's issues (default interval: 30–60s while the app is open, plus a manual refresh action), not immediately. This is eventual consistency on a shared source of truth, not real-time collaboration — closer to two people refreshing the same GitHub issues page than to Figma-style live cursors.

The obvious-looking alternative — "just run a local server, desktop apps do this for OAuth callbacks all the time" — doesn't transfer, and it's worth spelling out why. A callback listener is reachable from *your own browser on the same machine*: the redirect is local, inbound-to-yourself. Cross-teammate sync needs the opposite direction — Jake's machine (or GitHub) reaching John's machine — and a plain local server behind a home router or corporate NAT isn't reachable by anyone else without port-forwarding or a tunnel. (This is also, concretely, why Pipenzo's own GitHub auth uses device-flow OAuth instead of a loopback listener in the first place — see the Stack table.) The real way to get push instead of poll is a GitHub webhook firing into a small hosted relay that fans out to connected desktop apps over a websocket — technically correct, but it's a piece of infrastructure someone has to run and pay for indefinitely, which contradicts the single-machine/no-backend/no-monetization shape of this project. Considered and explicitly deferred, not ruled out forever: if Pipenzo ever gets real multi-seat usage on one repo, a thin relay is the next thing to build, and everything else in the architecture (labels as state, no separate DB) still works unchanged underneath it.

**What happens on disk with two tickets running at once?** Always two fully separate worktrees and branches — never one branch shared by two tickets, which would defeat the isolation the whole design depends on. `ticket-123` and `ticket-456` running together means branches `issue-123` and `issue-456`, each in its own worktree under agentdock's existing `OwnedWorktreeManager`, exactly as the Working-lane mockup already shows. The gap this question actually surfaced was cleanup: one worktree per ticket, running for months, with no teardown, is a disk leak by construction. agentdock already has the fix built — `worktrees.cleanup(id)` behind `POST /v2/worktrees/cleanup` — it just wasn't wired to any Pipenzo-specific lifecycle event yet. It is now, in the MVP feature list above: fired on every ticket terminal state (PR merged, PR closed unmerged, ticket abandoned, a stack child superseded by a rebase).

**What about Jira and GitLab?** MVP stays GitHub-only, on purpose — the stack decisions already committed (`@octokit/core`, `gh stack`, device-flow OAuth, labels-as-state) are GitHub-native by design, and generalizing the core loop before it's proven once would dilute all of them at once. Both are real near-term additions, not permanently declined, and they're different shapes of addition: GitLab is a second **code host** (issues/MRs/labels are close enough to GitHub's model to sit behind the same client interface), Jira is a **ticket source** layered on top of whichever code host the repo already uses, since Jira has no git hosting of its own to replace GitHub or GitLab with. See the Near-term post-MVP list above for both.

## Stack

| Concern | Choice | Why |
|---|---|---|
| UI components | shadcn/ui + Tailwind v4 | Component source you own and restructure per audience; coexists with a screen-by-screen migration |
| Kanban board | dnd-kit | Standard pairing with shadcn; shadcn has no kanban primitive |
| Diff review | react-diff-view | Parses real unified diffs into collapsible hunks — tens of kB, not Monaco's multi-MB editor |
| GitHub API client | `@octokit/core` + `paginate-rest` | Not the octokit metapackage, not the `gh` binary — pure JS, tree-shaken into the daemon bundle |
| Stacked PRs | `gh stack` (optional, runtime-detected) | The one place the `gh` binary is used, and only for stack maintenance GitHub now does natively; absent, approved stacks ship as sequential PRs |
| Screenshot verification | the repo's own Playwright, or a configured capture command | Pipenzo ships no browser and never renders the target app in its own webview — that would put an untrusted page next to the token vault |
| GitHub OAuth | `@octokit/auth-oauth-device` | Device flow — no client secret to embed in a shipped OSS binary, no loopback listener |
| Git operations | `execFile('git', …)` | Same trust model as agentdock's worktree manager — argv array, `shell:false`, sanitized env |
| Notifications | Electron `Notification` API | Native, cross-platform, already solves this |
| Ticket/queue store | JSON file store | Matches agentdock's `FileSessionStore` pattern; no native-addon DB needed for hundreds of rows |

Full rationale for each choice is in the research report.

## Design

A clickable Claude Design canvas covers the product's key screens: kanban home (sidebar + main-content admin layout), live ticket progress with phase stepper and model-routing/budget rail, inline approval, a reviewer-grade diff view, and a plain-language "Simple mode" view for non-developer users. Dark-mode only for now — light mode is a stated roadmap item, not built yet.

The canvas has been updated to match the decisions above — risk grading, pre-commitment pairs, the two-zone evidence block, the refusal/stack-approval states, and screenshot evidence are all in it, plus a WCAG AA contrast/focus-state pass. It does not yet reflect the three team-usage decisions in the section above (worktree cleanup and multi-provider support have no UI surface of their own to add yet; the sync behavior is a backend property, not a screen).

- [`design/pipenzo-prototype.html`](design/pipenzo-prototype.html) — the full seeded canvas, open directly in a browser
- [`design/artboards/`](design/artboards/) — the individual screens as editable `.dc.html` source (`Foundations` = design-system/primitives reference; `Main`, `TicketDetail`, `ApprovalPrompt`, `DiffReview`, `SimpleMode` = product screens)
- [`design/canvas.json`](design/canvas.json) — canvas layout manifest
- Icons: [Phosphor Icons](https://phosphoricons.com/) (regular weight), inlined as SVG
- Typography: IBM Plex Sans + IBM Plex Mono

## Build order

1. Design system, before any screen — shadcn/ui primitives, tokens, branding. Everything else builds against this.
2. Walking skeleton — hardcoded repo, PAT from env, no queue. One ticket through refine → implement → review → diff screen → open PR, end to end.
3. Ticket store + phase machine — JSON-file persistence, crash recovery, phase-change SSE, a real ticket detail view.
4. GitHub & the size gate, properly — device-flow OAuth in Electron main, token vault, real issue list, the diff-size/split gate enforced at refine, a test asserting the token never reaches a provider subprocess.
5. Queue + dual-audience mode — dnd-kit kanban, simple/expert toggle with a persisted default, one worktree per ticket, and bounded concurrency (default 2, cap 4) with overlapping-file tickets serialised.
6. Polish — native "awaiting approval" notification on HIGH-risk cards only, rejection loop that forks implementation again, dirty-worktree discard path, terminal-state worktree cleanup wired to agentdock's existing `worktrees.cleanup(id)`, an audit entry for every publish and review-gate result.
7. First post-MVP milestone — `gh stack` publishing for approved stacks, then CI-failure auto-fix routed back through the same human push gate.

**Biggest risk called out in the research:** the temptation in step 2 to let the agent shell out to `gh` directly. Publishing stays outside the agent loop from the first commit — retrofitting that boundary later breaks the safety property the whole design depends on.

## Naming

Named after the product owner's two kids — decided over every researched alternative on that basis alone.

## License

TBD (open source).
