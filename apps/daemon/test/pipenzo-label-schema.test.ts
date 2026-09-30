import { describe, expect, it } from 'vitest';
import { PIPENZO_LABELS, PIPENZO_SCHEMA_V1_MARKER_LABEL } from '@agent-dock/shared';
import { FakeGitHubClient } from '../src/github-client-fake.js';
import type { RepoRef } from '../src/github-client.js';
import {
  PIPENZO_LABEL_SCHEMA_V1,
  SCHEMA_MARKER_KEY,
  computeLabelRenames,
  ensurePipenzoLabelSet,
  migratePipenzoLabelSchema,
  type PipenzoLabelSchemaVersion,
} from '../src/pipenzo-label-schema.js';

const REF: RepoRef = { owner: 'jortega0033', repo: 'pipenzo' };

/**
 * A synthetic v2 for exercising the generic migration machinery. Not a real future Pipenzo schema
 * — this ticket builds the rename-on-bump *mechanism*, not a real v2 label set, so tests construct
 * their own minimal "something changed" version rather than reaching for a schema that does not
 * exist in the product yet.
 */
function fakeV2(overrides: Partial<Record<string, string>> = {}): PipenzoLabelSchemaVersion {
  return {
    version: 2,
    labels: PIPENZO_LABEL_SCHEMA_V1.labels.map((entry) => {
      if (entry.key === SCHEMA_MARKER_KEY) {
        return { ...entry, name: 'pipenzo:schema-v2' };
      }
      if (entry.key === 'needs-human' && !('needs-human' in overrides)) {
        return { ...entry, name: 'pipenzo:needs-a-human' };
      }
      if (overrides[entry.key]) {
        return { ...entry, name: overrides[entry.key]! };
      }
      return entry;
    }),
  };
}

describe('PIPENZO_LABEL_SCHEMA_V1', () => {
  it('names exactly README’s label table, in README’s order', () => {
    expect(PIPENZO_LABEL_SCHEMA_V1.labels.map((entry) => entry.name)).toEqual([...PIPENZO_LABELS]);
  });

  it('gives every label a valid six-hex-digit color and a non-empty description', () => {
    for (const entry of PIPENZO_LABEL_SCHEMA_V1.labels) {
      expect(entry.color).toMatch(/^[0-9a-f]{6}$/);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('marks the schema marker with the shared-package constant', () => {
    const marker = PIPENZO_LABEL_SCHEMA_V1.labels.find((entry) => entry.key === SCHEMA_MARKER_KEY);
    expect(marker?.name).toBe(PIPENZO_SCHEMA_V1_MARKER_LABEL);
  });
});

describe('ensurePipenzoLabelSet', () => {
  it('creates exactly README’s ten labels, with the schema marker created last', async () => {
    const client = new FakeGitHubClient();
    await ensurePipenzoLabelSet(client, REF);

    const created = client.calls.filter((call) => call.method === 'createLabel');
    expect(created).toHaveLength(10);
    expect(created[created.length - 1]?.key).toContain('pipenzo:schema-v1');

    const labels = await client.listLabels(REF);
    expect(labels.map((label) => label.name).sort()).toEqual([...PIPENZO_LABELS].sort());
    // Every label actually carries the description from README's "Meaning" column.
    const queued = labels.find((label) => label.name === 'pipenzo:queued');
    expect(queued?.description).toBe('Accepted, not started');
  });

  it('is idempotent: running it twice does not duplicate or error', async () => {
    const client = new FakeGitHubClient();
    await ensurePipenzoLabelSet(client, REF);
    await ensurePipenzoLabelSet(client, REF);
    expect(await client.listLabels(REF)).toHaveLength(10);
  });
});

describe('computeLabelRenames', () => {
  it('returns only the entries whose name actually changed, matched by key not name', () => {
    const to = fakeV2();
    const renames = computeLabelRenames(PIPENZO_LABEL_SCHEMA_V1, to);
    expect(renames).toEqual(
      expect.arrayContaining([
        { key: 'needs-human', from: 'pipenzo:needs-human', to: 'pipenzo:needs-a-human' },
        { key: SCHEMA_MARKER_KEY, from: 'pipenzo:schema-v1', to: 'pipenzo:schema-v2' },
      ]),
    );
    // Every other label's name is unchanged between v1 and this synthetic v2.
    expect(renames).toHaveLength(2);
  });

  it('produces no renames between a schema and itself', () => {
    expect(computeLabelRenames(PIPENZO_LABEL_SCHEMA_V1, PIPENZO_LABEL_SCHEMA_V1)).toEqual([]);
  });
});

describe('migratePipenzoLabelSchema', () => {
  it('renames every affected label via renameLabel, then the marker last, never a delete', async () => {
    const client = new FakeGitHubClient();
    await ensurePipenzoLabelSet(client, REF);
    client.calls.length = 0;

    const to = fakeV2();
    const report = await migratePipenzoLabelSchema(client, REF, PIPENZO_LABEL_SCHEMA_V1, to);

    expect(report.status).toBe('completed');
    expect(report.outcomes).toEqual(
      expect.arrayContaining([
        { key: 'needs-human', from: 'pipenzo:needs-human', to: 'pipenzo:needs-a-human', result: 'renamed' },
        { key: SCHEMA_MARKER_KEY, from: 'pipenzo:schema-v1', to: 'pipenzo:schema-v2', result: 'renamed' },
      ]),
    );

    // The actual GitHub-facing calls made are a listLabels read followed by renames — no delete
    // and no create anywhere in the migration path.
    const methods = client.calls.map((call) => call.method);
    expect(methods).toEqual(['listLabels', 'renameLabel', 'renameLabel']);

    // The marker is the *last* renameLabel call, after the non-marker rename.
    const renameCalls = client.calls.filter((call) => call.method === 'renameLabel');
    expect(renameCalls[renameCalls.length - 1]?.key).toContain('pipenzo:schema-v1->pipenzo:schema-v2');

    // The repository's label list actually reflects the rename, not an added-and-removed pair.
    const labels = await client.listLabels(REF);
    expect(labels.map((label) => label.name)).toContain('pipenzo:needs-a-human');
    expect(labels.map((label) => label.name)).not.toContain('pipenzo:needs-human');
    expect(labels).toHaveLength(10);
  });

  it('is idempotent: retrying after a full success reports already_migrated and writes nothing', async () => {
    const client = new FakeGitHubClient();
    await ensurePipenzoLabelSet(client, REF);
    const to = fakeV2();
    await migratePipenzoLabelSchema(client, REF, PIPENZO_LABEL_SCHEMA_V1, to);
    client.calls.length = 0;

    const report = await migratePipenzoLabelSchema(client, REF, PIPENZO_LABEL_SCHEMA_V1, to);
    expect(report.status).toBe('already_migrated');
    expect(client.calls.map((call) => call.method)).toEqual(['listLabels']);
  });

  it('recovers a partial prior run: an already-renamed label is reported, not re-renamed or conflicted', async () => {
    const client = new FakeGitHubClient();
    await ensurePipenzoLabelSet(client, REF);
    const to = fakeV2();
    // Simulate a prior attempt that renamed the ordinary label but crashed before the marker.
    await client.renameLabel(REF, 'pipenzo:needs-human', 'pipenzo:needs-a-human');
    client.calls.length = 0;

    const report = await migratePipenzoLabelSchema(client, REF, PIPENZO_LABEL_SCHEMA_V1, to);
    expect(report.status).toBe('completed');
    expect(report.outcomes).toEqual(
      expect.arrayContaining([
        {
          key: 'needs-human',
          from: 'pipenzo:needs-human',
          to: 'pipenzo:needs-a-human',
          result: 'already_migrated',
        },
      ]),
    );
    // Only the marker actually needed a network write this time.
    expect(client.calls.map((call) => call.method)).toEqual(['listLabels', 'renameLabel']);
  });

  it('refuses to overwrite a distinct pre-existing label already sitting on the target name', async () => {
    const client = new FakeGitHubClient();
    await ensurePipenzoLabelSet(client, REF);
    // A foreign label happens to already occupy the name v2 wants to rename into.
    await client.createLabel(REF, {
      name: 'pipenzo:needs-a-human',
      color: 'ffffff',
      description: 'not part of this migration',
    });
    client.calls.length = 0;

    const to = fakeV2();
    const report = await migratePipenzoLabelSchema(client, REF, PIPENZO_LABEL_SCHEMA_V1, to);

    expect(report.status).toBe('blocked');
    expect(report.outcomes).toEqual(
      expect.arrayContaining([
        {
          key: 'needs-human',
          from: 'pipenzo:needs-human',
          to: 'pipenzo:needs-a-human',
          result: 'target_exists',
        },
      ]),
    );
    // Refused before ever calling renameLabel or touching the marker.
    expect(client.calls.map((call) => call.method)).toEqual(['listLabels']);
    const labels = await client.listLabels(REF);
    expect(labels.map((label) => label.name)).toContain('pipenzo:needs-human');
    expect(labels.map((label) => label.name)).toContain('pipenzo:needs-a-human');
  });

  it('is blocked, not overridden, by a marker newer than the migration target', async () => {
    const client = new FakeGitHubClient();
    await ensurePipenzoLabelSet(client, REF);
    // Some other, newer-schema Pipenzo already moved this repo to v3.
    await client.renameLabel(REF, 'pipenzo:schema-v1', 'pipenzo:schema-v3');
    client.calls.length = 0;

    const to = fakeV2();
    const report = await migratePipenzoLabelSchema(client, REF, PIPENZO_LABEL_SCHEMA_V1, to);

    expect(report.status).toBe('blocked');
    expect(report.blockedByNewerMarker).toBe('pipenzo:schema-v3');
    expect(report.outcomes).toEqual([]);
    // Refused immediately: no rename of any kind attempted.
    expect(client.calls.map((call) => call.method)).toEqual(['listLabels']);
  });

  it('rejects a target version that is not newer than the source version', async () => {
    const client = new FakeGitHubClient();
    await expect(
      migratePipenzoLabelSchema(client, REF, PIPENZO_LABEL_SCHEMA_V1, PIPENZO_LABEL_SCHEMA_V1),
    ).rejects.toThrow(RangeError);
  });
});
