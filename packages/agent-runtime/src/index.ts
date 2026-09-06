// AD-09: this used to also re-export process/* internals, both providers' build-args, and both
// real providers' capabilities objects, none of which any consumer outside this package (or its
// own tests, which import them by relative path) actually used, and docs/protocol-v1.md already
// (incorrectly) claimed build-args was unexported. Trimmed to what apps/daemon genuinely needs,
// so the documented "internal" surface is actually internal rather than merely undocumented.
export * from './types.js';
export * from './logger.js';
// Re-exported per the same rule the note above states: apps/daemon genuinely needs it now.
// Pipenzo's publish service (issue #178) holds a GitHub PAT in the daemon process, so the `git`
// children it spawns must start from this default-deny floor rather than `{ ...process.env }` --
// the same guarantee provider subprocesses already get. Exporting it is what lets the daemon use
// the one reviewed allowlist instead of writing a second, drifting copy of it.
export * from './process/provider-environment.js';
export * from './registry.js';
export * from './providers/claude/index.js';
export * from './providers/codex/adapter.js';
export * from './providers/fake/adapter.js';
export * from './providers/compatibility-manifest.js';
export * from './providers/common/session-supervisor.js';
export * from './mcp-control.js';
export * from './component-control.js';
