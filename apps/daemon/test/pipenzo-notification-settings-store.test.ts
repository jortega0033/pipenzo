import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PipenzoNotificationSettingsStore } from '../src/pipenzo-notification-settings-store.js';

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pipenzo-notification-settings-'));
  filePath = join(directory, 'notification-settings-v1.json');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
});

describe('PipenzoNotificationSettingsStore', () => {
  it('answers the product defaults before anything has been configured', async () => {
    expect(await new PipenzoNotificationSettingsStore(filePath).read()).toEqual({
      schemaVersion: 1,
      refusal: true,
      medium: true,
      badge: true,
      sound: false,
    });
  });

  it('round-trips a refusal update through a real file', async () => {
    const store = new PipenzoNotificationSettingsStore(filePath);
    const saved = await store.update({ refusal: false });

    expect(saved).toEqual({ schemaVersion: 1, refusal: false, medium: true, badge: true, sound: false });
    // Read back through a *new* instance, so this is the file rather than the cache.
    expect(await new PipenzoNotificationSettingsStore(filePath).read()).toEqual(saved);
  });

  it('round-trips a medium update through a real file', async () => {
    const store = new PipenzoNotificationSettingsStore(filePath);
    const saved = await store.update({ medium: false });

    expect(saved).toEqual({ schemaVersion: 1, refusal: true, medium: false, badge: true, sound: false });
    expect(await new PipenzoNotificationSettingsStore(filePath).read()).toEqual(saved);
  });

  it('round-trips a badge update through a real file', async () => {
    const store = new PipenzoNotificationSettingsStore(filePath);
    const saved = await store.update({ badge: false });

    expect(saved).toEqual({ schemaVersion: 1, refusal: true, medium: true, badge: false, sound: false });
    expect(await new PipenzoNotificationSettingsStore(filePath).read()).toEqual(saved);
  });

  it('round-trips a sound update through a real file', async () => {
    const store = new PipenzoNotificationSettingsStore(filePath);
    const saved = await store.update({ sound: true });

    expect(saved).toEqual({ schemaVersion: 1, refusal: true, medium: true, badge: true, sound: true });
    expect(await new PipenzoNotificationSettingsStore(filePath).read()).toEqual(saved);
  });

  it('merges a partial update onto the current settings rather than replacing the whole record', async () => {
    const store = new PipenzoNotificationSettingsStore(filePath);
    await store.update({ refusal: false });
    // Only sound is given here -- refusal must survive unchanged, and medium/badge too.
    const saved = await store.update({ sound: true });
    expect(saved).toEqual({ schemaVersion: 1, refusal: false, medium: true, badge: true, sound: true });
  });

  it('reads a missing file as the defaults, not an error', async () => {
    expect(await new PipenzoNotificationSettingsStore(filePath).read()).toEqual({
      schemaVersion: 1,
      refusal: true,
      medium: true,
      badge: true,
      sound: false,
    });
  });

  it('reads a corrupt file as the defaults, never a locked door', async () => {
    await writeFile(filePath, 'not json at all', 'utf8');
    expect(await new PipenzoNotificationSettingsStore(filePath).read()).toEqual({
      schemaVersion: 1,
      refusal: true,
      medium: true,
      badge: true,
      sound: false,
    });
  });

  it('reads a file with an unrecognised version as the defaults', async () => {
    await writeFile(filePath, JSON.stringify({ version: 2, refusal: false }), 'utf8');
    expect(await new PipenzoNotificationSettingsStore(filePath).read()).toEqual({
      schemaVersion: 1,
      refusal: true,
      medium: true,
      badge: true,
      sound: false,
    });
  });

  it('ignores a hand-edited "high" field in the file -- there is no slot for it in the schema', async () => {
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, refusal: true, medium: true, badge: true, sound: false, high: false }),
      'utf8',
    );
    const result = await new PipenzoNotificationSettingsStore(filePath).read();
    expect(result).toEqual({ schemaVersion: 1, refusal: true, medium: true, badge: true, sound: false });
    expect(result).not.toHaveProperty('high');
  });

  it('persists durably: the on-disk file round-trips through a fresh readFile, not just the cache', async () => {
    await new PipenzoNotificationSettingsStore(filePath).update({ sound: true });
    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    expect(raw).toEqual({ version: 1, refusal: true, medium: true, badge: true, sound: true });
    expect(raw).not.toHaveProperty('high');
  });
});
