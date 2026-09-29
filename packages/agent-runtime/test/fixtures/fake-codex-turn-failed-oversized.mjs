process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'x' }) + '\n');
process.stdout.write(
  JSON.stringify({
    type: 'turn.failed',
    // Control character embedded (issue #193's "treated as untrusted display text" -- same
    // handling as any other provider-controlled string reaching the wire) plus far more than the
    // 4 KiB display ceiling, both in one message.
    error: { message: `oversized\x07${'x'.repeat(10_000)}` },
  }) + '\n',
);
process.exitCode = 1;
