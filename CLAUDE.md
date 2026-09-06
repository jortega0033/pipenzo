# Working on Pipenzo

Read `README.md` fully before touching anything — it's the canonical decisions document, not `docs/research-report.html` (that's rationale/evidence; where the two disagree, README wins). This file only holds the rules that must never be violated, not a restatement of the plan.

## Hard rules — these are safety properties, not style preferences

1. **The agent never touches `git push`, `gh`, or any GitHub-write call.** Publishing is a daemon-side service (the publish service, `apps/daemon/src/publish-service.ts` once it exists) invoked via `execFile`, never an agent tool. This is the single property the whole design depends on — see README's "Biggest risk called out in the research". If a task seems to require the agent pushing or opening a PR directly, stop and re-read the publish-gate section rather than reaching for the shortcut.
2. **No agent-generated code executes inside the daemon.** The daemon holds the token vault. Screenshot verification uses a schema-validated declarative manifest the agent proposes; the daemon makes every Playwright call itself. See README's screenshot-verification entry for why the earlier "agent writes a capture script" design was a rejected security regression, not a style choice.
3. **HIGH-risk actions (`external_side_effect`, destructive MCP, security/auth/migration paths) never get an auto-allow, at any point, for any reason.** No exceptions, no "just this once for testing." See the risk-classifier section.
4. **A denied approval is never auto-retried.** Classified retry escalates model tier, not human judgment. Tier escalation uses a fresh session, not `session.fork` — agentdock freezes `selectedModel` into a fork's continuation scope, so a fork *cannot* change model (`packages/shared/src/protocol-v2.ts`).
5. **Every `pipenzo:`-prefixed label is exactly as specified in README's label table — no bare names.** A bare `ci-failed` or `working` collides with labels a real repo already uses.

## Repo layout note

`apps/`, `packages/`, and most of `docs/*.md` came from a `git merge --allow-unrelated-histories` of [jortega0033/agentdock](https://github.com/jortega0033/agentdock) (see README's "Relationship to agentdock"). `git fetch upstream-agentdock` still works to pull in upstream fixes. Don't assume code under `apps/daemon` or `apps/desktop` is Pipenzo-specific just because it's in this repo — check whether it's inherited agentdock infrastructure (worktree manager, session store, permission policy, provider adapters) before "fixing" something that's actually agentdock's own decision; file gaps there upstream instead (see agentdock issues #116-118 for the pattern).

## Ticket discipline

The design canvas (`design/artboards/*.dc.html`) is the source of truth for UI — build against it, don't redesign from scratch. Every open issue on this repo maps to something specific in README or the canvas; if a ticket's scope looks bigger than one PR once you're in it, that's the diff-size gate's own thesis applying to Pipenzo's own development — split it rather than landing one giant PR.

## Guardrail subagents available in this repo

`.claude/agents/` carries a curated set from [jortega0033/agency-agents](https://github.com/jortega0033/agency-agents), picked for this repo's actual risk surface (a token vault, OAuth `repo` scope, AI-authored code by design):

- `security-ai-generated-code-auditor` — review AI-authored diffs for the failure modes coding assistants ship by default (hardcoded secrets, missing authz, injection sinks)
- `security-appsec-engineer` — general application security review
- `security-secrets-credential-engineer` — anything touching the token vault or credential handling
- `engineering-code-reviewer` — general code review
- `engineering-minimal-change-engineer` — enforces small, scoped diffs (this is Pipenzo's own product thesis applied to Pipenzo's own commits)
- `engineering-git-workflow-master` — branch/worktree/merge hygiene, relevant given how much of this repo's own workflow depends on git worktrees

Use them proactively on anything touching the token vault, OAuth flow, the publish service, or the risk classifier — not just when asked.
