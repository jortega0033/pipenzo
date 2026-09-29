process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'x' }) + '\n');
process.stdout.write(
  JSON.stringify({
    type: 'turn.failed',
    error: {
      message:
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 8th, 2026 10:08 AM.",
    },
  }) + '\n',
);
process.exitCode = 1;
