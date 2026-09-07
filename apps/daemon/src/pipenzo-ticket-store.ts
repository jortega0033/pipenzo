import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  pipenzoTicketIdV1Schema,
  pipenzoTicketRecordV1Schema,
  type PipenzoTicketRecordV1,
} from '@agent-dock/shared';
import {
  atomicWriteJson,
  ensurePrivateDirectory,
  ensurePrivateFile,
  errorCode,
  isObject,
  syncDirectory,
} from './session-store.js';

/**
 * Where `FileTicketStore` keeps `PipenzoTicketRecordV1` records (Pipenzo issue #187).
 *
 * Follows `apps/daemon/src/session-store.ts`'s `FileSessionStore` deliberately closely — same
 * `records/` + `manifest.json` + `quarantine/` layout, the same atomic-write and fsync primitives
 * (imported from there rather than re-derived, so a future Windows-fsync fix only has to happen
 * once), the same `0o600`/`0o700` mode enforcement, and the same fail-closed reaction to a manifest
 * or record from a schema version newer than this build understands.
 *
 * **What is deliberately simpler here than in `FileSessionStore`, and why.** `FileSessionStore`
 * carries real v0-to-v1 migration logic and marks sessions `starting`/`running` at crash time
 * `failed`, because sessions have existed since before the store had a `schemaVersion` at all and
 * because a session is a live process with a status that can be mid-flight when the daemon dies.
 * Neither is true of tickets: this store starts life at `schemaVersion: 1` with no earlier format
 * to carry forward (the rename-on-bump path a future version bump will need is #162, explicitly out
 * of this ticket's scope), and a `PipenzoTicketRecordV1` has no in-flight execution status of its
 * own to mark interrupted (mapping a crashed session back onto its ticket and moving the ticket to
 * `pipenzo:interrupted` is #190). So this store only builds the two things #187 actually asks for:
 * durable, atomic, tamper-evident persistence, and a manifest that refuses to be silently
 * overwritten by a version newer than this code understands.
 */

export const TICKET_STORE_SCHEMA_VERSION = 1 as const;

const MANIFEST_FILE = 'manifest.json';
const RECORDS_DIRECTORY = 'records';
const QUARANTINE_DIRECTORY = 'quarantine';

interface TicketStoreManifestV1 {
  schemaVersion: typeof TICKET_STORE_SCHEMA_VERSION;
}

interface PreflightTicketRecord {
  path: string;
  ticket?: PipenzoTicketRecordV1;
  quarantineReason?: string;
}

interface PreflightManifest {
  action: TicketStoreManifestAction;
  quarantineReason?: string;
}

export interface QuarantinedTicketStoreFile {
  originalPath: string;
  quarantinePath: string;
  reason: string;
  bytes: number;
}

/**
 * Narrower than `SessionStoreManifestAction`: no `'migrated'`. There is no pre-v1 ticket manifest
 * format for a `'migrated'` outcome to describe — a manifest that isn't `'none'`/`'created'` and
 * isn't parseable as schema version 1 is simply corrupt, and `'rebuilt'` already says that.
 */
export type TicketStoreManifestAction = 'none' | 'created' | 'rebuilt';

/**
 * Same shape as `SessionStoreRecoveryReport` (issue #187 asks for that explicitly), field-for-field
 * where the concept transfers and documented as always-trivial where it does not yet apply — see
 * `migratedRecordCount` and `interruptedTicketIds` below. Keeping the same shape now, even with two
 * fields that cannot fire yet, means the day #162 (migration) or #190 (crash recovery) lands, the
 * code that already logs `sessionStore.getRecoveryReport()` and this report side by side (see
 * `index.ts`) does not need to change shape to start reading real values out of them.
 */
export interface TicketStoreRecoveryReport {
  schemaVersion: typeof TICKET_STORE_SCHEMA_VERSION;
  manifestAction: TicketStoreManifestAction;
  loadedTicketCount: number;
  /**
   * Always `0` today. `FileSessionStore`'s equivalent counts v0-to-v1 record rewrites; this store
   * was born at v1 with nothing earlier to rewrite from, and the rename-on-bump path that will
   * someday need this number is #162.
   */
  migratedRecordCount: number;
  /**
   * Always `[]` today. Deciding that a session was interrupted and mapping it onto the ticket it
   * belonged to is #190's job, not this store's — this store only knows about torn *writes*
   * (handled by `quarantinedFiles` below), never about which session a ticket was waiting on.
   */
  interruptedTicketIds: string[];
  quarantinedFiles: QuarantinedTicketStoreFile[];
}

/**
 * Thrown instead of rewriting data created by a newer Pipenzo build. Mirrors
 * `UnsupportedSessionStoreVersionError` exactly, down to the reasoning: an unknown future version
 * is not corruption, and must survive untouched so rollback and mixed-version operation stay safe.
 */
export class UnsupportedTicketStoreVersionError extends Error {
  constructor(
    readonly version: number,
    readonly path: string,
  ) {
    super(`ticket store schema version ${version} is newer than supported version ${TICKET_STORE_SCHEMA_VERSION}`);
    this.name = 'UnsupportedTicketStoreVersionError';
  }
}

function recordFileName(ticketId: string): string {
  const parsed = pipenzoTicketIdV1Schema.safeParse(ticketId);
  if (!parsed.success) throw new Error('ticket id must be a UUID');
  return `${parsed.data}.json`;
}

function parseTicket(value: unknown): PipenzoTicketRecordV1 {
  const parsed = pipenzoTicketRecordV1Schema.safeParse(value);
  if (!parsed.success) throw new Error('invalid ticket record');
  return parsed.data;
}

function assertTemporarySchemaSupported(path: string): void {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (
      isObject(value) &&
      typeof value.schemaVersion === 'number' &&
      value.schemaVersion > TICKET_STORE_SCHEMA_VERSION
    ) {
      throw new UnsupportedTicketStoreVersionError(value.schemaVersion, path);
    }
  } catch (error) {
    if (error instanceof UnsupportedTicketStoreVersionError) throw error;
    // Torn/invalid temporary files are ordinary interrupted writes and are quarantined later.
  }
}

function parseStoredTicket(value: unknown, path: string): PipenzoTicketRecordV1 {
  if (!isObject(value)) throw new Error('invalid ticket record file');
  const version = value.schemaVersion;
  if (typeof version === 'number' && version > TICKET_STORE_SCHEMA_VERSION) {
    throw new UnsupportedTicketStoreVersionError(version, path);
  }
  return parseTicket(value);
}

/**
 * Synchronous, crash-safe filesystem implementation of the ticket store.
 *
 * `directory` is the store-owned state subdirectory (`<state>/tickets-v1`, wired in `index.ts`).
 * The phase machine that decides *when* to call `create`/`update` — and what a ticket's `lane` and
 * `phase` should become in response to a GitHub event or a completed session — is #188; this class
 * only has to make sure that whatever it is told to persist survives a crash mid-write and refuses
 * to guess at a record it does not understand.
 */
export class FileTicketStore {
  private readonly tickets = new Map<string, PipenzoTicketRecordV1>();
  private readonly recordsDirectory: string;
  private readonly quarantineDirectory: string;
  private readonly manifestPath: string;
  private report: TicketStoreRecoveryReport = {
    schemaVersion: TICKET_STORE_SCHEMA_VERSION,
    manifestAction: 'none',
    loadedTicketCount: 0,
    migratedRecordCount: 0,
    interruptedTicketIds: [],
    quarantinedFiles: [],
  };

  constructor(readonly directory: string) {
    this.recordsDirectory = join(directory, RECORDS_DIRECTORY);
    this.quarantineDirectory = join(directory, QUARANTINE_DIRECTORY);
    this.manifestPath = join(directory, MANIFEST_FILE);
    this.load();
  }

  create(ticket: PipenzoTicketRecordV1): void {
    const validated = parseTicket(ticket);
    this.persist(validated);
    this.tickets.set(validated.ticketId, validated);
  }

  get(ticketId: string): PipenzoTicketRecordV1 | undefined {
    return this.tickets.get(ticketId);
  }

  update(ticketId: string, ticket: PipenzoTicketRecordV1): void {
    const validated = parseTicket(ticket);
    if (validated.ticketId !== ticketId) {
      throw new Error('ticket update id does not match record id');
    }
    if (!this.tickets.has(ticketId)) {
      throw new Error(`cannot update unknown ticket: ${ticketId}`);
    }
    this.persist(validated);
    this.tickets.set(ticketId, validated);
  }

  delete(ticketId: string): void {
    let fileName: string;
    try {
      fileName = recordFileName(ticketId);
    } catch {
      this.tickets.delete(ticketId);
      return;
    }
    const path = join(this.recordsDirectory, fileName);
    try {
      unlinkSync(path);
      syncDirectory(this.recordsDirectory);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    this.tickets.delete(ticketId);
  }

  list(): PipenzoTicketRecordV1[] {
    return [...this.tickets.values()];
  }

  getRecoveryReport(): TicketStoreRecoveryReport {
    return {
      ...this.report,
      interruptedTicketIds: [...this.report.interruptedTicketIds],
      quarantinedFiles: this.report.quarantinedFiles.map((entry) => ({ ...entry })),
    };
  }

  private persist(ticket: PipenzoTicketRecordV1): void {
    atomicWriteJson(join(this.recordsDirectory, recordFileName(ticket.ticketId)), ticket);
  }

  private load(): void {
    ensurePrivateDirectory(this.directory);
    ensurePrivateDirectory(this.recordsDirectory);
    ensurePrivateDirectory(this.quarantineDirectory);

    // Read-only pass first, exactly as `FileSessionStore` does: an older daemon must discover a
    // record from a future schema before it quarantines anything, so a newer daemon that opens the
    // same directory later finds the store exactly as it was left.
    const rootTemporaryPaths = this.preflightRootTemporaryFiles();
    const manifest = this.preflightManifest();
    const records = this.preflightRecords();
    for (const path of rootTemporaryPaths) this.quarantine(path, 'interrupted atomic write');
    if (manifest.quarantineReason !== undefined) {
      this.quarantine(this.manifestPath, manifest.quarantineReason);
    } else if (manifest.action === 'none') {
      ensurePrivateFile(this.manifestPath);
    }

    for (const record of records) {
      if (record.quarantineReason !== undefined) {
        this.quarantine(record.path, record.quarantineReason);
        continue;
      }
      const ticket = record.ticket;
      if (ticket === undefined) throw new Error('invalid ticket preflight result');
      ensurePrivateFile(record.path);
      this.tickets.set(ticket.ticketId, ticket);
    }

    if (manifest.action !== 'none') {
      const written: TicketStoreManifestV1 = { schemaVersion: TICKET_STORE_SCHEMA_VERSION };
      atomicWriteJson(this.manifestPath, written);
    }

    this.report = {
      schemaVersion: TICKET_STORE_SCHEMA_VERSION,
      manifestAction: manifest.action,
      loadedTicketCount: this.tickets.size,
      migratedRecordCount: 0,
      interruptedTicketIds: [],
      quarantinedFiles: this.report.quarantinedFiles,
    };
  }

  private preflightRootTemporaryFiles(): string[] {
    const paths = readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\.manifest\.json\..+\.tmp$/.test(entry.name))
      .map((entry) => join(this.directory, entry.name));
    for (const path of paths) assertTemporarySchemaSupported(path);
    return paths;
  }

  private preflightRecords(): PreflightTicketRecord[] {
    const records: PreflightTicketRecord[] = [];
    let unsupportedVersion: UnsupportedTicketStoreVersionError | undefined;
    for (const entry of readdirSync(this.recordsDirectory, { withFileTypes: true })) {
      const path = join(this.recordsDirectory, entry.name);
      if (entry.name.endsWith('.tmp')) {
        assertTemporarySchemaSupported(path);
        records.push({ path, quarantineReason: 'interrupted atomic write' });
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      try {
        const stat = lstatSync(path);
        if (!stat.isFile()) throw new Error('ticket record path is not a regular file');
        const ticket = parseStoredTicket(JSON.parse(readFileSync(path, 'utf8')) as unknown, path);
        if (entry.name !== recordFileName(ticket.ticketId)) {
          throw new Error('ticket record file name does not match record id');
        }
        records.push({ path, ticket });
      } catch (error) {
        if (error instanceof UnsupportedTicketStoreVersionError) {
          unsupportedVersion ??= error;
          continue;
        }
        if (errorCode(error) !== undefined) throw error;
        records.push({
          path,
          quarantineReason: error instanceof Error ? error.message : 'invalid ticket record',
        });
      }
    }
    if (unsupportedVersion !== undefined) throw unsupportedVersion;
    return records;
  }

  private preflightManifest(): PreflightManifest {
    if (!existsSync(this.manifestPath)) return { action: 'created' };
    try {
      const stat = lstatSync(this.manifestPath);
      if (!stat.isFile()) throw new Error('ticket manifest is not a regular file');
      const parsed = JSON.parse(readFileSync(this.manifestPath, 'utf8')) as unknown;
      if (!isObject(parsed) || typeof parsed.schemaVersion !== 'number') {
        throw new Error('invalid ticket manifest');
      }
      if (parsed.schemaVersion > TICKET_STORE_SCHEMA_VERSION) {
        throw new UnsupportedTicketStoreVersionError(parsed.schemaVersion, this.manifestPath);
      }
      // No v0-to-v1 migration path exists (see the module doc comment) — anything that is not
      // exactly the version this build writes is corruption, not an earlier format to carry
      // forward, so the manifest gets rebuilt rather than silently accepted.
      if (parsed.schemaVersion !== TICKET_STORE_SCHEMA_VERSION) {
        throw new Error('invalid ticket manifest version');
      }
      return { action: 'none' };
    } catch (error) {
      if (error instanceof UnsupportedTicketStoreVersionError) throw error;
      if (errorCode(error) !== undefined) throw error;
      return {
        action: 'rebuilt',
        quarantineReason: error instanceof Error ? error.message : 'invalid ticket manifest',
      };
    }
  }

  private quarantine(path: string, reason: string): void {
    let bytes = 0;
    let regularFile = false;
    try {
      const stat = lstatSync(path);
      bytes = stat.size;
      regularFile = stat.isFile();
    } catch {
      // A raced-away path has no bytes to report and no content left to preserve.
    }
    ensurePrivateDirectory(this.quarantineDirectory);
    const quarantinePath = join(
      this.quarantineDirectory,
      `${basename(path)}.corrupt-${Date.now()}-${randomUUID()}`,
    );
    renameSync(path, quarantinePath);
    if (regularFile) ensurePrivateFile(quarantinePath);
    syncDirectory(dirname(path));
    syncDirectory(this.quarantineDirectory);
    this.report.quarantinedFiles.push({ originalPath: path, quarantinePath, reason, bytes });
  }
}
