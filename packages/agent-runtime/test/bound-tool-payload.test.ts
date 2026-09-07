import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agent-dock/shared';
import {
  MAX_TOOL_EVENT_BYTES,
  boundToolEventPayload,
} from '../src/providers/common/bound-tool-payload.js';

/**
 * Issue #185. The daemon's 1 MiB v1 envelope ceiling fails the whole session rather than dropping
 * a frame (issue #51), so the bounding has to happen before an event reaches it -- on every
 * provider-controlled field, and only on events where shortening one is harmless.
 */

const DAEMON_ENVELOPE_CEILING = 1024 * 1024;

function eventBytes(event: AgentEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8');
}

describe('boundToolEventPayload', () => {
  // docs/protocol-v1.md states 256 KiB as the threshold. Pinned so the constant and the documented
  // contract cannot drift apart silently.
  it('bounds tool events at the 256 KiB the docs promise', () => {
    expect(MAX_TOOL_EVENT_BYTES).toBe(256 * 1024);
  });

  it('passes an ordinary tool.completed through as the same object reference', () => {
    const event: AgentEvent = {
      type: 'tool.completed',
      toolName: 'shell',
      toolCallId: 'item_0',
      result: { command: 'echo hi', output: 'hi\n', exitCode: 0 },
      isError: false,
    };
    expect(boundToolEventPayload(event)).toBe(event);
  });

  it('passes a tool.started with no input through untouched', () => {
    const event: AgentEvent = { type: 'tool.started', toolName: 'shell' };
    expect(boundToolEventPayload(event)).toBe(event);
  });

  // Pins the limit itself. Without this, flipping `<=` to `<` -- or getting the constant wrong --
  // goes undetected by every other test here, all of which sit far from the boundary.
  it('leaves an event of exactly the limit alone and bounds the very next byte', () => {
    const build = (padding: number): AgentEvent => ({
      type: 'tool.completed',
      toolName: 'shell',
      result: { output: 'y'.repeat(padding) },
    });
    // Binary-search-free: the payload is plain ASCII, so one byte of padding is one byte of event.
    const overhead = eventBytes(build(0));
    const exact = build(MAX_TOOL_EVENT_BYTES - overhead);
    expect(eventBytes(exact)).toBe(MAX_TOOL_EVENT_BYTES);
    expect(boundToolEventPayload(exact)).toBe(exact);

    const oneOver = build(MAX_TOOL_EVENT_BYTES - overhead + 1);
    expect(eventBytes(oneOver)).toBe(MAX_TOOL_EVENT_BYTES + 1);
    expect(boundToolEventPayload(oneOver)).not.toBe(oneOver);
  });

  it('replaces an oversized tool.completed result with a marker that names what was dropped', () => {
    const event: AgentEvent = {
      type: 'tool.completed',
      toolName: 'shell',
      toolCallId: 'item_0',
      result: { command: 'git log', output: 'x'.repeat(DAEMON_ENVELOPE_CEILING), exitCode: 0 },
      isError: false,
    };

    const bounded = boundToolEventPayload(event);
    expect(bounded.type).toBe('tool.completed');
    if (bounded.type !== 'tool.completed') throw new Error('unreachable');

    // Everything the daemon actually reads off the event survives.
    expect(bounded.toolName).toBe('shell');
    expect(bounded.toolCallId).toBe('item_0');
    expect(bounded.isError).toBe(false);

    const marker = bounded.result as Record<string, unknown>;
    expect(marker.truncated).toBe(true);
    expect(marker.reason).toBe('oversized_provider_payload');

    const serialized = Buffer.from(JSON.stringify(event.result), 'utf8');
    expect(marker.originalBytes).toBe(serialized.byteLength);
    expect(marker.sha256).toBe(createHash('sha256').update(serialized).digest('hex'));

    expect(eventBytes(bounded)).toBeLessThan(DAEMON_ENVELOPE_CEILING);
  });

  it('replaces an oversized tool.started input', () => {
    const event: AgentEvent = {
      type: 'tool.started',
      toolName: 'shell',
      input: { command: 'x'.repeat(DAEMON_ENVELOPE_CEILING) },
    };
    const bounded = boundToolEventPayload(event);
    if (bounded.type !== 'tool.started') throw new Error('unreachable');
    expect((bounded.input as Record<string, unknown>).truncated).toBe(true);
    expect(bounded.toolName).toBe('shell');
    expect(eventBytes(bounded)).toBeLessThan(DAEMON_ENVELOPE_CEILING);
  });

  // The half a payload-only fix would have missed: `toolCallId` comes from `item.id` / `b.id` and
  // `toolName` from a third-party MCP server's `item.tool`, both unbounded in the legacy parsers.
  it('bounds a tool call id large enough to blow the ceiling on its own', () => {
    const event: AgentEvent = {
      type: 'tool.completed',
      toolName: 'shell',
      toolCallId: 'i'.repeat(DAEMON_ENVELOPE_CEILING),
      result: { output: 'ok\n' },
    };
    const bounded = boundToolEventPayload(event);
    if (bounded.type !== 'tool.completed') throw new Error('unreachable');
    expect(Buffer.byteLength(bounded.toolCallId ?? '', 'utf8')).toBeLessThanOrEqual(256);
    expect(eventBytes(bounded)).toBeLessThan(DAEMON_ENVELOPE_CEILING);
  });

  it('bounds an oversized MCP tool name', () => {
    const event: AgentEvent = {
      type: 'tool.started',
      toolName: 'm'.repeat(DAEMON_ENVELOPE_CEILING),
      input: { a: 1 },
    };
    const bounded = boundToolEventPayload(event);
    if (bounded.type !== 'tool.started') throw new Error('unreachable');
    expect(Buffer.byteLength(bounded.toolName, 'utf8')).toBeLessThanOrEqual(256);
    expect(eventBytes(bounded)).toBeLessThan(DAEMON_ENVELOPE_CEILING);
  });

  // `claude/parser.ts` emits `tool.completed` with no `toolName` at all -- the field is optional on
  // that variant, unlike on `tool.started`. Bounding identifiers unconditionally has to survive
  // that, or every Claude tool result throws on the way through and fails the session.
  it('handles a tool.completed that carries no toolName', () => {
    const event: AgentEvent = {
      type: 'tool.completed',
      toolCallId: 'toolu_01',
      result: { content: 'ok' },
      isError: false,
    };
    expect(() => boundToolEventPayload(event)).not.toThrow();
    expect(boundToolEventPayload(event)).toBe(event);

    const oversized: AgentEvent = {
      type: 'tool.completed',
      toolCallId: 'toolu_01',
      result: { content: 'x'.repeat(DAEMON_ENVELOPE_CEILING) },
    };
    const bounded = boundToolEventPayload(oversized);
    if (bounded.type !== 'tool.completed') throw new Error('unreachable');
    expect(bounded.toolName).toBeUndefined();
    expect((bounded.result as Record<string, unknown>).truncated).toBe(true);
  });

  // An absent payload is not a failed one. `codex/parser.ts` leaves `input`/`result` undefined for
  // an MCP call that carried neither, and `claude/parser.ts`'s `result: b.content` is optional, so
  // an event can take the bounded path (here, for its id) with nothing to truncate. Marking that
  // `provider_payload_not_json` would report a serialization failure that never happened.
  it('leaves an absent payload absent instead of inventing a truncation marker', () => {
    const started: AgentEvent = {
      type: 'tool.started',
      toolName: 'mcp_tool',
      toolCallId: 'i'.repeat(DAEMON_ENVELOPE_CEILING),
    };
    const boundedStart = boundToolEventPayload(started);
    if (boundedStart.type !== 'tool.started') throw new Error('unreachable');
    expect(boundedStart.input).toBeUndefined();

    const completed: AgentEvent = {
      type: 'tool.completed',
      toolName: 'mcp_tool',
      toolCallId: 'i'.repeat(DAEMON_ENVELOPE_CEILING),
    };
    const boundedComplete = boundToolEventPayload(completed);
    if (boundedComplete.type !== 'tool.completed') throw new Error('unreachable');
    expect(boundedComplete.result).toBeUndefined();
  });

  // The UI correlates legacy tool-lifecycle items by `toolCallId`
  // (`apps/desktop/src/components/activity/model.ts`), so the same id has to survive the same way
  // on both halves of a pair -- even when only one half carries a payload big enough to be bounded.
  it('bounds a tool call id the same way whether or not the rest of the event is oversized', () => {
    const id = `call_${'i'.repeat(400)}`;
    const started: AgentEvent = { type: 'tool.started', toolName: 'shell', toolCallId: id };
    const completed: AgentEvent = {
      type: 'tool.completed',
      toolName: 'shell',
      toolCallId: id,
      result: { output: 'x'.repeat(DAEMON_ENVELOPE_CEILING) },
    };

    const boundedStart = boundToolEventPayload(started);
    const boundedComplete = boundToolEventPayload(completed);
    if (boundedStart.type !== 'tool.started') throw new Error('unreachable');
    if (boundedComplete.type !== 'tool.completed') throw new Error('unreachable');

    expect(boundedStart.toolCallId).toBe(boundedComplete.toolCallId);
    expect(boundedStart.toolCallId).not.toBe(id);
    expect(Buffer.byteLength(boundedStart.toolCallId ?? '', 'utf8')).toBeLessThanOrEqual(256);
    // The small event keeps its payload: bounding the id is not a licence to truncate content.
    expect(boundedStart.input).toBeUndefined();
  });

  it('keeps a bounded, valid-UTF-8 head of what it dropped', () => {
    const event: AgentEvent = {
      type: 'tool.completed',
      toolName: 'shell',
      // Multi-byte characters, so a naive byte slice would cut one in half.
      result: { output: 'é'.repeat(MAX_TOOL_EVENT_BYTES) },
    };
    const bounded = boundToolEventPayload(event);
    if (bounded.type !== 'tool.completed') throw new Error('unreachable');
    const preview = (bounded.result as Record<string, unknown>).preview;
    expect(typeof preview).toBe('string');
    expect(preview as string).not.toContain('�');
    expect(Buffer.byteLength(preview as string, 'utf8')).toBeLessThanOrEqual(8 * 1024);
  });

  it('replaces a payload that cannot be serialized at all, rather than throwing downstream', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const event: AgentEvent = { type: 'tool.completed', toolName: 'shell', result: cyclic };

    const bounded = boundToolEventPayload(event);
    if (bounded.type !== 'tool.completed') throw new Error('unreachable');
    expect((bounded.result as Record<string, unknown>).reason).toBe('provider_payload_not_json');
    expect(() => JSON.stringify(bounded)).not.toThrow();
  });

  it.each([
    // assistant.message carries the Refine spec JSON: shortening it would turn a loud failure into
    // a corrupted phase result, so it is deliberately left for the daemon's ceiling to reject.
    { type: 'assistant.message', text: 'x'.repeat(DAEMON_ENVELOPE_CEILING) },
    { type: 'thinking.delta', text: 'x'.repeat(DAEMON_ENVELOPE_CEILING) },
    { type: 'error', message: 'x'.repeat(DAEMON_ENVELOPE_CEILING), recoverable: false },
  ] as AgentEvent[])('never touches a $type event', (event) => {
    expect(boundToolEventPayload(event)).toBe(event);
  });
});
