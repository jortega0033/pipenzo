import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  PIPENZO_AUDIT_SCHEMA_VERSION,
  pipenzoAuditEntryV1Schema,
  type NewPipenzoAuditEntryV1,
  type PipenzoAuditEntryV1,
} from '@agent-dock/shared';
import { ensureStateDirectory } from './state-directory.js';

/**
 * Pipenzo's own append-only audit log (issue #149): JSONL, fsync-before-return,
 * sequence-validated on load -- the same durability shape `audit-store.ts`'s `AuditStore` gives
 * agentdock's inherited permission-approval log, for the same reason (a single-writer daemon
 * process, a crash that must never silently drop or corrupt an already-acknowledged entry). What
 * is shared is the *problem*, not the schema -- see `pipenzo-audit-v1.ts` for why this store's
 * entries are Pipenzo's own, versioned separately from `AuditEntryV2`.
 *
 * ## What is deliberately simpler here than in `AuditStore`
 *
 * No segment rotation or age-based pruning (`AuditStore`'s issue #67). That log grows on *every*
 * permission decision a session makes; this one grows on a lane/label divergence, which is rare by
 * construction (see the reconciler's call site), plus whatever #160/#269 add later, both still
 * bounded by how often a ticket is published or gated -- orders of magnitude less often than a
 * tool call. If growth ever becomes a real concern, rotation can be added here the same way #67
 * added it there; it is not a reason to hold up #149 for a problem this log does not have yet.
 */

const MAX_AUDIT_FILE_BYTES = 64 * 1024 * 1024;

export class PipenzoAuditStoreCorruptError extends Error {
  constructor(message = 'pipenzo audit store is corrupt') {
    super(message);
    this.name = 'PipenzoAuditStoreCorruptError';
  }
}

export interface PipenzoAuditStoreDependencies {
  now?: () => number;
  randomEntryId?: () => string;
}

/** Fsyncs a directory so a newly-created file's entry survives a crash. Best-effort on Windows,
 * matching `audit-store.ts`'s `syncParentDirectory`: Node cannot fsync a directory handle there. */
async function syncParentDirectory(directory: string): Promise<void> {
  try {
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== 'win32' ||
      (code !== 'EPERM' && code !== 'EACCES' && code !== 'EINVAL')
    ) {
      throw error;
    }
  }
}

export class PipenzoAuditStore {
  private entries: PipenzoAuditEntryV1[] | undefined;
  private initializePromise: Promise<void> | undefined;
  private writeTail: Promise<void> = Promise.resolve();
  private unhealthy = false;
  private readonly now: () => number;
  private readonly randomEntryId: () => string;

  constructor(
    private readonly filePath: string,
    dependencies: PipenzoAuditStoreDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => Date.now());
    this.randomEntryId = dependencies.randomEntryId ?? randomUUID;
  }

  /** Appends one entry, assigning its `sequence`/`entryId`/`recordedAt`. Serialized against every
   * other append and read on this store, so entries land in the order this was called. */
  append(input: NewPipenzoAuditEntryV1): Promise<PipenzoAuditEntryV1> {
    const operation = this.writeTail.then(async () => {
      await this.initialize();
      if (this.unhealthy) {
        throw new PipenzoAuditStoreCorruptError('pipenzo audit store is unhealthy');
      }
      const entry = pipenzoAuditEntryV1Schema.parse({
        ...input,
        schemaVersion: PIPENZO_AUDIT_SCHEMA_VERSION,
        sequence: this.entries?.length ?? 0,
        entryId: this.randomEntryId(),
        recordedAt: this.now(),
      });
      const line = `${JSON.stringify(entry)}\n`;
      if (Buffer.byteLength(line) > MAX_AUDIT_FILE_BYTES) {
        throw new Error('a single pipenzo audit entry exceeds the audit file size cap');
      }
      await ensureStateDirectory(dirname(this.filePath));
      const handle = await open(
        this.filePath,
        fsConstants.O_WRONLY |
          fsConstants.O_APPEND |
          fsConstants.O_CREAT |
          (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0),
        0o600,
      );
      try {
        await handle.writeFile(line, 'utf8');
        await handle.sync();
      } catch (error) {
        this.unhealthy = true;
        throw error;
      } finally {
        await handle.close().catch(() => undefined);
      }
      try {
        await syncParentDirectory(dirname(this.filePath));
      } catch (error) {
        this.unhealthy = true;
        throw error;
      }
      this.entries?.push(entry);
      return entry;
    });
    this.writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /** Every stored entry, oldest first, optionally scoped to one ticket. No cursor pagination --
   * nothing reads this store over the wire yet, and a route can add one when it exists to page. */
  async list(options: { ticketId?: string } = {}): Promise<PipenzoAuditEntryV1[]> {
    await this.writeTail;
    await this.initialize();
    if (this.unhealthy) {
      throw new PipenzoAuditStoreCorruptError('pipenzo audit store is unhealthy');
    }
    const source = this.entries ?? [];
    return options.ticketId === undefined
      ? [...source]
      : source.filter((entry) => entry.ticketId === options.ticketId);
  }

  private async initialize(): Promise<void> {
    if (this.entries) return;
    if (!this.initializePromise) {
      this.initializePromise = this.load().catch((error: unknown) => {
        this.unhealthy = true;
        throw error;
      });
    }
    await this.initializePromise;
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      const details = await stat(this.filePath);
      if (details.size > MAX_AUDIT_FILE_BYTES) throw new PipenzoAuditStoreCorruptError();
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries = [];
        return;
      }
      throw error;
    }
    const lines = raw.length === 0 ? [] : raw.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const entries: PipenzoAuditEntryV1[] = [];
    try {
      for (const [sequence, line] of lines.entries()) {
        if (!line) throw new Error('blank pipenzo audit record');
        const entry = pipenzoAuditEntryV1Schema.parse(JSON.parse(line));
        if (entry.sequence !== sequence) throw new Error('non-contiguous pipenzo audit sequence');
        entries.push(entry);
      }
    } catch {
      throw new PipenzoAuditStoreCorruptError();
    }
    this.entries = entries;
  }
}
