import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { checkIdentity, expectedSteamId, liveMode, testAppId } from './live/config';
import { LiveTimeoutError, WorkshopRun } from './live/workshop-run';
import { SteamApiCallError } from '../src/runtime/dispatch';
import { SteamResultError } from '../src/api/errors';
import { EResult } from '../src/generated/enums';

const account = 76561198000000001n;
const item = 9007199254740993n;
const roots: string[] = [];

function fixture(): WorkshopRun {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steamwand-workflow-'));
  roots.push(root);
  return new WorkshopRun(root, 480, account);
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    // These are exact paths returned by mkdtempSync above, never journal input.
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('live test authorization', () => {
  test.each([undefined, '', '0', 'true'])('does not enable live access for %s', (value) => {
    expect(liveMode({ STEAM_LIVE: value, STEAM_LIVE_WRITE: '1' })).toEqual({ live: false, writes: false });
  });

  test('requires both explicit flags for writes', () => {
    expect(liveMode({ STEAM_LIVE: '1' })).toEqual({ live: true, writes: false });
    expect(liveMode({ STEAM_LIVE: '1', STEAM_LIVE_WRITE: '0' })).toEqual({ live: true, writes: false });
    expect(liveMode({ STEAM_LIVE: '1', STEAM_LIVE_WRITE: '1' })).toEqual({ live: true, writes: true });
  });

  test('requires an explicit app and preserves the expected 64-bit account ID', () => {
    expect(testAppId('480')).toBe(480);
    expect(expectedSteamId(account.toString())).toBe(account);
    for (const value of [undefined, '0', '-1', '1.5', '480oops', '4294967296']) {
      expect(() => testAppId(value)).toThrow('STEAM_TEST_APP_ID');
    }
    for (const value of [undefined, '0', 'bad', '18446744073709551616']) {
      expect(() => expectedSteamId(value)).toThrow('STEAM_TEST_STEAM_ID');
    }
  });

  test('refuses an unexpected account or app', () => {
    const steam = { steamId: () => account, system: { appId: () => 480 } };
    expect(() => checkIdentity(steam, 480, account)).not.toThrow();
    expect(() => checkIdentity(steam, 480, account + 1n)).toThrow('account');
    expect(() => checkIdentity(steam, 999, account)).toThrow('app ID');
  });
});

describe('Workshop recovery', () => {
  test('persists exact IDs, blocks overlapping runs, and removes fixtures only after deletion succeeds', async () => {
    const run = fixture();
    run.recordItem(item);
    const saved = JSON.parse(fs.readFileSync(run.journal, 'utf8'));
    expect(saved).toMatchObject({ appId: 480, steamId: account.toString(), fileId: item.toString() });
    expect(() => new WorkshopRun(path.dirname(run.directory), 480, account)).toThrow('unfinished');
    const payload = path.join(run.directory, 'payload.txt');
    fs.writeFileSync(payload, 'fixture');
    const remove = vi.fn(async (fileId: bigint) => {
      expect(fileId).toBe(item);
      expect(fs.existsSync(payload)).toBe(true);
    });
    await run.cleanup(remove);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(run.directory)).toBe(false);
  });

  test('reports failed deletion and retains the recovery record and content', async () => {
    const run = fixture();
    run.recordItem(item);
    const payload = path.join(run.directory, 'payload.txt');
    fs.writeFileSync(payload, 'fixture');
    const remove = vi.fn(async () => { throw new Error('service unavailable'); });
    await expect(run.cleanup(remove)).rejects.toThrow('cleanup failed');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(run.journal, 'utf8')).fileId).toBe(item.toString());
    expect(fs.readFileSync(payload, 'utf8')).toBe('fixture');
  });

  test('does not delete or start more work after an upload timeout', async () => {
    vi.useFakeTimers();
    const run = fixture();
    run.recordItem(item);
    let finishUpload!: () => void;
    const upload = run.call('upload', () => new Promise<void>((resolve) => { finishUpload = resolve; }), 100);
    const rejection = expect(upload).rejects.toBeInstanceOf(LiveTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    finishUpload(); // A late completion must not turn an uncertain run into a safe retry.
    const remove = vi.fn(async () => {});
    await expect(run.cleanup(remove)).rejects.toThrow('uncertain');
    await expect(run.call('retry', remove)).rejects.toThrow('Resolve');
    expect(remove).not.toHaveBeenCalled();
    expect(fs.existsSync(run.journal)).toBe(true);
  });

  test('retains evidence when create has an uncertain result without an item ID', async () => {
    const run = fixture();
    await expect(run.call('create item', async () => {
      throw new SteamApiCallError('lost result', 3403);
    })).rejects.toThrow('lost result');
    const remove = vi.fn(async () => {});
    await expect(run.cleanup(remove)).rejects.toThrow('uncertain');
    expect(remove).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(run.journal, 'utf8')).stage).toBe('create item');
  });

  test.each([EResult.k_EResultTimeout, EResult.k_EResultDuplicateRequest])('preserves an uncertain Steam result (%s)', async (result) => {
    const run = fixture();
    await expect(run.call('create item', async () => {
      throw new SteamResultError('CreateItem', result);
    })).rejects.toBeInstanceOf(SteamResultError);
    const remove = vi.fn(async () => {});
    await expect(run.cleanup(remove)).rejects.toThrow('uncertain');
    expect(remove).not.toHaveBeenCalled();
    expect(fs.existsSync(run.journal)).toBe(true);
  });

  test('still cleans up a known item after a definite update rejection', async () => {
    const run = fixture();
    run.recordItem(item);
    await expect(run.call('update item', async () => {
      throw new SteamResultError('SubmitItemUpdate', EResult.k_EResultInvalidParam);
    })).rejects.toBeInstanceOf(SteamResultError);
    const remove = vi.fn(async () => {});
    await run.cleanup(remove);
    expect(remove).toHaveBeenCalledWith(item);
    expect(fs.existsSync(run.directory)).toBe(false);
  });

  test('removes local fixtures without sending a delete if no item was created', async () => {
    const run = fixture();
    const remove = vi.fn(async () => {});
    await run.cleanup(remove);
    expect(remove).not.toHaveBeenCalled();
    expect(fs.existsSync(run.directory)).toBe(false);
  });
});
