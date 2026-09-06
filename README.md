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
3. **Implement** — a fresh session seeded only with the spec plus symbol-graph context where it is available. That context is **not a Pipenzo module**: it comes from a user-configured stdio MCP server, inherited from agentdock's runtime exactly like any other server (see decision 09 under *Out of scope*). When none is configured, Implement falls back to `Grep`/`Glob`, and the localisation benefit cited below (+12.2% accuracy, −53.9% completion time) is not guaranteed in that configuration — the honest statement is that Pipenzo can consume a symbol graph, not that it ships one.
   **Retries split by rung, and the split is real, not cosmetic.** A *same-tier* retry is a `session.fork` — it keeps spec context, provider-native continuity, and audit lineage intact. A *tier escalation* is a **fresh session**, because agentdock freezes `selectedModel` into a fork's continuation scope (`packages/shared/src/protocol-v2.ts`, enforced in `apps/daemon/src/v2-session-facade.ts` — a mismatched model on a continuation is rejected as `continuation_scope_mismatch`), so a fork *cannot* change model. The escalated session is seeded with the spec, the prior attempt's diff, and the failing gate output. Provider-native context is lost at that rung — stated plainly rather than papered over — and lineage is preserved through the ticket store's `attempts[]` list, not the provider thread.
4. **Review** — deterministic gates first (build/typecheck, spec-generated tests the implementer never wrote itself, gitleaks, Semgrep, a diff-scope check against the Phase-1 estimate). Only then an LLM review pass in a fresh session seeing just the spec and the diff, followed by a separate adversarial verifier — always at the same model tier or higher than the implementer, never a weaker model reviewing a stronger one.
   Two rules keep the spec-generated test gate honest. **A failing spec-generated test is not automatically the code's fault.** It is adjudicated once, by the verifier tier, into *test-wrong* or *code-wrong*; a test ruled invalid is dropped with the ruling recorded in the evidence block, never silently deleted, and the drop is visible in the PR body. **The diff-scope check measures implementation files only** — generated tests are counted and reported separately, so a large generated test file can never blow a ticket's size estimate on its own.

Nothing is pushed or opened as a PR without an explicit human approval step — see **Autonomy & the publish gate** in the research report. Approvals are risk-graded rather than uniform: routine edits inside the owned worktree proceed on their own and are only logged, while anything irreversible or off-machine always stops for a person. Publishing is permanently in the second category — no auto-allow exists for it at any risk level.

## Model routing

Two words that used to mean the same thing here now don't, deliberately: a **routing class** is a phase of work (`refine` / `implement-small` / `implement-standard` / `implement-hard` / `review` / `verify`), a **model tier** is a model's strength (cheap / mid / frontier). Routing classes map to model tiers; the kanban *lanes* are a third, unrelated thing.

Each routing class picks a model tier, with a hard rule: the adversarial verifier is never a weaker model tier than the implementer it's checking, and cross-vendor review is used only as a tiebreaker among equal tiers. Retries escalate the model tier before they escalate to a human, capped attempts throughout — no unbounded retry loop. **Escalation costs the provider thread** — see step 3 above: same-tier retries fork, tier escalations start a fresh session because a fork's model is frozen.

**Why the reviewer is exempt from the same-or-higher rule and the verifier isn't.** The reviewer is advisory — its findings feed the implement retry, they are not a gate — so it may run below the implementer's tier. The verifier is the actual gate and never may. The cross-tier regression evidence (a weaker model reviewing a stronger one produced 3 fixes against 13 new bugs) is about *gating* review; advisory findings that a same-or-higher-tier verifier subsequently adjudicates carry no such risk.

Deterministic overrides force the frontier tier before the estimate is consulted: any prior failed attempt, paths matching security/auth/migration globs, a `priority:high`/`breaking` label, or **more than 8 files touched *and* more than 100 lines**. The file-count half is conjunctive on purpose — a bare `>8 files` override would have contradicted the `≤ 10 files` single-PR allowance below and forced the frontier tier on tickets the size gate calls small.

## Small PRs, by construction

The thresholds are a **clean total order on one unit** — no gaps, no overlapping rows, no lines-vs-additions ambiguity. The unit is *changed lines* (additions + deletions) and *files touched*, and whichever of the two is worse decides the row:

- ≤ 100 changed lines **and** ≤ 10 files → implement as one PR.
- ≤ 400 changed lines **and** ≤ 20 files → a dependency-ordered stack of 2–4 independently-buildable PRs is **required**; refuse to start until the agent has written one down.
- anything above that, or no clean layering at any size → don't implement; flag `pipenzo:needs-pre-scoping`, post the estimate and proposed split as a comment, hand it to a human.

This gate runs at Refine, before any code is written.

**A blown estimate has a consequence.** The estimate is checked against the real diff at Review. A final diff exceeding its estimate by more than 50% does *not* silently open a PR: the ticket moves to `pipenzo:awaiting-stack-approval` with the real numbers against the predicted ones, and the miss is recorded on the ticket (it is also what the routing-calibration numbers get measured against, rather than assumed). An estimate the agent is never graded on is not a gate.

**Refusal is a ticket state, not an error.** The gate produces two real states, both backed by GitHub labels and both landing in the existing *Needs human* lane:

- `pipenzo:needs-pre-scoping` — the agent declined the ticket. The card shows the estimate, which threshold tripped, and the proposed split, presented as a finished outcome rather than a failure. Nothing retries it automatically.
- `pipenzo:awaiting-stack-approval` — the agent produced a 2–4 PR decomposition and is waiting for a human to accept, reorder, or reject it. Approving materialises one dependency-ordered child ticket per entry, each with its own worktree and branch; the parent becomes a container card showing 1/3, 2/3 progress.

**The complete label set, published once.** Every label Pipenzo writes is `pipenzo:`-prefixed — no bare names, because a bare `ci-failed` or `working` will collide with labels a real repo already uses:

| Label | Lane | Meaning |
|---|---|---|
| `pipenzo:queued` | Queued | Accepted, not started |
| `pipenzo:working` | Working | A phase is running |
| `pipenzo:ready-for-review` | Ready for review | Branch committed, gates passed, awaiting the human push gate |
| `pipenzo:needs-human` | Needs human | Parked — 3 consecutive failures, or a denied approval |
| `pipenzo:needs-pre-scoping` | Needs human | Refused at the diff-size gate |
| `pipenzo:awaiting-stack-approval` | Needs human | A decomposition, or a blown estimate, awaiting sign-off |
| `pipenzo:ci-failed` | Needs human → **Ready for review** once the fix commits | A post-merge-request check failed (see CI-failure auto-fix). The label stays on the ticket, but a ticket carrying it moves to Ready for review the moment the forked fix attempt commits and is waiting on the push gate — it isn't stuck in Needs human for the whole CI-failure lifecycle, only for the part where nobody has looked at it yet |
| `pipenzo:merge-conflict` | Needs human | The approved branch no longer merges cleanly against its base; Pipenzo does not attempt a rebase itself — see *Remaining PR-event reactions* |
| `pipenzo:interrupted` | Needs human | The daemon died mid-run; see *crash recovery* in build step 3 |
| `pipenzo:schema-v1` | — | Marker: this issue is managed by a v1-schema Pipenzo (see *Schema versioning*) |

**A merged PR needs no label and no lane — GitHub already tells Pipenzo it's done.** There is deliberately no `pipenzo:done`/`pipenzo:merged` label in the table above. When a PR that closes its issue (`Closes #N`) merges, GitHub closes the issue itself; the polling reconciler only ever queries *open* issues, so a merged ticket's card simply stops appearing on the board on the next poll — no explicit "remove the card" step to get wrong, no growing Done column to scroll past. The board stays a picture of active work, not an ever-lengthening archive. The ticket isn't forgotten: its full record (attempts, gate results, pre-commitments, the risk score, worktree cleanup outcome) stays in the ticket store and is what the Activity view (see Design, below) reads from — closed-off the board, not deleted.

**The OAuth scopes, stated rather than requested quietly.** Pipenzo asks for `repo` on private repositories — creating labels and opening pull requests both need write access, and there is no narrower scope that grants one without the other. This belongs in the trust conversation up front, not in a consent screen the user skims: the token can write to any repo the user can write to, which is why it lives in the Electron-main token vault and is never handed to a provider subprocess.

**Stack maintenance is GitHub's job, not Pipenzo's.** Pipenzo owns the split decision, the ordering, and the human approval of it. GitHub owns base-branch rewriting, restacking after a merge, and the PR-to-PR relationship view — via native stacked PRs (public preview, Jul 2026) and the `gh stack` CLI, invoked from the daemon-side publish service under the same `execFile` trust model as `git`, never as an agent tool. `gh` stays an optional, runtime-detected capability, not a dependency of the core loop (the GitHub API client remains `@octokit/core`). Without it, an approved stack still ships — as dependency-ordered sequential PRs with an explicit base-branch note. Pipenzo never builds its own restacker.

## Feature plan (from the research report)

**MVP**
- Kanban home: Queued / Working / Ready-for-review / Needs-human lanes, backed by GitHub labels as the state model (survives app restart, no separate source of truth). **Cross-device/cross-teammate sync is polling, not push** — see *Team usage* below.
- Implement dialog with optional prompt + branch override — never a bare button
- Plan phase / "New from idea" conversational issue creation
- Agent-state enum with an OS notification exactly on "awaiting input" — which now means a HIGH-risk approval, a refusal, or a stack awaiting sign-off, never a MEDIUM card that resolves quickly. **A MEDIUM still blocking after 60 seconds does notify** — a MEDIUM that silently halts the whole run for an hour is precisely the failure mode notification exists for.
- **Risk-graded approval (LOW / MEDIUM / HIGH)** — LOW auto-proceeds with a passive line in the activity stream; MEDIUM blocks on a compact inline card; HIGH gets the full approval card plus an OS notification. Reject-reason field on every card that blocks. Replaces the earlier flat "one approve/reject card for everything" model.
  - **Undo, defined rather than asserted** — on a MEDIUM approval, Undo restores the paths the action touched from the pre-action worktree state, and is valid until the next commit on that branch. It applies to filesystem actions only, and never to HIGH: once a HIGH action is approved it has left the machine, and there is nothing local to restore.
- **Cumulative-risk strip, per ticket** — unreviewed LOW actions and mispredictions accumulate; crossing the threshold promotes the *next* MEDIUM action to a full HIGH card and says why ("14 low-risk actions since your last look"). Weights: **LOW +0.5, MEDIUM +1, pre-commitment mismatch +3, HIGH +0** (a human already looked hard at a HIGH). Threshold 10. **Only a HIGH approval, or an explicit "I've looked" — opening the ticket's Activity view — resets the score to zero.** A MEDIUM approval deliberately does *not* reset it: approving one inline card is a glance at one action, not a review of the run. That distinction is what makes the counter work at all — under a reset-on-any-approval rule, every MEDIUM and HIGH wipes the counter immediately after adding to it, so only LOW actions could ever accumulate and the threshold would be unreachable. With these weights the copy is literally true: 14 low-risk actions (7.0) plus one prediction mismatch (10.0) trips it.
- Separate "Push branch" / "Push & open PR" buttons
- Verification-evidence block in the PR body and in the diff view, split into two visually distinct zones — machine-verified deterministic gates vs. agent-captured self-reported evidence, never merged into one list
  - **Pre-commitment records** — before every MEDIUM/HIGH action the implementer posts what it is about to run, what it expects to happen, and what it will do if wrong; the real outcome is appended and diffed against the prediction. Mismatches are counted, never auto-collapsed, and feed both the cumulative-risk strip and the confidence line on the PR body
  - **Screenshot verification, capability-detected, driven by a declarative capture manifest** — the agent never writes automation code that the daemon then executes. It proposes a **manifest** — `{route, viewport, waitForSelector, actions: [{click|fill, selector, value}]}` — which is validated against a schema; the daemon owns every actual Playwright call, and navigation is restricted to the ephemeral localhost origin the daemon itself started. **No agent-generated JavaScript ever runs inside the daemon**, which is the process holding the token vault; an agent-authored capture *script* would have handed the agent arbitrary code execution next to the token and destroyed the property the whole design rests on. Uses the repo's own Playwright; before/after pair against the base commit; the hero evidence in Simple mode; carries a fixed provenance line and can never satisfy a gate. The `pipenzo.verify.screenshot` escape hatch for repos without Playwright stays a free-form command — that one is a *different trust class*, because it is repo-authored and human-committed, so a person has already reviewed it, exactly like a build script.
- Subscription-headroom rail, **labelled as an estimate, because that is what it is** — not a fake dollar figure, and not a real quota read either. Neither provider gives the daemon a usable quota number today: Codex emits a rate-limit event that agentdock normalizes and discards, and Claude has no quota notification at all. So the rail shows what is genuinely derivable locally — session count and cumulative token usage this window — and says "estimate" on its face. Surfacing the discarded Codex event is a real upstream agentdock enhancement, but the rail ships without it rather than blocking on it.
- Per-ticket token/run budget (0 = unlimited). Two non-token costs get counted against a ticket honestly rather than hidden: **screenshot verification's baseline capture is a second checkout of the base commit and a second dev-server run per ticket** — real wall-clock and real disk, not free — and the capture step takes the execution slot **serially** (the capture manifest carries a port the daemon injects, so two concurrent captures cannot collide on the dev server's default port).
- Classified retry — never auto-retries a denied approval
- Park after 3 consecutive failures → the Needs-human lane
- Diff-size gate at refine, with refusal and stack approval as real ticket states (see above)
- Simple mode by default, expert mode persisted per user
- **Humanizing rewrite pass, narrowly scoped** — a cheap-tier style pass over human-facing *prose only*: the drafted issue body in Plan, and the Simple-mode summary. It applies to nothing else. Verification blocks, gate results, diff stats, and pre-commitment records are **rendered from data and never rewritten**, because a style pass over an evidential claim is a mechanism for drifting facts, which is the exact opposite of what the rest of this design is for.
- **Worktree cleanup on every terminal state** (PR merged, PR closed without merge, ticket abandoned, stack child superseded) — calls agentdock's existing `worktrees.cleanup(id)` / `POST /v2/worktrees/cleanup`, already built and already exposed, just never wired to anything Pipenzo-specific yet. One worktree per ticket without a teardown path is an unbounded disk leak by construction; this closes it from day one rather than as later polish.
  Cleanup is **attempted**, not assumed to succeed, and the honest version of this has two caveats. agentdock's cleanup checks `git status --untracked-files=all` and refuses on *any* dirt — which for a real repo routinely means build output or `node_modules` in the worktree, not uncommitted source. On a `worktree_dirty` refusal the ticket surfaces a **"worktree retained — uncommitted or untracked files"** action with the path, rather than failing silently or pretending the disk was reclaimed. And cleanup removes the *worktree*, never the branch: the terminal-state sweep additionally runs `git branch -D` for merged or abandoned branches, because otherwise the branch list leaks exactly as the disk would have.

**Near-term post-MVP** — committed, with the trigger that unblocks each
- **Bounded concurrency** *(trigger: build step 5, the queue)* — a configurable execution limit, default 2, hard cap 4, one worktree per ticket. Two tickets whose Refine-phase "files likely touched" lists overlap are serialised rather than run together, which is a decomposition Pipenzo already has for free and Devin's sandbox model doesn't.
- **`gh stack` publishing** *(trigger: after the publish service ships, build step 2)* — upgrades approved stacks from sequential PRs to real GitHub-native stacked PRs. The trigger is step 2, not step 4: the walking skeleton has to open a PR to be a walking skeleton at all, so the publish service exists from step 2 onward.
- **Task-type-aware routing** *(trigger: after the diff-size gate is enforced at refine, build step 4)* — the best acceptance data available ([arXiv 2602.08915](https://arxiv.org/html/2602.08915v2)) shows merge rate tracking *task type* (chore 84.0%, docs 82.1%, feature 66.1%, fix 66.0%, perf 55.4%), not diff size. Refine already classifies the ticket; having it emit a task type alongside the size estimate, and routing model tier and gate strictness off both, is the cheap way to act on the one variable the evidence actually shows moving. Pairing it with the size gate rather than replacing the size gate is deliberate — the size thesis is a review-burden argument, the task-type finding is an acceptance-rate argument, and they are not the same claim.
- **CI-failure auto-fix** *(trigger: after the publish gate and one real PR-open flow work end to end)* — a failing check moves the ticket to `pipenzo:ci-failed`; the fix runs as a `session.fork` of the original implement session to keep spec lineage; one attempt only, only for failures the deterministic gate set can classify (build/typecheck/test/lint), everything else parks to Needs-human. The fix commit goes back through the same human push gate — unlike Jules, it is never resubmitted automatically
- **GitLab as a second code host** *(trigger: after the GitHub loop — Refine through Review through publish — is proven end to end)* — GitLab's issues/MRs/labels map closely enough onto Pipenzo's existing GitHub model (issue → label-state → MR in place of PR) that this is a second adapter behind the same `GitHubClient`-shaped interface, not a redesign. OAuth device flow is analogous. No `gh stack`-equivalent exists yet, so GitLab tickets fall back to the sequential-PR stack path permanently, not just until a native feature ships.
- **Jira as a ticket source, not a second code host** *(trigger: same as GitLab)* — Jira has no git hosting of its own; teams that file work in Jira still ship code through GitHub or GitLab. So this is a narrower adapter than GitLab: read/write Jira issue status to mirror Pipenzo's label-state model, keep the actual branch/PR/MR flow on whichever code host the repo already uses. Scoping it as "GitHub or GitLab, optionally mirrored to Jira" instead of "replace GitHub with Jira" avoids inventing a git-hosting story Jira doesn't have.
- Reviewer-grade diff layout with a findings sidebar by severity
- Plan-review gate before implementation starts
- Steer mid-run; Stop preserves commits
- Remaining PR-event reactions (merge conflict, review comments)
- Local, human-gated lesson memory

**Out of scope — decided, not deferred**
- **A persistent, queryable repo knowledge base** (DeepWiki / Amp's Librarian). The measured win — symbol-graph localisation, +12.2% accuracy and −53.9% completion time — comes from a *fresh* per-session graph, which cannot go stale. A durable index needs invalidation, an embedding store, and a staleness story, and its failure mode is an implementer confidently misled by an out-of-date wiki. That is a worse outcome than no wiki, for infrastructure this project deliberately doesn't have (JSON file store, no DB, no native addons). The human-gated lesson memory above is the deliberate small substitute.
  **One honest correction to that reasoning:** the fresh symbol graph this argument leans on is not something Pipenzo builds either. It is a user-configured stdio MCP server, inherited under decision 09 below — agentdock has no symbol index, tree-sitter parser, or LSP client anywhere in it, verified by grep, and Pipenzo adds none. So the accurate form of this decision is: *Pipenzo declines to own a durable index, and consumes a per-session symbol graph when the user has configured a server that provides one, falling back to `Grep`/`Glob` when they haven't.* The +12.2% figure is what a symbol graph buys where one exists, not a number Pipenzo can promise out of the box.
- **Pipenzo-shipped MCP servers.** MCP already exists one layer down: agentdock ships a trusted local-stdio MCP catalog with a route-level approval gate and fail-closed destructive-tool classification, so any server a user wants is configured at the runtime and inherited — Pipenzo adds no MCP UI of its own. Jules' servers (Linear, Neon, Stitch) are hosted/HTTP, a transport agentdock explicitly doesn't support. And the one integration that matters here, GitHub, must *not* go through MCP: that would put the token inside the agent process and break the property the whole design rests on — publishing is a daemon-side service the agent cannot call.
- **Matching Devin's 10+ parallel sandboxes.** Bounded local concurrency above is the honest ceiling for a single machine sharing one subscription's rate limit. Cloud sandbox fleets are a funded-product feature, not a missing one.
- **A home-grown PR-stack maintenance UI.** Deferring to `gh stack` is the decision, not a placeholder for building one later.

## What the September 2026 competitive pass changed

A deep-research pass against shipped competitors (Devin, GitHub Copilot, Cursor, OpenHands, Kiro, Jules, Codegen, Graphite) found the plan ahead on a few points (refusal-as-outcome at the diff gate, the same-or-higher-tier adversarial verifier rule, per-ticket budget, dual-audience mode) and at parity or behind on others (approval gating is now table stakes; Kiro already ships EARS spec-driven dev + property-based verification, so the Refine step is a subset of Kiro's, not ahead of it; the market moved toward dollar-quota cost display, away from abstract headroom). Full writeup: **Competitive positioning addendum** in [`docs/research-report.html`](docs/research-report.html).

Nine items came out of it. All nine are now decided and folded into the feature plan above — none are left open.

*(The list below names ten things, which is one more than nine on purpose: `gh stack` publishing is decision 01's maintenance half, sequenced post-MVP, not a distinct tenth decision. The report's decision table numbers it that way; this list separates it because it ships at a different time.)*

**In for MVP.** Diff-gate repositioning (refusal and stack approval as real ticket states), pre-commitment records, screenshot verification, and risk-graded approval with a cumulative-risk strip.

**In, near-term post-MVP, with a trigger.** Bounded concurrency (build step 5), `gh stack` publishing (after the publish service), CI-failure auto-fix (after the publish gate and one real PR flow).

**Out of scope, with a reason.** A persistent repo knowledge base and Pipenzo-shipped MCP servers — see the reasoning under *Out of scope* above. The short version: the knowledge base trades a staleness bug for a caching win a fresh per-session symbol graph already delivers, and MCP is a runtime-layer capability Pipenzo inherits rather than a product surface it should own. Those two reasons turn out to be the same reason — the symbol graph is itself an inherited MCP server, not a Pipenzo module.

**The Kiro reconciliation is a docs fix, and this is it.** Pipenzo does not claim EARS-notation spec-driven refinement as a differentiator — Kiro has shipped requirements/design/tasks specs with property-based verification as a GA AWS product since May 2026, and the Refine step is a subset of that, not an advance on it. What is actually additive here is narrower and worth stating plainly: the refine subagent is **read-only by construction** (`Read`/`Grep`/`Glob`, no write tool exists in its definition, so it cannot start implementing while it is still deciding whether the ticket is even sane), and it emits a **numeric diff-size estimate that a refusal policy is enforced against**. Those two things, not the notation.

## Team usage — four questions, resolved

Pipenzo is one desktop app per developer, not a shared server — these four came up as "what happens when more than one person touches the same repo" and needed real answers before the plan could call itself team-ready.

**Does moving a ticket sync across teammates' boards?** Eventually, not instantly — **decided: polling, for MVP and for the foreseeable future.** The state model is GitHub labels — a real shared resource on GitHub's servers, not a local file — so if Jake moves `ticket-123` from Queued to Working, that's a label change on the actual GitHub issue. John's Pipenzo instance sees it the next time it polls the GitHub API for that repo's issues (default interval: 30–60s while the app is open, plus a manual refresh action), not immediately. This is eventual consistency on a shared source of truth, not real-time collaboration — closer to two people refreshing the same GitHub issues page than to Figma-style live cursors.

The obvious-looking alternative — "just run a local server, desktop apps do this for OAuth callbacks all the time" — doesn't transfer, and it's worth spelling out why. A callback listener is reachable from *your own browser on the same machine*: the redirect is local, inbound-to-yourself. Cross-teammate sync needs the opposite direction — Jake's machine (or GitHub) reaching John's machine — and a plain local server behind a home router or corporate NAT isn't reachable by anyone else without port-forwarding or a tunnel. (This is also, concretely, why Pipenzo's own GitHub auth uses device-flow OAuth instead of a loopback listener in the first place — see the Stack table.) The real way to get push instead of poll is a GitHub webhook firing into a small hosted relay that fans out to connected desktop apps over a websocket — technically correct, but it's a piece of infrastructure someone has to run and pay for indefinitely, which contradicts the single-machine/no-backend/no-monetization shape of this project. Considered and explicitly deferred, not ruled out forever: if Pipenzo ever gets real multi-seat usage on one repo, a thin relay is the next thing to build, and everything else in the architecture (labels as state, no separate DB) still works unchanged underneath it.

**What stops two teammates both clicking Implement on the same ticket?** A claim, and an honest admission that it is best-effort. Polling answers *latency* but says nothing about *simultaneity*: without a claim, Jake and John can both hit Implement inside the same 30-second poll window and get two worktrees, two branches, and two agent runs burning two subscriptions on one issue.

The claim is **GitHub issue assignment**, because it is the one piece of per-issue state GitHub already arbitrates. Implement assigns the issue to the authenticated user, and **refuses to start if the issue is already assigned to somebody else** (an unassigned issue, or one assigned to you, proceeds). Immediately before dispatch — not from the poll cache — Pipenzo does an uncached `GET /issues/:n` and re-checks; that pre-flight closes the window from tens of seconds down to the round-trip, which kills the realistic version of this race.

It does not kill the theoretical one, and the README should not claim it does. **GitHub offers no compare-and-swap on labels or assignees**, so two clients that read "unassigned" in the same few hundred milliseconds can both write. This is a best-effort claim, not a mutex. The consequence when it loses is bounded and visible — the second instance finds the issue assigned on its next poll and parks the ticket to Needs-human with "claimed by @someone-else" — rather than silent divergence.

**Which source of truth wins?** There are two stores by design, and one precedence rule settles every conflict between them. **GitHub labels are authoritative for a ticket's lane.** The JSON ticket store is authoritative for everything GitHub cannot hold — worktree id and path, session and attempt lineage ids, budget consumed, risk score, pre-commitment events, poll ETags. When the two disagree about a lane (a teammate dragged the card on github.com, a crash landed mid-write), the divergence is written to the audit store and **the label wins**; the local record is reconciled to it, never the other way around. Without that rule stated, "labels as the state model" and "a JSON ticket store" are two sources of truth with no tiebreak, which is how state machines rot.

**What happens on disk with two tickets running at once?** Always two fully separate worktrees and branches — never one branch shared by two tickets, which would defeat the isolation the whole design depends on. `ticket-123` and `ticket-456` running together means branches `issue-123` and `issue-456`, each in its own worktree under agentdock's existing `OwnedWorktreeManager`, exactly as the Working-lane mockup already shows. The gap this question actually surfaced was cleanup: one worktree per ticket, running for months, with no teardown, is a disk leak by construction. agentdock already has the fix built — `worktrees.cleanup(id)` behind `POST /v2/worktrees/cleanup` — it just wasn't wired to any Pipenzo-specific lifecycle event yet. It is now, in the MVP feature list above: fired on every ticket terminal state (PR merged, PR closed unmerged, ticket abandoned, a stack child superseded by a rebase) — with the two caveats stated there, since agentdock's cleanup refuses on any untracked file and never deletes the branch.

**What about Jira and GitLab?** MVP stays GitHub-only, on purpose — the stack decisions already committed (`@octokit/core`, `gh stack`, device-flow OAuth, labels-as-state) are GitHub-native by design, and generalizing the core loop before it's proven once would dilute all of them at once. Both are real near-term additions, not permanently declined, and they're different shapes of addition: GitLab is a second **code host** (issues/MRs/labels are close enough to GitHub's model to sit behind the same client interface), Jira is a **ticket source** layered on top of whichever code host the repo already uses, since Jira has no git hosting of its own to replace GitHub or GitLab with. See the Near-term post-MVP list above for both.

## Requirements

Pipenzo brings no models and no inference credits of its own. It runs models **through agentdock**, which drives the Claude Code CLI and the Codex CLI as local subprocesses under the user's own authentication — so the thing a user has to bring is a working provider login:

- **At least one authenticated provider.** A Claude Pro or Max subscription (Claude Code CLI), a ChatGPT Plus or Pro subscription (Codex CLI), or API keys for either. Pipenzo never sees or stores these credentials; agentdock's provider detection does, exactly as it does for its own sessions.
- **Git, on `PATH`.** All git work is `execFile('git', …)` against the user's real install, credential helper and hooks included.
- **A GitHub account with write access** to the repos it manages — see the OAuth scope note above.
- Optionally, the repo's own Playwright, for screenshot verification, and a symbol-graph MCP server, for the localisation benefit in Implement. Both are capability-detected; both degrade to a stated-out-loud reduced mode rather than an error.

**With only one vendor authenticated, cross-vendor tiebreak degrades to same-vendor, same-tier — and says so.** The routing rule that prefers a different vendor for the adversarial verifier among equal tiers has nothing to pick from on a single-vendor install. It falls back to a same-vendor verifier at the same tier, and the run records that the vendor-diversity tiebreak was unavailable. It is not silently dropped: a verifier that couldn't be cross-vendor is a weaker check than one that could, and the evidence block should not imply otherwise.

## Connecting GitHub — auth flow, repo selection, the complete `gh` surface

Three things that were implied by other sections but never walked through end to end.

**Auth flow, step by step.** (1) User clicks Connect GitHub. (2) `@octokit/auth-oauth-device` requests a device code from GitHub; Pipenzo shows the code plus a "verify at github.com/login/device" link/button — no browser embedded, no redirect back into the app, the whole exchange happens on github.com in the user's own browser. (3) Pipenzo polls GitHub for authorization completion (this is the device-flow protocol's own polling, unrelated to the ticket-sync polling elsewhere in this doc). (4) On success, the token is written to the Electron-main token vault and never handed to a provider subprocess — this is the same property the OAuth-scope note above already stands on. (5) The app moves straight to repo selection, since a token with no selected repo is not yet useful.

**Repo selection.** Personal OAuth device flow means Pipenzo authenticates as *the user*, not as an installed GitHub App — so there is no separate "install on this org" approval step for an org admin to grant, unlike a GitHub App integration. The tradeoff is real and worth stating plainly: Pipenzo can see and manage anything the authenticated user's own account can already reach, which is simpler to set up but also means org-level access control is entirely GitHub's own permission model, not something Pipenzo adds a layer on top of. After auth, Pipenzo lists the user's accessible repos (`GET /user/repos`, paginated via `@octokit/plugin-paginate-rest`) in a searchable picker; selecting one adds it to a workspace-level connected-repos list (not per-ticket — this is the list the sidebar's workspace switcher and "N repos connected" line are reading from). Repos can be added or removed later from the same picker, reachable from the sidebar's workspace switcher. This list, and only this list, is what the polling reconciler iterates over.

**The complete `gh` CLI surface.** Exactly one command family, nowhere else: `gh stack`, invoked exclusively by the daemon-side publish service via `execFile`, runtime-detected (checked for on `PATH` before use, never assumed present), and only for stacked-PR maintenance once a human has approved a stack. That's the entire surface — no `gh auth` (device flow goes through octokit directly, not through shelling out to the CLI's own auth), no `gh pr create` (that's `@octokit/core`, per the Stack table), no `gh issue` anything. And there is no agent-facing skill, tool, or wrapper around `gh` at all, on purpose: the agent never has git-push or GitHub-write capability of any kind — that boundary is what "publishing is a daemon-side service the agent cannot call" actually means in practice. If `gh` is missing, stacks ship as sequential PRs instead; nothing else changes.

## Stack

| Concern | Choice | Why |
|---|---|---|
| UI components | shadcn/ui + Tailwind v4 | Component source you own and restructure per audience; coexists with a screen-by-screen migration |
| Kanban board | dnd-kit | Standard pairing with shadcn; shadcn has no kanban primitive |
| Diff review | react-diff-view | Parses real unified diffs into collapsible hunks — tens of kB, not Monaco's multi-MB editor |
| GitHub API client | `@octokit/core` + `paginate-rest` | Not the octokit metapackage, not the `gh` binary — pure JS, tree-shaken into the daemon bundle |
| Stacked PRs | `gh stack` (optional, runtime-detected) | The one place the `gh` binary is used, and only for stack maintenance GitHub now does natively; absent, approved stacks ship as sequential PRs |
| Screenshot verification | the repo's own Playwright, driven by the daemon from an agent-proposed **capture manifest** | Pipenzo ships no browser and never renders the target app in its own webview. The agent proposes a schema-validated manifest (`route`, `viewport`, `waitForSelector`, `actions`), never executable code; the daemon makes every Playwright call and confines navigation to the localhost origin it started. The `pipenzo.verify.screenshot` command is the one free-form path, and only because it is repo-authored and human-committed |
| GitHub rate limits | conditional requests + `@octokit/plugin-throttling` + `@octokit/plugin-retry` | A 30–60s poll per repo per open app burns the 5,000/hr primary limit fast. Every poll sends `If-None-Match` with the ETag stored per `(repo, resource)` in the ticket store — a `304` costs no quota at all. The throttling plugin honours `Retry-After` and secondary-limit responses instead of hammering; the retry plugin handles the transient 5xx. Below ~15% remaining quota Pipenzo **degrades rather than fails**: poll intervals widen and the board shows "syncing slowly" |
| GitHub OAuth | `@octokit/auth-oauth-device` | Device flow — no client secret to embed in a shipped OSS binary, no loopback listener |
| Git operations | `execFile('git', …)` | Same trust model as agentdock's worktree manager — argv array, `shell:false`, sanitized env |
| Notifications | Electron `Notification` API | Native, cross-platform, already solves this |
| Ticket/queue store | JSON file store | Matches agentdock's `FileSessionStore` pattern; no native-addon DB needed for hundreds of rows |

Full rationale for each choice is in the research report.

## Ticket store — what it actually holds

Eleven-plus features in the plan need persisted per-ticket state, so the shape is written down rather than left as "a JSON file store". It follows agentdock's `FileSessionStore` pattern exactly: one JSON file per record, a `manifest.json` carrying `schemaVersion`, atomic writes.

```jsonc
{
  "ticketId": "…",
  "repo": "owner/name",
  "issueNumber": 123,
  "lane": "working",                  // mirrors the GitHub label; the label wins on conflict
  "phase": "implement",
  "labels": ["pipenzo:working", "pipenzo:schema-v1"],
  "estimate": { "lines": 180, "files": 6, "layered": true },
  "stack":    { "parentId": null, "childIds": [], "index": null },
  "worktree": { "id": "…", "path": "…", "branch": "issue-123" },
  "attempts": [ { "sessionId": "…", "tier": "mid", "model": "…", "outcome": "gate_failed" } ],
  "budget":   { "tokensUsed": 412000, "limit": 0 },
  "risk":     { "score": 3.5, "lastResetAt": "…" },
  "precommits": [ { "action": "…", "expect": "…", "ifWrong": "…", "outcome": "…", "verdict": "match" } ],
  "etags":    { "issues": "W/\"…\"", "pr": "W/\"…\"", "checks": "W/\"…\"" },
  "schemaVersion": 1
}
```

`attempts[]` is what carries lineage across a tier escalation, where the provider thread does not (see *Implement*, above). `etags` is what makes a 30-second poll affordable. The precedence rule between this store and GitHub's labels is stated under *Team usage*: **labels are authoritative for `lane`, this store is authoritative for everything GitHub can't hold, divergence is logged and the label wins.**

**Schema versioning, because there is no auto-update.** Pipenzo ships unsigned with no update feed (see *Packaging* below), which means an old and a new version will coexist on a team's repo indefinitely — this is not a hypothetical. Four things follow. The store's `manifest.json` carries `schemaVersion` and **refuses forward-incompatible data** rather than guessing at it, mirroring agentdock's `UnsupportedSessionStoreVersionError`. Managed issues carry a `pipenzo:schema-v1` marker label, so an instance can tell at a glance which schema wrote them. A version bump **renames** labels through the API rather than delete-and-recreate, because rename preserves the label's associations on every issue already carrying it and delete-recreate silently unlabels the whole backlog. And an instance that meets a repo whose marker is newer than it understands **goes read-only on that repo** with a plain message, instead of writing v1 semantics over v2 state.

## Design

A clickable Claude Design canvas covers the product's key screens: kanban home (sidebar + main-content admin layout), live ticket progress with phase stepper and model-routing/budget rail, inline approval, a reviewer-grade diff view, and a plain-language "Simple mode" view for non-developer users. Dark-mode only for now — light mode is a stated roadmap item, not built yet.

The canvas has been updated to match the decisions above — risk grading, pre-commitment pairs, the two-zone evidence block, the refusal/stack-approval states, and screenshot evidence are all in it, plus a WCAG AA contrast/focus-state pass. It also covers the states a happy-path mockup normally skips: skeletons and pending buttons for loading, a degraded-versus-blocking split for errors (`pipenzo:interrupted` with its resume condition, the "worktree retained — uncommitted or untracked files" refusal, GitHub unreachable, and an expired device-flow token), and first-run and per-lane empties. Multi-provider support has a real UI surface now (Settings' Providers panel, showing both authenticated CLIs). The claim-conflict state — the loser of the best-effort assignment race in *Team usage*, above — now has a surface: it's the sixth Needs-human card variant, carrying "claimed by @someone-else," alongside the five already there (`#89` in Main's Needs-human lane, with a specimen and rationale panel in Foundations). It is the one card in that lane with no action available — informational only, since the current user isn't the one who can resolve someone else's claim. The polling model is surfaced: a sync-status pill in the board header, documented as a primitive in Foundations in all three of its renderings — synced, syncing, and "syncing slowly".

The four screens the sidebar had always pointed at are now built too. `Connect` is the pre-app device-flow onboarding — the code, the "verify at github.com/login/device" link, the waiting indicator, then the searchable repo picker whose selection *is* the workspace connected-repos list. `Activity` is what makes "the board shows open work, the history lives here" real: a reverse-chronological read of the ticket store, including a merged ticket whose card has already left the board. `Models & gates` shows the routing-class-to-tier table as editable and the verifier tier and the five deterministic gates as deliberately not. `Settings` carries the connected repos, the concurrency stepper, the risk-graded notification rules with the HIGH row locked on, the Simple/Expert default, and the GitHub identity.

- [`design/pipenzo-prototype.html`](design/pipenzo-prototype.html) — the full seeded canvas, open directly in a browser
- [`design/artboards/`](design/artboards/) — the individual screens as editable `.dc.html` source (`Foundations` = design-system/primitives reference; `Main`, `TicketDetail`, `ApprovalPrompt`, `DiffReview`, `SimpleMode`, `Connect`, `Activity`, `Models`, `Settings` = product screens)
- [`design/canvas.json`](design/canvas.json) — canvas layout manifest
- Icons: [Phosphor Icons](https://phosphoricons.com/) (regular weight), inlined as SVG
- Typography: IBM Plex Sans + IBM Plex Mono

## Build order

1. Design system, before any screen — shadcn/ui primitives, tokens, branding. Everything else builds against this.
2. Walking skeleton — hardcoded repo, PAT from env, no queue. One ticket through refine → implement → review → diff screen → open PR, end to end.
3. **Ticket store + phase machine over labels** — JSON-file persistence, the phase machine, phase-change SSE, a real ticket detail view, the dirty-worktree discard path, and **crash recovery for both stores**. The GitHub *client* lands here too, not at step 4: a phase machine whose states are GitHub labels cannot write a state without it. (Only the client — OAuth stays at step 4, and step 3 keeps reading a PAT from env, as step 2 does.)
   **Agent-session crash recovery, which is a separate problem from ticket-store crash recovery.** agentdock's `recoverInterruptedExecutions()` marks interrupted sessions failed and reports their ids — it does **not** auto-resume or auto-retry them (`apps/daemon/src/execution-graph-store.ts`, `apps/daemon/src/session-store.ts`). So a daemon crash mid-Implement leaves three things and nothing owning them: an interrupted session, a dirty worktree, and a ticket whose local phase and GitHub label disagree. On daemon start Pipenzo reads the recovery report's interrupted session ids, maps each to its ticket, and moves that ticket to **`pipenzo:interrupted`** in the Needs-human lane, showing the last completed phase and the worktree path, offering exactly two actions: **resume** — offered only when a `providerSessionId` and a `continuationScope` both exist, i.e. only when resume will actually succeed — or **discard and restart**. It **never auto-resumes**: the approval state of an in-flight MEDIUM or HIGH action is unknowable after a crash, and resuming into it would silently re-run something a human may have been about to deny. This is also why the dirty-worktree discard path sits here rather than in step 6 — a crashed session's worktree is dirty by definition, so the reconciler needs it on day one.
4. GitHub & the size gate, properly — device-flow OAuth in Electron main, token vault, real issue list, the diff-size/split gate enforced at refine, a test asserting the token never reaches a provider subprocess.
5. Queue + dual-audience mode — dnd-kit kanban, simple/expert toggle with a persisted default, one worktree per ticket, and bounded concurrency (default 2, cap 4) with overlapping-file tickets serialised. **Worktree provisioning is serialised in the ticket orchestrator, with a retry on `worktree_busy`** — agentdock's worktree manager throws rather than queues when two provisioning calls hit one source repo at once, so concurrency without that serialisation fails on its first real double-start.
6. Polish — native "awaiting approval" notification on HIGH-risk cards only (plus the 60-second MEDIUM escalation), rejection loop that forks implementation again, terminal-state worktree cleanup wired to agentdock's existing `worktrees.cleanup(id)` with the dirty-refusal surface and the `git branch -D` sweep, the **risk classifier** (below), an audit entry for every publish and review-gate result.
7. First post-MVP milestone — `gh stack` publishing for approved stacks, then CI-failure auto-fix routed back through the same human push gate.

**The risk classifier is a module, and it is daemon-side.** LOW/MEDIUM/HIGH does not classify itself. `apps/daemon/src/risk-classifier.ts` owns it, in the daemon and **never agent-side** — an agent that grades its own actions is not a gate. Its job is to map agentdock's real permission taxonomy (`actionClass` of `filesystem | command | network | mcp | external_side_effect | other`, `risk` of `normal | destructive | unknown` — `packages/shared/src/policy-v2.ts`) onto Pipenzo's three levels:

- **LOW** = agentdock `risk: normal`, `actionClass` of `filesystem` or `command`, and a path inside the ticket's own worktree.
- **MEDIUM** = everything agentdock routes to `ask` that is not `external_side_effect`.
- **HIGH** = `external_side_effect`, a destructive MCP tool, or a path matching the security/auth/migration globs.

One classifier serves both risk grading and the pre-commitment trigger, and the 95%-LOW calibration target is a **measured** number — see *Testing*, not an assertion in this README.

**Biggest risk called out in the research:** the temptation in step 2 to let the agent shell out to `gh` directly. Publishing stays outside the agent loop from the first commit — retrofitting that boundary later breaks the safety property the whole design depends on.

## Packaging & distribution — decided, and it's a tradeoff

**v1 ships as an unsigned Windows x64 NSIS installer, via GitHub Releases.** That is what it inherits: agentdock's `electron-builder.yml` targets `nsis`/`x64` under `win` only, sets `publish: null`, and carries no signing configuration — so there is no macOS build, no Linux build, and **no auto-update**, today.

The costs are real and worth naming rather than discovering later. An unsigned installer means a Windows SmartScreen warning on first run, which is a genuine adoption tax on an open-source tool asking for `repo` scope in the same session. No auto-update means old and new versions coexist on a team's repo indefinitely — which is exactly why the label schema is versioned above.

**macOS and Linux are post-MVP and are real work, not a build flag.** macOS in particular needs a paid Apple Developer ID plus notarization to be installable without a right-click-Open ritual. Until then, the "cross-platform" claim in the research report is about the *architecture* — Electron plus a Node daemon, with no platform-specific assumptions in the loop — and not about what v1 actually distributes. The report has been corrected to say so.

## Testing — Pipenzo's own code

Vitest, with a flat `test/` directory per package, matching agentdock's existing layout. Four suites, chosen because they cover the parts of this design that are easy to assert and hard to verify:

1. **Pure-function tests for the diff-size policy and the risk classifier**, against a fixture corpus of real diffs and real action envelopes. This is also *how the 95%-LOW calibration target gets measured* rather than asserted — if the corpus doesn't come out near 95% LOW, the classifier is wrong, and the README says so above.
2. **A `FakeGitHubClient` behind the `GitHubClient` interface**, so the polling reconciler, the label state machine, the ETag path, and the claim race can all be tested without network or a live repo. It is the same interface a future GitLab adapter sits behind — the fake is the first proof that the interface is actually an interface.
3. **Fastify `app.inject` route tests** for the new daemon routes, matching how agentdock already tests its own.
4. **A crash-recovery test** that kills the store mid-write and asserts the reconciler in build step 3 — interrupted session mapped to its ticket, ticket moved to `pipenzo:interrupted`, resume offered only when a `providerSessionId` and `continuationScope` exist, and nothing auto-resumed.

## Naming

Named after the product owner's two kids — decided over every researched alternative on that basis alone.

## License

Apache-2.0 is the intended license, and the reasoning is friction rather than preference: agentdock — the foundation this is built on and the source of the packaging, worktree, and session machinery — is Apache-2.0, and the UI dependencies (shadcn/ui, dnd-kit, react-diff-view) are MIT, which is compatible either way. Matching agentdock is the path of least friction for code moving between the two. Not yet formally applied; no `LICENSE` file is committed until the repo has code in it.
