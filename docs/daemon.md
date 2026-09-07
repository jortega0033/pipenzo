# Daemon

`apps/daemon` is a standalone Fastify HTTP+SSE server. It has no Electron dependency and no
required parent process: `pnpm daemon` runs and can be `curl`'d directly, with no display server
or GUI test harness required.

## Running it standalone

```bash
pnpm daemon
```

This runs `apps/daemon/src/index.ts` directly through `tsx` (`pnpm --filter @agent-dock/daemon run
start`). On startup it prints the URL it's listening on and where it wrote its discovery file. In
another terminal:

```bash
curl http://127.0.0.1:<port>/health
```

`pnpm --filter @agent-dock/daemon run dev` does the same thing with `tsx watch` for auto-restart on
source changes.

## Binding and port

The daemon binds `127.0.0.1` only, never `0.0.0.0`, and never the IPv6 loopback (`::1`) either; it
answers on IPv4 only (`apps/daemon/src/index.ts`). By default it asks the OS for an ephemeral port
(`AGENT_DOCK_PORT` unset or `0`); set `AGENT_DOCK_PORT=<port>` to request a fixed one. Whichever
port it ends up on is written to the discovery file and printed to stdout: there's no way to know
it in advance otherwise.

## Discovery file

The daemon writes `{ port, token, pid, startedAt }` to `os.tmpdir()/agent-dock/<app-id>.json` once
it's listening (the file mode `0600`, and the containing directory created/verified mode `0700`
on POSIX (see [SECURITY.md](../SECURITY.md#local-auth-token) for why, including the Windows
caveat)). This is a **filesystem handoff, not a network one**: a client reads the file directly
(it has to be running as the same OS user), rather than the daemon ever broadcasting the token
over the network.

`<app-id>` defaults to `agent-dock` and is set via `AGENT_DOCK_APP_ID`; see
[Duplicate-start behavior](#duplicate-start-behavior) below for why it exists and how it is
validated.

## Auth token

Every route except `GET /health` requires `Authorization: Bearer <token>`, checked with a
timing-safe comparison. The full threat model and reasoning live in
[SECURITY.md](../SECURITY.md); this file only covers operational behavior, not why it's safe.

## Duplicate-start behavior

The daemon refuses to start if its app id's discovery file's recorded pid is still alive
(`apps/daemon/src/discovery-file.ts#assertNoLiveDaemon`):

```
Error: another agent-dock daemon (app id "agent-dock") is already running (pid <pid>,
discovery file <path>). Only one daemon per app id is supported at a time. Stop it first.
```

This is a best-effort **per app id** check, not a machine-global or atomic lock.
`AGENT_DOCK_APP_ID` (default `agent-dock`) namespaces the discovery filename, so two different
products built on this boilerplate intentionally run their own daemons side by side. A sequential
second start with the same app id sees the live recorded pid and refuses to start. Two simultaneous
starts can both pass the pre-listen check before either writes the file, then coexist while the last
writer wins discovery. The packaged Electron app separately prevents its normal launch path with
`app.requestSingleInstanceLock()`; a standalone host needing a hard guarantee must add equivalent
coordination. The app id is
validated before it is used to build discovery and state-directory paths. Because both validators
run, the effective accepted set is 1–64 characters: a lowercase ASCII letter or digit first, then
lowercase ASCII letters, digits, `-`, or `_`. Invalid values are rejected outright (the daemon fails
to start with a clear error) rather than sanitized, so they cannot be used for path traversal or to
point outside the discovery directory.

A discovery file whose recorded pid is no longer running (a stale file left by a crash or
force-kill) is treated as safe to overwrite: nothing is listening at that pid anymore, and a
corrupt/partially-written file is treated the same way. A stale file for one app id never affects
another app id's daemon, since they're different files. See
[troubleshooting.md](troubleshooting.md#daemon-fails-to-start) if you hit this unexpectedly.

## Routes

| Route                              | Auth     | Behavior                                                                                                                                                                                                                      |
| ---------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                      | none     | `{ status: 'ok', uptimeSeconds, protocolVersion: 1, supportedProtocolVersions: [1, 2] }`                                                                                                                                      |
| `GET /providers`                   | required | `{ providers: ProviderStatus[] }` with `accountFingerprint` and `selectedModel` stripped from each record, runs each adapter's `detect()`                                                                                    |
| `GET /providers/:providerId`       | required | One `ProviderStatus` (same stripped fields), or `404` for an unregistered id                                                                                                                                                  |
| `POST /sessions`                   | required | Rate-limited to 30 requests/minute. Body validated against `createSessionRequestSchema`. `400` for an invalid provider/resume/cwd; `409 workspace_untrusted` unless the current workspace incarnation is trusted; `429 session_capacity_exceeded` past the shared admission cap (see [Session admission](#session-admission) below); `201` + `AgentSession` on success |
| `GET /sessions/:sessionId`         | required | Current `AgentSession` record, or `404`                                                                                                                                                                                       |
| `GET /sessions/:sessionId/events`  | required | SSE stream, see [Event history and replay](#event-history-and-replay) below                                                                                                                                                   |
| `POST /sessions/:sessionId/cancel` | required | `202` + `{ status: 'cancelling' }`. `404` for an unknown id **or** a session that's already terminal: cancelling a finished session is never reported as a success                                                            |
| `POST /sessions/cancel-all`        | required | Cancels every in-flight v1 session. Narrow and single-purpose (not a generic process-control endpoint): exists specifically for Electron's shutdown path, see [Shutdown](#shutdown) below. `202` + `{ status: 'cancelling' }` |
| `DELETE /sessions/:sessionId`      | required | Cancels if still running, then removes the record. `204`, or `404`                                                                                                                                                            |

Structured request bodies and identifiers use shared Zod schemas or narrow explicit validators;
raw attachment streams have route-specific byte, MIME, and quota checks. Invalid input gets a `4xx`
with a short JSON error message, never a stack trace. See the full request-validation and
error-handler behavior in [SECURITY.md](../SECURITY.md#request-validation).

Wire shapes (route bodies, the `AgentEvent`/`AgentEventEnvelope` format) are documented in
[protocol-v1.md](protocol-v1.md), not duplicated here.

Protocol v2 is additive: authenticated `/v2/providers` and `/v2/sessions` routes expose scoped
capability records, negotiate before starting provider work, stream validated v2 envelopes, and
dispatch accepted interactive commands through
`POST /v2/sessions/:sessionId/commands`. The unversioned routes above remain the v1 compatibility
and rollback path. The complete v2 route, status, and wire-shape tables live in
[protocol-v2.md](protocol-v2.md).

## Pipenzo ticket phase machine

`PipenzoPhaseMachine` (`apps/daemon/src/pipenzo-phase-machine.ts`) is a daemon-internal component
behind two of the routes documented in [protocol-v2.md](protocol-v2.md):
`POST /v2/pipenzo/tickets/read` and `POST /v2/pipenzo/tickets/transition`. It is the implementation
of Pipenzo's one precedence rule — **GitHub labels are authoritative for a ticket's lane; the local
JSON ticket store is authoritative for everything GitHub cannot hold; and when the two disagree,
the label wins.**

**Write order: GitHub first, the local record second.** A transition looks backwards at first
glance, because the slow, failure-prone, over-the-network write happens before the fast local one.
The reason is what a crash between the two writes leaves behind. Label-first means GitHub already
has the new lane and the local record has the old one — the authoritative side is correct, and the
next read reconciles the stale local record to it, so the system heals itself. Record-first would
mean the local record claims a lane GitHub never agreed to; reconciliation would then treat that
local claim as stale and quietly revert it, undoing completed work. A crash between the two writes
is not the unlikely case here either: the label write is a network round trip to a rate-limited
API, which is precisely the step most likely to be interrupted.

**Label-wins reconciliation runs on every read.** Before either route acts, and before a
transition is validated against the ticket's current lane, the machine re-fetches the issue's
labels and compares them against the local record. Agreement is a no-op. A disagreement rewrites
the local lane and label set to match GitHub and reports `lane_reconciled`. An issue carrying more
than one lane-bearing label resolves to one lane by a fixed precedence that always prefers the lane
that halts automation (`needs-human` over everything, `ready-for-review` over `working`) and
reports `ambiguous_labels`, because a person put a second label on that issue and should be told
the machine had to pick. An issue with no lane-bearing `pipenzo:` label at all keeps the local lane
rather than clearing it and reports `unlabelled` — an absent label states nothing to reconcile to,
and clearing the record would turn a human deleting a label into silent data loss on the side that
holds the worktree, attempt lineage, and budget. A transition is validated against this reconciled
lane, not the local record's possibly-stale one, so an illegal move can't slip through just because
the local copy hadn't caught up yet.

**There is deliberately no list route.** A kanban board needs every ticket, and reconciling one
ticket costs one GitHub read; reconciling a board costs one read per ticket, every time anyone
opens it, against an API with a quota. The reconciler that makes a list affordable is the polling
layer with `If-None-Match` conditional requests (build step 4, issue #161), which issue #188
explicitly puts out of scope. Shipping an unreconciled list route in the meantime would be worse
than shipping none: it would return lanes that look authoritative and are not, through a surface
whose entire purpose is that the label wins. See the module comment in
`apps/daemon/src/routes/pipenzo-tickets.ts` for the full reasoning.

**Every committed change is announced on the phase stream.** `PipenzoPhaseEventBus`
(`apps/daemon/src/pipenzo-phase-events.ts`) is a bounded, daemon-wide ring buffer the machine
publishes to after — never before — both sides have committed, and `GET /v2/pipenzo/tickets/events`
serves it as SSE (issue #189). Publishing after the write is what makes the stream a report rather
than a promise: a subscriber that acted on an event for a write that then failed to land would be
holding a lane neither GitHub nor the store agrees with. Both causes are published — a transition
this daemon performed, and a read that reconciled because a human edited the label on GitHub — since
both are real lane changes and the label is authoritative for both. A read that found the two sides
already in agreement writes nothing and so announces nothing.

The bus is bounded and drops its oldest events, because a daemon running for a week would otherwise
retain every transition it ever made while a board only ever needs enough history to cover a dropped
connection. A subscriber asking to resume from a cursor older than the retained window is refused
with `replay_gap` rather than handed a silently truncated history — a board that quietly missed
three transitions renders a lane that is wrong, and nothing downstream could tell. A subscriber too
slow to drain its socket is cut loose by the shared bounded writer (`apps/daemon/src/sse-writer.ts`,
the same state machine protocol v2's session stream uses) rather than allowed to grow the daemon's
memory without bound.

## Pipenzo crash recovery

A daemon restart already marks every non-terminal session `interrupted` with
`reason: 'daemon_restart'` and reports its id — `FileExecutionGraphStore` for executions,
`FileSessionStore` for its v1 compatibility records. Neither store knows what a ticket is.
`PipenzoCrashRecovery` (`apps/daemon/src/pipenzo-crash-recovery.ts`) is what maps those session ids
back onto tickets, so a crash mid-Implement does not leave an interrupted session, a dirty worktree,
and a ticket whose local phase and GitHub label disagree with nothing that owns the three together.

**It parks. It never resumes and never retries, and no configuration flag turns that off.** The
approval state of an in-flight MEDIUM/HIGH action is unknowable after a crash — the daemon died
somewhere between the implementer posting what it was about to run and a human approving or denying
it, and nothing on disk distinguishes those two — so resuming into that gap could silently re-run
something a person was about to deny. A parked ticket offers a human exactly two actions: **Resume**,
offered only when a `providerSessionId` and a `continuationScope` both exist (that is, only when it
would actually succeed), and **Discard and restart**, which is the existing
`POST /v2/worktrees/cleanup` path rather than anything new.

**The `sessionId → ticketId` index is built in memory, at recovery time.** `attempts[].sessionId`
already carries the lineage, so the index is a walk over the ticket records the store loaded on
construction: recovery runs once per daemon start, the walk costs no extra I/O, and nothing about the
ticket store's on-disk schema changes. A persisted index would be durable state that can tear
mid-write, which would give the crash-recovery path its own crash-recovery problem.

**Write order is inverted relative to the phase machine, deliberately.** A transition writes GitHub
first; recovery writes the **local** record first and attempts the label afterwards. The question is
different: not which order survives a crash between two writes, but what must never be allowed to
stop a daemon from starting. A daemon starts in exactly the conditions where a GitHub write is least
likely to work — no token configured, no network, a quota already spent — and ordering GitHub first
would mean an interrupted ticket is parked *nowhere* whenever GitHub is unreachable. Ordering the
local write first costs a window in which this daemon knows a ticket is interrupted and GitHub does
not, and that window closes on its own when the next read reconciles.

So the local half runs at startup, before the server listens, and the GitHub half runs after
`listen()` resolves and is not awaited: every parked ticket is already durable and already served by
`GET /v2/pipenzo/recovery` by then, and awaiting one round trip per parked ticket would make the
desktop's first connection wait on a rate-limited API. The GitHub half is sequential rather than
concurrent, for the same quota reason, and it cannot throw — a failure is logged with the ticket
named and reported as `labelWrite: 'failed'`.

The label write goes through `PipenzoPhaseMachine` rather than `GitHubClient.setIssueLabels`
directly, so which labels survive a write, what the local record says afterwards, and the phase-stream
announcement all stay in one place. One consequence is worth naming: the machine reconciles before it
writes, and reconciliation is label-wins, so a successful issue read followed by a failed label write
rewrites the local record back to the lane the ticket crashed in, undoing the park.

Recovery deliberately does **not** re-apply the park on top of that. Nothing in the record can tell
"reconciliation reverted my park" apart from "a human moved this ticket while the write was in
flight" — there is no revision on the record and no compare-and-set on the store — and the label
writes run after `listen()`, against a live API, so the second case is real. Restoring blind
discarded genuine human progress and left the record and the phase stream claiming a lane GitHub
disagreed with, a divergence recovery invented. Instead the write is skipped outright when the ticket
has already left the park (`labelWrite: 'superseded'`), and a failure leaves both sides telling the
same story (`labelWrite: 'failed'`). The recovery report, not the lane, is what guarantees an
interrupted ticket stays visible.

**Known limit, not yet closed.** When a write fails *after* the machine's read reconciled the park
away, `pipenzo:interrupted` ends up on neither side. The recovery report still names the ticket, but
that report lives in daemon memory, and a session reported interrupted is terminal in both stores —
`FileExecutionGraphStore` skips terminal records on load and `FileSessionStore` sweeps only
`starting`/`running` — so the next daemon start will not report it again. The ticket is then the
un-owned thing this section exists to eliminate. Recovery still does not re-park, because writing
over a record a human may have just moved is the worse of the two failures and was measured doing
real damage. Closing the gap properly needs a durable marker rather than process memory, and is
tracked as issue #201.

For the same reason, a ticket already holding an unanswered human decision —
`pipenzo:awaiting-stack-approval`, `pipenzo:needs-pre-scoping`, `pipenzo:merge-conflict`,
`pipenzo:ready-for-review` — is reported but never parked (`labelWrite: 'skipped'`).
`setIssueLabels` replaces the whole `pipenzo:` namespace, so writing `interrupted` over one of those
would destroy a question nobody has answered, and nothing downstream would raise it again: after a
Resume the ticket would proceed straight past an approval that was never given. The first three are
already in the Needs-human lane, so leaving them alone costs nothing the park was there to provide.
`ready-for-review` is the one that is not, and it is included anyway: it is README's push gate, so a
ticket carrying it is already in front of a person, and overwriting it would lose the fact that the
work finished.

One ticket parks once, however many of its sessions the crash interrupted — a ticket carries several
`attempts[]` across a tier escalation, and parking per session would put two cards on the recovery
screen for one ticket.

Sessions that map to no ticket are normal rather than an error: agentdock runs plain sessions with no
Pipenzo ticket behind them, and a crash interrupts those the same way. They are counted and logged,
not treated as a failure. The ticket store's own recovery composes with this one: a store that had to
quarantine a torn record on the same start reports that count beside the parked set, and the
surviving tickets still park.

## Session admission

`POST /sessions` and `POST /v2/sessions` (including resume/fork) share one daemon-wide admission
gate (`apps/daemon/src/session-admission.ts`): at most `AGENT_DOCK_MAX_ACTIVE_SESSIONS` provider
processes pending-start-or-running at once, default 4, hard ceiling 32. An out-of-range or
non-integer value fails the daemon at startup rather than silently clamping. Past the limit, a new
session request gets `429 session_capacity_exceeded` immediately rather than queueing.

## Session lifecycle: SessionManager, SessionStore

`SessionManager` (`apps/daemon/src/session-manager.ts`) orchestrates both legacy and interactive
runtime handles: it creates sessions through the provider registry, consumes normalized event
streams, and keeps the `AgentSession` record's status current as terminal events arrive. The v2
facade owns the frozen capability selection, execution/turn IDs, normalized v2 replay window, and
v2 lifecycle projection.

The `AgentSession` record itself lives behind a `SessionStore` interface
(`apps/daemon/src/session-store.ts`):

```ts
interface SessionStore {
  create(session: AgentSession, protocolVersion?: 1 | 2): void;
  get(id: string): AgentSession | undefined;
  update(id: string, session: AgentSession): void;
  delete(id: string): void;
  list(): AgentSession[];
  protocolVersionOf(id: string): 1 | 2 | undefined;
}
```

`MemorySessionStore` remains available for isolated tests and embedders. Production uses the
versioned `FileSessionStore`, which atomically persists compatibility metadata without prompts or
raw error diagnostics and marks legacy active-at-restart records failed. Protocol v2 additionally
uses
`FileExecutionGraphStore` as the authoritative durable metadata/history store; it recovers active
executions as `interrupted` and owns lineage retention, tombstones, pagination, and continuation
locks. All writes remain synchronous so metadata is durable before provider dispatch.

The compatibility store owns only the `AgentSession` record. A session's live legacy or interactive
provider handle and bounded SSE replay window remain runtime state inside `SessionManager`; durable
normalized v2 events are stored separately by the execution graph.

For an interactive v2 transport, creation resolves only after the provider startup handshake. The
common supervisor enforces 1 MiB provider-frame and normalized-event limits, a 5,000-event / 16 MiB
provider queue, at most 32 pending interactions, 30-second startup/command acceptance, five-minute
interaction deadlines, a five-second graceful-close bound, mandatory process-tree hard-stop/reap
fallback, and exactly one terminal event. Provider stderr is drained and discarded; it is not a
retained diagnostic buffer. Production Claude exposes the pinned Agent SDK transport when its
asset/auth/trust gates pass; Codex exposes its version-validated app-server transport. `FakeProvider`
keeps this path deterministic in shared supervisor tests.

The manager registers each startup before awaiting that handshake. Client disconnect, direct
cancellation, cancel-all, and daemon shutdown abort and await pending starts; shutdown also closes
the admission gate before taking its cancellation snapshot. A provider must honor the startup
abort signal by reaping its host before rejecting.

Interactive command dispatch is serialized per session. A canonical command ID/payload retry
shares the original result; conflicting reuse returns `409 command_id_conflict`. Admission is
capped at 64 pending commands or 1 MiB of pending command JSON and returns
`429 session_backpressure` when full. The settled deduplication ledger retains at most 1,024
entries. `session.interrupt` invokes the transport's interrupt operation and keeps the session
available when supported; it is not cancellation or close.

## Event history and replay

`SessionManager` buffers every session's emitted `AgentEventEnvelope`s in memory, capped at 5,000
events **or** 16 MiB of serialized envelopes per session (`MAX_STORED_EVENTS_PER_SESSION`,
`MAX_STORED_EVENT_BYTES_PER_SESSION`), whichever is hit first. A single normalized v1 envelope over
1 MiB (`MAX_LEGACY_EVENT_ENVELOPE_BYTES`) fails the whole session with a synthetic
`session.failed` rather than being buffered or streamed. Tool events are bounded upstream of that,
so ordinary tool output cannot trigger it; every other event type still can -- see
[protocol-v1.md](protocol-v1.md#ordering-guarantees) for the exact shape a truncated tool payload
arrives in. `GET /sessions/:id/events`:

1. Writes the standard `text/event-stream` headers, then an SSE `:ok` comment immediately.
2. Replays every buffered event from `sequence` 0 (or from `Last-Event-ID + 1`, if that header was
   sent) as `id: <sequence>\nevent: <type>\ndata: <json>\n\n` frames.
3. Keeps the connection open and streams new events live as they arrive.
4. Closes the response itself once a terminal event (`session.completed` / `session.failed` /
   `session.cancelled`) is written: the client never has to guess whether more events might still
   arrive.

Past the 5,000-event/16 MiB cap, further events are no longer available to replay to a _new_
subscriber. `sequence` is stamped from a counter independent of the history buffer's length, so it
keeps incrementing past the cap rather than resetting or gapping. The daemon logs a warning once
history stops growing, rather than growing memory unbounded. See
[protocol-v1.md#ordering-guarantees](protocol-v1.md#ordering-guarantees) for the full ordering
contract this upholds.

Live delivery to an already-connected subscriber is bounded too, by the same per-connection writer
v2 uses (`apps/daemon/src/sse-writer.ts`): each v1 SSE connection gets an independent 256-event /
4 MiB write queue (`apps/daemon/src/v1-sse-writer.ts`). A subscriber that falls behind past that
queue has its connection dropped and ended outright — v1 has no overflow frame to announce it
(unlike v2's `stream.error`/`stream_overflow` below), so a backpressured v1 client sees the
connection simply close, potentially before the terminal event. This is regression-tested in
`apps/daemon/test/session-manager.test.ts`.

Protocol v2 keeps a separate normalized replay window capped at 5,000 events or 16 MiB, evicting
oldest frames first. A resume cursor outside `[earliestSequence, nextSequence]` returns
`409 replay_gap`. Each connected v2 subscriber gets the same 256-event / 4 MiB write queue described
above. Backpressure on one connection cannot stall the provider or another subscriber. A terminal
event closes only after queued frames drain; subscriber overflow drops that connection's queue and
ends it with `stream.error` / `stream_overflow`, including the last sequence handed to the socket
when available.

## Session retention

Once a session reaches a terminal state, its runtime state (buffered event history, listener set)
isn't deleted immediately: a client that hasn't seen the terminal event yet still needs to
replay/receive it. But retaining every completed session forever would grow memory without bound
for a long-lived daemon whose client never calls `DELETE`, so `SessionManager` keeps only the most
recently completed 50 sessions' runtime state (`MAX_RETAINED_COMPLETED_RUNTIMES`), evicting the
oldest runtime once a 51st completes. For protocol v1, that eviction also deletes the compatibility
`AgentSession` record. Protocol v2's durable execution record/history follows the execution graph's
separate retention policy. This is a simple bound, not a cache-replacement policy. Calling
`DELETE /sessions/:id` removes a session immediately regardless of this cap and removes it from
retention tracking too.

`SessionManager.cancel()` also refuses to report success for a session that's already terminal
(see the routes table above), so a stale UI action against a long-finished session gets `404`, not
a misleading `202`.

This section covers only `SessionManager`'s in-memory runtime bound. The daemon's other durable
state -- the state directory's own POSIX permissions, the approval audit log's size/age rotation,
and staged attachments' quota/lineage/age cleanup -- is documented in
[capability-security-v2.md's retention table](capability-security-v2.md#persistence-retention-and-redaction),
which is the one place that table is kept, to avoid two docs drifting out of sync with each other.

## Cancellation and process-tree kill

`POST /sessions/:id/cancel` calls the session's runtime handle's `cancel()`, which kills the
provider CLI's whole process tree, not just the direct child, so a cancelled session can't leave
a grandchild process (e.g. a shell command the CLI itself launched) orphaned:

- **Windows**: the shipped Job Object host owns the provider tree with `KILL_ON_JOB_CLOSE`;
  cancellation terminates and reaps that host, which closes the job and its descendants
- **POSIX**: the child is spawned detached in its own process group; cancellation sends
  `SIGTERM` to the group, then `SIGKILL` after a short grace period and verifies the group is gone
  within the bounded termination window

See [SECURITY.md](../SECURITY.md#process-hygiene) for the verification split between the Windows
workflow, Linux CI, and unverified macOS behavior.
`DELETE /sessions/:id` cancels first (if the session is still `starting`/`running`) before removing
the record, so deleting a live session doesn't orphan its process either.

## Shutdown

On `SIGINT`/`SIGTERM`, the daemon (`apps/daemon/src/index.ts`): cancels every in-flight session and
waits (bounded, 16 seconds by default, covering interactive graceful-close and force-reap phases)
for their processes to actually exit (`SessionManager.cancelAll()`), closes every open MCP stdio
connection (`closeAllMcpConnections()`), closes the Fastify server (bounded: 5 seconds, then
`closeAllConnections()` plus a further 1-second bound), removes the discovery file, then exits.
This is idempotent: a second signal while shutdown is already in progress is a no-op. The bounded
wait means shutdown won't hang forever if teardown stalls. Legacy cancellation awaits the owned
process-tree termination/reap operation; the interactive supervisor performs its own bounded
graceful-close and hard-stop fallback. The outer shutdown bound also covers pending starts and
terminal event consumption.

**Windows limitation**: Node's `child.kill()` maps to `TerminateProcess` on Windows, which does not
deliver a real `SIGTERM` the daemon's own shutdown handler can catch, so when Electron kills the
daemon child process directly (e.g. on app quit), the daemon's own `cancelAll()` above never runs
at all on that platform. Electron compensates by calling `POST /sessions/cancel-all` over HTTP
_before_ killing the daemon child process (HTTP is a request Windows can deliver reliably, unlike
a signal to the daemon's own process), and separately cancels each tracked interactive v2 session.
This covers every session the desktop main process started, not just the one the current UI happens
to be displaying. See `killDaemon()` in `apps/desktop/electron/main.ts` and
[architecture.md#known-limitations](architecture.md#known-limitations) for what this does and
doesn't cover on POSIX. The daemon process itself has always been confirmed to exit alongside the
app in testing; what can be left behind is a stale discovery file, which is harmless, see
[Duplicate-start behavior](#duplicate-start-behavior) above.

## Logging

`packages/agent-runtime/src/logger.ts`'s `createConsoleLogger` writes structured JSON lines to
stdout/stderr. Set `AGENT_DOCK_LOG_LEVEL=debug` to see `debug`-level lines (default is `info`). Any
log metadata key matching `/token|secret|password|authorization|api[-_]?key|credential/i` is
redacted to `[redacted]` regardless of level, see [SECURITY.md](../SECURITY.md#what-the-daemon-will-never-do).
