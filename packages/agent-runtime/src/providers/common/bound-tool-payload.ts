import { createHash } from 'node:crypto';
import type { AgentEvent } from '@agent-dock/shared';
import { boundedUtf8 } from './safe-display.js';

/**
 * Bounds legacy (v1) tool events, which are the one place a provider puts unbounded content on an
 * event the daemon has to deliver whole (issue #185).
 *
 * The daemon refuses to deliver a v1 envelope over `MAX_LEGACY_EVENT_ENVELOPE_BYTES` (1 MiB,
 * `apps/daemon/src/session-manager.ts`) and, per issue #51, fails the whole session rather than
 * silently discarding provider content. That ceiling is worth keeping. The problem it hit in
 * practice is that neither legacy parser bounded what it copied onto a tool event, so an ordinary
 * shell command with a megabyte of output -- a `git log`, a wide `grep`, one large lockfile --
 * killed an entire Refine run. Reproduced live against this repository's own issue #78 on codex
 * 0.153.4: a single `tool.completed` measured 1,093,186 bytes.
 *
 * ## Measured whole, not field by field
 *
 * The size check is on the serialized event, not on one chosen field, because more than one field
 * is provider-controlled and unbounded. Besides the obvious payload, `toolCallId` comes straight
 * from `item.id` (`codex/parser.ts`) / `b.id` (`claude/parser.ts`) with no length check, and
 * `toolName` for an MCP call comes from `item.tool` -- a name chosen by a third-party MCP server,
 * not by the provider CLI. A version of this that bounded only the payload would leave the
 * identical session-kill reachable through a 1.2 MiB tool call id.
 *
 * Whatever fields a future adapter adds are inside that measurement from the day they are added,
 * rather than needing to be remembered here.
 *
 * ## Identifiers are bounded unconditionally
 *
 * `toolName` and `toolCallId` are capped before the size check, not as part of the rebuild, so a
 * given id maps to the same value on every event that carries it. Bounding them only on events
 * that happened to be oversized would truncate a `toolCallId` on a `tool.completed` with a large
 * result while passing the identical id through whole on its paired `tool.started`, breaking the
 * id-based correlation the UI does in `apps/desktop/src/components/activity/model.ts`.
 *
 * ## Why only tool events
 *
 * `tool.started`'s `input` and `tool.completed`'s `result` are display-only observation content.
 * The daemon reads `toolName` off these events (Refine's `toolsUsed`, the read-only allowlist
 * check) and nothing else; Review reads its diff from git, never from a tool event. Truncating them
 * costs the operator some of a transcript and costs the product nothing.
 *
 * Every other event is left exactly as the parser produced it. `assistant.message` in particular
 * must never be truncated here: `pipenzo-phase-sessions.ts` accumulates its `text` and parses the
 * Refine spec out of it, so shortening it would turn a loud failure into a corrupted phase result.
 * An assistant message that genuinely exceeds the ceiling still fails the session, which is the
 * correct outcome.
 *
 * ## Not a silent drop
 *
 * Issue #51's rule holds: the replacement says it is a replacement, and carries the original byte
 * count and a SHA-256 of the exact bytes that were dropped. The marker is in-band and therefore
 * forgeable by a provider that emits the same shape under the size limit; nothing in the daemon
 * branches on it, so the consequence is bounded to a misleading transcript.
 */

/**
 * The whole serialized event, not just its payload. Matches the v2 interactive path's
 * `MAX_CONTENT_BLOCK_BYTES` (`session-supervisor.ts`) as a round number that is comfortably under
 * the 1 MiB envelope ceiling and generous for a transcript; the two are not mechanically coupled,
 * and neither needs the other to move if it changes.
 */
export const MAX_TOOL_EVENT_BYTES = 256 * 1024;

/**
 * `toolName` and `toolCallId` are identifiers, not content. The narrowest downstream consumer of a
 * v1 `toolName` is Refine's `toolsUsed`, capped at 128 *characters* per entry
 * (`packages/shared/src/pipenzo-phase-v1.ts`), so this cap does not by itself guarantee that array
 * validates -- it guarantees an identifier cannot carry a megabyte, which is what issue #185 is
 * about. A name long enough to matter to `toolsUsed` was already failing that check before this.
 */
const MAX_TOOL_IDENTIFIER_BYTES = 256;

/**
 * A head of the dropped content, kept because the point of a tool transcript is being able to see
 * what the command did. It lands in exactly one place: the in-memory replay buffer and the SSE
 * stream in `apps/daemon/src/session-manager.ts`. v1 tool events are never written to disk --
 * `session-store.ts` persists the session record without its event history, and `audit-store.ts`
 * records approval decisions only -- so this reaches no sink that an ordinary under-limit tool
 * payload does not already reach, at 8 KiB against that one's 256 KiB.
 */
const PAYLOAD_PREVIEW_BYTES = 8 * 1024;

export interface TruncatedToolPayload {
  readonly truncated: true;
  readonly reason: 'oversized_provider_payload' | 'provider_payload_not_json';
  /** UTF-8 bytes of the JSON serialization that was replaced; 0 when it could not be serialized. */
  readonly originalBytes: number;
  readonly sha256?: string;
  readonly preview?: string;
}

/** `JSON.stringify` that reports failure instead of throwing. */
function serialize(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function truncatedPayload(value: unknown): TruncatedToolPayload {
  const serialized = serialize(value);
  if (serialized === undefined) {
    // Reachable only for a value `JSON.stringify` genuinely refuses -- a cycle, a BigInt, a
    // function. An absent `input`/`result` never gets here: the call sites below only build a
    // marker for a field that was actually present, so an absent field is not mislabelled as a
    // serialization failure. Letting this throw instead would surface as a generic ADAPTER_CRASH
    // that says nothing about what happened.
    return { truncated: true, reason: 'provider_payload_not_json', originalBytes: 0 };
  }
  const encoded = Buffer.from(serialized, 'utf8');
  return {
    truncated: true,
    reason: 'oversized_provider_payload',
    originalBytes: encoded.byteLength,
    sha256: createHash('sha256').update(encoded).digest('hex'),
    preview: boundedUtf8(serialized, PAYLOAD_PREVIEW_BYTES),
  };
}

function boundIdentifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return boundedUtf8(value, MAX_TOOL_IDENTIFIER_BYTES);
}

/**
 * Passes every event through untouched -- the same object reference, so nothing is rebuilt --
 * except a `tool.started` / `tool.completed` that is either over `MAX_TOOL_EVENT_BYTES` serialized
 * or carrying an over-long identifier. That one is rebuilt with its identifiers bounded and its
 * payload, if it had one, replaced by an explicit truncation marker.
 */
export function boundToolEventPayload(event: AgentEvent): AgentEvent {
  if (event.type !== 'tool.started' && event.type !== 'tool.completed') return event;

  // Unconditionally, before the size check: see "Identifiers are bounded unconditionally" above.
  // Both go through the undefined-tolerant helper because `tool.completed.toolName` is optional
  // and `claude/parser.ts` omits it outright. `boundedUtf8` returns the original string when it
  // already fits, so the identity comparisons below are the cheap way to ask whether anything
  // actually changed.
  const toolName = boundIdentifier(event.toolName);
  const toolCallId = boundIdentifier(event.toolCallId);

  // One measurement on the fast path, with no *second* Buffer copy on top of the string
  // `JSON.stringify` already builds: the daemon serializes this event again anyway, and paying for
  // a full Buffer copy of every tool payload here would be worse than the problem. An event that
  // cannot be serialized at all takes the bounded path, where the failure can still be described.
  if (toolName === event.toolName && toolCallId === event.toolCallId) {
    const serialized = serialize(event);
    if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= MAX_TOOL_EVENT_BYTES) {
      return event;
    }
  }

  // Rebuilt field by field rather than spread, so the result is bounded by construction: every
  // field it can carry is either a literal, an identifier capped at 256 bytes, a boolean, or the
  // ~8 KiB marker. Nothing a future parser hangs off the event can ride along unmeasured, which is
  // the whole reason the fast path above measures the event rather than one field of it.
  if (event.type === 'tool.started') {
    return {
      type: 'tool.started',
      // Required on `tool.started`, so this is the bounded string; the `??` only satisfies the
      // helper's `tool.completed`-driven `string | undefined` return.
      toolName: toolName ?? event.toolName,
      toolCallId,
      // Only a payload that was actually present gets a marker: fabricating one for an absent
      // field would label "the parser never set this" as "the provider sent something unreadable".
      input: event.input === undefined ? undefined : truncatedPayload(event.input),
    };
  }
  return {
    type: 'tool.completed',
    toolName,
    toolCallId,
    result: event.result === undefined ? undefined : truncatedPayload(event.result),
    isError: event.isError,
  };
}
