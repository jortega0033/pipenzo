import { PIPENZO_LABELS, PIPENZO_SCHEMA_V1_MARKER_LABEL } from '@agent-dock/shared';
import type { GitHubClient, GitHubLabel, RepoRef } from './github-client.js';

/**
 * README's label table, as something a repository can actually be seeded with and migrated
 * between versions (issue #162, split of epic #20 "Label-schema versioning and migration path").
 *
 * Two capabilities live here:
 *
 * 1. **`ensurePipenzoLabelSet`** — creates a repository's whole label set (including the
 *    `pipenzo:schema-v1` marker) on first contact, via `GitHubClient.createLabel`'s own
 *    idempotency. This is the "epic #4 MVP label set" half of issue #162's scope; it is built here
 *    rather than assumed to already exist because nothing in this codebase called `createLabel` in
 *    a loop before this file did.
 * 2. **`migratePipenzoLabelSchema`** — this ticket's substantive scope. When a future schema bump
 *    changes what a label is named (README's table entries are not expected to be permanent; the
 *    marker's own `-v1` suffix says so), every affected label is renamed via
 *    `GitHubClient.renameLabel` — a `PATCH` on the existing label object — never deleted and
 *    recreated. See that function's own comment for why a delete+recreate would silently detach
 *    every issue's label history, and for the ordering and conflict rules the migration follows.
 *
 * Nothing in this module calls the daemon's actual repo-connect route yet. That wiring is a
 * decision about *when* a repository first gets its labels (epic #4's remaining scope, per issue
 * #162's own cross-reference note) — a behavioural change to an HTTP route with its own error and
 * idempotency surface, not a natural extension of "the label CRUD exists and is tested." Keeping
 * this module callable-but-uncalled-in-production also keeps the diff inside issue #162's own
 * M-sized estimate.
 */

/** The stable identity of the schema-marker slot, independent of the literal marker name, which
 * is exactly the thing a version bump changes. Every `PipenzoLabelSchemaVersion` must define it. */
export const SCHEMA_MARKER_KEY = 'schema-marker';

export interface PipenzoLabelSchemaEntry {
  readonly key: string;
  readonly name: string;
  /** Six lowercase hex digits, no leading `#` — `GitHubLabel`'s own wire shape. */
  readonly color: string;
  readonly description: string;
}

export interface PipenzoLabelSchemaVersion {
  readonly version: number;
  readonly labels: readonly PipenzoLabelSchemaEntry[];
}

/**
 * README's label table, version 1. Every `name` below is copy-pasted from README's table (and, at
 * module load, checked against `PIPENZO_LABELS` — the same table's own shared-package constant —
 * rather than trusted to stay in sync by hand). Colors and descriptions are not specified by
 * README (its table has no color column); descriptions reuse README's own "Meaning" column
 * verbatim, and colors are this module's own choice, grouped by lane: grey for queued, blue for
 * working, gold for ready-for-review, a red/orange family for the needs-human variants, purple for
 * the git-mechanical `merge-conflict` (a different kind of "needs human" than an approval), and a
 * distinct blue for the schema marker so it never reads as a lane color.
 */
export const PIPENZO_LABEL_SCHEMA_V1: PipenzoLabelSchemaVersion = Object.freeze({
  version: 1,
  labels: Object.freeze([
    { key: 'queued', name: 'pipenzo:queued', color: 'c5c5c5', description: 'Accepted, not started' },
    { key: 'working', name: 'pipenzo:working', color: '1d76db', description: 'A phase is running' },
    {
      key: 'ready-for-review',
      name: 'pipenzo:ready-for-review',
      color: 'fbca04',
      description: 'Gates passed, awaiting the human push gate',
    },
    {
      key: 'needs-human',
      name: 'pipenzo:needs-human',
      color: 'd93f0b',
      description: 'Parked — 3 consecutive failures, or a denied approval',
    },
    {
      key: 'needs-pre-scoping',
      name: 'pipenzo:needs-pre-scoping',
      color: 'e99695',
      description: 'Refused at the diff-size gate',
    },
    {
      key: 'awaiting-stack-approval',
      name: 'pipenzo:awaiting-stack-approval',
      color: 'f9d0c4',
      description: 'A decomposition, or a blown estimate, awaiting sign-off',
    },
    {
      key: 'ci-failed',
      name: 'pipenzo:ci-failed',
      color: 'b60205',
      description: 'A post-merge-request check failed',
    },
    {
      key: 'merge-conflict',
      name: 'pipenzo:merge-conflict',
      color: '5319e7',
      description: 'The approved branch no longer merges cleanly',
    },
    {
      key: 'interrupted',
      name: 'pipenzo:interrupted',
      color: '333333',
      description: 'The daemon died mid-run',
    },
    {
      key: SCHEMA_MARKER_KEY,
      name: PIPENZO_SCHEMA_V1_MARKER_LABEL,
      color: '0052cc',
      description: 'Marker: this issue is managed by a v1-schema Pipenzo',
    },
  ]),
} satisfies PipenzoLabelSchemaVersion);

/**
 * Drift guard, in the same spirit as `pipenzo-phase-machine.ts`'s own `SUPPORTED_SCHEMA_VERSION`
 * check: `PIPENZO_LABEL_SCHEMA_V1`'s names are typed out a second time above rather than derived
 * from `PIPENZO_LABELS` (an entry needs a color and description `PIPENZO_LABELS` does not carry),
 * so this runs once at import time to guarantee the two never silently disagree about what v1's
 * ten labels actually are.
 */
{
  const namesInOrder = PIPENZO_LABEL_SCHEMA_V1.labels.map((entry) => entry.name);
  const matches =
    namesInOrder.length === PIPENZO_LABELS.length &&
    PIPENZO_LABELS.every((name, index) => name === namesInOrder[index]);
  if (!matches) {
    throw new Error(
      'PIPENZO_LABEL_SCHEMA_V1 has drifted from PIPENZO_LABELS — both must list README’s label table in the same order',
    );
  }
}

/**
 * Creates every label a schema version needs on a repository, treating "already exists" as
 * success via `GitHubClient.createLabel`'s own idempotency (safe to call on every daemon start, or
 * whenever a repository is (re-)connected).
 *
 * The schema marker is created **last**, deliberately, mirroring `migratePipenzoLabelSchema`'s own
 * "marker moves last" rule one level up: `newerSchemaMarker` (`pipenzo-phase-machine.ts`) treats a
 * `pipenzo:schema-v1` label's mere presence as proof that a v1-understanding Pipenzo has this
 * repository's whole v1 label set in place. Creating the marker before the other nine land would
 * let a crash between the two leave a repository that claims schema v1 while still missing most of
 * its state labels.
 */
export async function ensurePipenzoLabelSet(
  client: GitHubClient,
  ref: RepoRef,
  schema: PipenzoLabelSchemaVersion = PIPENZO_LABEL_SCHEMA_V1,
): Promise<void> {
  const marker = schema.labels.find((entry) => entry.key === SCHEMA_MARKER_KEY);
  const rest = schema.labels.filter((entry) => entry.key !== SCHEMA_MARKER_KEY);
  for (const entry of rest) {
    await client.createLabel(ref, toGitHubLabel(entry));
  }
  if (marker) {
    await client.createLabel(ref, toGitHubLabel(marker));
  }
}

function toGitHubLabel(entry: PipenzoLabelSchemaEntry): GitHubLabel {
  return { name: entry.name, color: entry.color, description: entry.description };
}

export interface PipenzoLabelRename {
  /** The identity that survives the rename — matched between schema versions, not by name. */
  readonly key: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Matches two schema versions' label lists by `key` and returns only the entries whose `name`
 * actually changed. A key present in one version and absent from the other is not a rename and is
 * left out of the result — today every version carries every key (a schema bump only ever renames
 * README's ten rows, it does not add or remove one), but a future version that retired a key
 * should not have this silently invent a rename to or from `undefined`.
 */
export function computeLabelRenames(
  from: PipenzoLabelSchemaVersion,
  to: PipenzoLabelSchemaVersion,
): readonly PipenzoLabelRename[] {
  const toByKey = new Map(to.labels.map((entry) => [entry.key, entry] as const));
  const renames: PipenzoLabelRename[] = [];
  for (const fromEntry of from.labels) {
    const toEntry = toByKey.get(fromEntry.key);
    if (toEntry && toEntry.name !== fromEntry.name) {
      renames.push({ key: fromEntry.key, from: fromEntry.name, to: toEntry.name });
    }
  }
  return renames;
}

export type PipenzoLabelRenameResult =
  | 'renamed'
  | 'already_migrated'
  | 'target_exists'
  | 'source_missing';

export interface PipenzoLabelRenameOutcome extends PipenzoLabelRename {
  readonly result: PipenzoLabelRenameResult;
}

export type PipenzoLabelMigrationStatus = 'completed' | 'already_migrated' | 'blocked';

export interface PipenzoLabelMigrationReport {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly status: PipenzoLabelMigrationStatus;
  readonly outcomes: readonly PipenzoLabelRenameOutcome[];
  /** Set only when `status` is `'blocked'` because the repository already carries a marker newer
   * than `to` — the repo-level mirror of the per-issue condition `newerSchemaMarker`
   * (`pipenzo-phase-machine.ts`) guards reads against. */
  readonly blockedByNewerMarker?: string;
}

const SCHEMA_MARKER_PATTERN = /^pipenzo:schema-v(\d+)$/;

function schemaMarkerVersion(name: string): number | undefined {
  const match = SCHEMA_MARKER_PATTERN.exec(name);
  return match ? Number(match[1]) : undefined;
}

/**
 * Renames every label whose name changed between `from` and `to` — via `GitHubClient.renameLabel`,
 * never delete-plus-create — and only then renames the schema marker itself, so a marker matching
 * `to.version` is never visible on a repository whose other labels are still mid-migration.
 *
 * ## Why the marker moves last
 *
 * `newerSchemaMarker` (`pipenzo-phase-machine.ts`) trusts a `pipenzo:schema-vN` marker's version
 * number as proof that a build understanding schema N wrote that repository's whole label set. If
 * this function wrote the new marker first and then died partway through the remaining renames, an
 * *older* Pipenzo instance meeting that repo would correctly refuse it (the read-only guard doing
 * its job) — but so would a build that *does* understand the new schema, reading a marker that
 * promises state which is not actually there yet. Marker-last keeps the marker trustworthy at every
 * point this function can be interrupted: it either still reads the old version (nothing a v(from)
 * reader would misread has changed) or the new one (by which point everything else has really moved).
 *
 * ## Why a pre-existing conflicting label blocks rather than overwrites
 *
 * A `pipenzo:`-namespaced label already sitting on a *target* name this repository did not get from
 * this migration is rare (hard rule 5 is precisely why nothing outside Pipenzo should create one)
 * but not impossible — a half-finished manual fix, an earlier failed migration that created instead
 * of renaming, another tool sharing the namespace by mistake. Overwriting or merging into it
 * automatically means guessing at intent with a live label-to-issue association on the line, so
 * this leaves it untouched, reports it as `target_exists`, and refuses to advance the marker until a
 * human resolves it — README's own stance on the diff-size gate ("refusal is a real ticket state,
 * not an error") applied here.
 *
 * ## Idempotent recovery
 *
 * The current label list is read once, up front, and every decision below is made from that single
 * snapshot rather than re-probed per label — so a label already renamed by a prior, interrupted
 * attempt (its old name gone, its new name present) is reported `already_migrated` and left alone,
 * rather than re-attempted or mistaken for a conflict.
 *
 * ## A blocked label does not roll back one that already renamed
 *
 * Non-marker renames apply as they are decided, in `from.labels` order, rather than being staged
 * and committed together: if label A's rename succeeds and label B's is then found to conflict, A's
 * rename is not undone. That is deliberate — A's rename already happened and is independently safe
 * (README's rename, not delete+create, guarantee holds per label) — and the marker gate above is
 * exactly what stops the *ticket*-visible state (schema vN, fully) from being claimed early: a
 * retry after resolving B's conflict finds A already done (`already_migrated`) and finishes the
 * rest. One consequence worth naming: a true swap (v(from) has A and B; v(to) renames A→B and
 * B→A) is always reported `target_exists` on both sides rather than resolved, because at the
 * point either rename is evaluated the other one's *old* name is still occupying the target. That
 * is the conservative, correct answer for a case this migration has no product need to solve today.
 */
export async function migratePipenzoLabelSchema(
  client: GitHubClient,
  ref: RepoRef,
  from: PipenzoLabelSchemaVersion,
  to: PipenzoLabelSchemaVersion,
): Promise<PipenzoLabelMigrationReport> {
  if (to.version <= from.version) {
    throw new RangeError(
      `migratePipenzoLabelSchema: target schema v${to.version} must be newer than v${from.version}`,
    );
  }
  const fromMarker = from.labels.find((entry) => entry.key === SCHEMA_MARKER_KEY);
  const toMarker = to.labels.find((entry) => entry.key === SCHEMA_MARKER_KEY);
  if (!fromMarker || !toMarker) {
    throw new Error('migratePipenzoLabelSchema: both schema versions must define a schema marker');
  }

  const currentLabels = await client.listLabels(ref);
  const nameExists = (name: string): boolean => currentLabels.some((label) => label.name === name);

  // The repo-level mirror of `newerSchemaMarker`'s per-issue guard: a marker newer than what we're
  // migrating *to* means a newer-schema Pipenzo already moved this repository further than this
  // call is about to. Forcing our own (older) rename mapping over that would be exactly the
  // "fights over labels with a newer instance it can't understand" case README rules out.
  for (const label of currentLabels) {
    const version = schemaMarkerVersion(label.name);
    if (version !== undefined && version > to.version) {
      return {
        fromVersion: from.version,
        toVersion: to.version,
        status: 'blocked',
        outcomes: [],
        blockedByNewerMarker: label.name,
      };
    }
  }

  if (nameExists(toMarker.name) && !nameExists(fromMarker.name)) {
    return { fromVersion: from.version, toVersion: to.version, status: 'already_migrated', outcomes: [] };
  }

  const renames = computeLabelRenames(from, to).filter((rename) => rename.key !== SCHEMA_MARKER_KEY);
  const outcomes: PipenzoLabelRenameOutcome[] = [];
  let blocked = false;

  for (const rename of renames) {
    const fromExists = nameExists(rename.from);
    const toExists = nameExists(rename.to);
    if (!fromExists && toExists) {
      outcomes.push({ ...rename, result: 'already_migrated' });
    } else if (fromExists && toExists) {
      outcomes.push({ ...rename, result: 'target_exists' });
      blocked = true;
    } else if (!fromExists && !toExists) {
      outcomes.push({ ...rename, result: 'source_missing' });
      blocked = true;
    } else {
      await client.renameLabel(ref, rename.from, rename.to);
      outcomes.push({ ...rename, result: 'renamed' });
    }
  }

  if (blocked) {
    return { fromVersion: from.version, toVersion: to.version, status: 'blocked', outcomes };
  }

  const markerRename: PipenzoLabelRename = {
    key: SCHEMA_MARKER_KEY,
    from: fromMarker.name,
    to: toMarker.name,
  };
  const markerFromExists = nameExists(fromMarker.name);
  const markerToExists = nameExists(toMarker.name);
  if (!markerFromExists && markerToExists) {
    outcomes.push({ ...markerRename, result: 'already_migrated' });
  } else if (markerFromExists && markerToExists) {
    // The only way to reach here rather than the top-level `already_migrated` short-circuit is a
    // repository that somehow carries both markers at once — an anomaly, not the normal in-flight
    // case, and treated the same as any other colliding target: reported, not resolved for you.
    outcomes.push({ ...markerRename, result: 'target_exists' });
    return { fromVersion: from.version, toVersion: to.version, status: 'blocked', outcomes };
  } else if (!markerFromExists && !markerToExists) {
    outcomes.push({ ...markerRename, result: 'source_missing' });
    return { fromVersion: from.version, toVersion: to.version, status: 'blocked', outcomes };
  } else {
    await client.renameLabel(ref, fromMarker.name, toMarker.name);
    outcomes.push({ ...markerRename, result: 'renamed' });
  }

  return { fromVersion: from.version, toVersion: to.version, status: 'completed', outcomes };
}
