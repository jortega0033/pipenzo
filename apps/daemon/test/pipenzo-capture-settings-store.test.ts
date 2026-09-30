import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PipenzoCaptureSettingsStore } from '../src/pipenzo-capture-settings-store.js';

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pipenzo-capture-settings-'));
  filePath = join(directory, 'capture-settings-v1.json');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
});

describe('PipenzoCaptureSettingsStore', () => {
  it('answers the product defaults before anything has been configured', async () => {
    expect(await new PipenzoCaptureSettingsStore(filePath).read()).toEqual({
      schemaVersion: 1,
      screenshotEnabled: true,
      escapeHatchEnabled: false,
    });
  });

  it('round-trips a screenshotEnabled update through a real file', async () => {
    const store = new PipenzoCaptureSettingsStore(filePath);
    const saved = await store.update({ screenshotEnabled: false });

    expect(saved).toEqual({ schemaVersion: 1, screenshotEnabled: false, escapeHatchEnabled: false });
    // Read back through a *new* instance, so this is the file rather than the cache.
    expect(await new PipenzoCaptureSettingsStore(filePath).read()).toEqual(saved);
  });

  it('round-trips an escapeHatchEnabled update through a real file', async () => {
    const store = new PipenzoCaptureSettingsStore(filePath);
    const saved = await store.update({ escapeHatchEnabled: true });

    expect(saved).toEqual({ schemaVersion: 1, screenshotEnabled: true, escapeHatchEnabled: true });
    expect(await new PipenzoCaptureSettingsStore(filePath).read()).toEqual(saved);
  });

  it('merges a partial update onto the current settings rather than replacing the whole record', async () => {
    const store = new PipenzoCaptureSettingsStore(filePath);
    await store.update({ screenshotEnabled: false });
    // Only escapeHatchEnabled is given here -- screenshotEnabled must survive unchanged.
    const saved = await store.update({ escapeHatchEnabled: true });
    expect(saved).toEqual({ schemaVersion: 1, screenshotEnabled: false, escapeHatchEnabled: true });
  });

  it('reads a missing file as the defaults, not an error', async () => {
    expect(await new PipenzoCaptureSettingsStore(filePath).read()).toEqual({
      schemaVersion: 1,
      screenshotEnabled: true,
      escapeHatchEnabled: false,
    });
  });

  it('reads a corrupt file as the defaults, never a locked door', async () => {
    await writeFile(filePath, 'not json at all', 'utf8');
    expect(await new PipenzoCaptureSettingsStore(filePath).read()).toEqual({
      schemaVersion: 1,
      screenshotEnabled: true,
      escapeHatchEnabled: false,
    });
  });

  it('reads a file with an unrecognised version as the defaults', async () => {
    await writeFile(filePath, JSON.stringify({ version: 2, screenshotEnabled: false }), 'utf8');
    expect(await new PipenzoCaptureSettingsStore(filePath).read()).toEqual({
      schemaVersion: 1,
      screenshotEnabled: true,
      escapeHatchEnabled: false,
    });
  });

  it('persists durably: the on-disk file round-trips through a fresh readFile, not just the cache', async () => {
    await new PipenzoCaptureSettingsStore(filePath).update({ screenshotEnabled: false });
    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    expect(raw).toEqual({ version: 1, screenshotEnabled: false, escapeHatchEnabled: false });
  });
});
