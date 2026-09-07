// Simulates `codex exec --json ...` where one shell command produced more output than the
// daemon's 1 MiB v1 envelope ceiling allows -- the exact shape observed live on issue #78, where a
// single `tool.completed` measured 1,093,186 bytes and killed the whole Refine session (#185).
//
// Sized past 1 MiB on purpose, not merely past the 256 KiB tool cap: an unbounded event has to
// actually exceed the daemon's envelope ceiling for the test's "every envelope now fits" assertion
// to mean anything. At 600 KiB it passed with the fix removed.
const oversized = 'x'.repeat(1200 * 1024);

// A tool call id, unbounded in both legacy parsers, reaches the same ceiling on its own. This item
// carries a tiny output and a huge id, so it fails exactly the same way if only the payload is
// bounded.
const oversizedId = 'i'.repeat(1200 * 1024);

const events = [
  { type: 'thread.started', thread_id: 'codex-oversized-thread-id' },
  { type: 'turn.started' },
  {
    type: 'item.started',
    item: { id: 'item_0', type: 'command_execution', command: 'git log', status: 'in_progress' },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item_0',
      type: 'command_execution',
      command: 'git log',
      aggregated_output: oversized,
      exit_code: 0,
      status: 'completed',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: oversizedId,
      type: 'command_execution',
      command: 'echo ok',
      aggregated_output: 'ok\n',
      exit_code: 0,
      status: 'completed',
    },
  },
  // The session must keep going past the oversized frames and still deliver its real answer.
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'done anyway' } },
  { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 6 } },
];

for (const event of events) {
  process.stdout.write(JSON.stringify(event) + '\n');
}
