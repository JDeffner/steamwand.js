/**
 * Live acceptance test against the running Steam client, using Spacewar
 * (appid 480). Creates a PRIVATE throwaway item, round-trips a German
 * translation through it, and deletes it again.
 *
 * Run: pnpm test:live   (requires a running, logged-in Steam client)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { init, type Steam } from '../../src';
import { flat } from '../../src';

const live = !!process.env.STEAM_LIVE;

describe.skipIf(!live)('workshop round trip (Spacewar, live)', () => {
  let steam: Steam;
  let fileId: bigint | undefined;

  afterAll(async () => {
    if (steam && fileId) await steam.workshop.deleteItem(fileId).catch(() => {});
    steam?.close();
  });

  test('init + identity', () => {
    steam = init({ appId: 480 });
    expect(steam.accountId()).toBeGreaterThan(0);
    expect(steam.steamId()).toBeGreaterThan(0xffffffffn);
  });

  test('create throwaway item', async () => {
    const created = await steam.workshop.createItem();
    fileId = created.fileId;
    expect(created.fileId).toBeGreaterThan(1_000_000_000n);
  });

  test('submit content + default-language text', async () => {
    const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steamwand-live-'));
    fs.writeFileSync(path.join(contentDir, 'readme.txt'), 'steamwand live test content');
    const progress: number[] = [];
    const r = await steam.workshop.submitUpdate(
      fileId!,
      {
        title: 'steamwand throwaway (auto-deleted)',
        description: 'Live test item created by the steamwand test suite. Deleted right after.',
        contentPath: contentDir,
        tags: ['steamwand', 'test'],
        visibility: flat.ERemoteStoragePublishedFileVisibility.k_ERemoteStoragePublishedFileVisibilityPrivate,
        changeNote: 'steamwand live test',
      },
      { onProgress: (p) => progress.push(p.status) },
    );
    expect(typeof r.legalAgreementRequired).toBe('boolean');
  }, 120_000);

  test('submit German translation (SetItemUpdateLanguage)', async () => {
    await steam.workshop.submitUpdate(fileId!, {
      language: 'german',
      title: 'steamwand Wegwerfartikel',
      description: 'Deutscher Testtext.',
    });
  }, 120_000);

  test('query back: default and German text', async () => {
    const item = await steam.workshop.getItem(fileId!, { longDescription: true });
    expect(item).not.toBeNull();
    expect(item!.title).toBe('steamwand throwaway (auto-deleted)');
    expect(item!.tags).toContain('steamwand');
    expect(item!.ownerSteamId).toBe(steam.steamId());

    const german = await steam.workshop.getItem(fileId!, { language: 'german', longDescription: true });
    expect(german!.title).toBe('steamwand Wegwerfartikel');
  }, 60_000);

  test('metadata + key/value tag round trip', async () => {
    await steam.workshop.submitUpdate(fileId!, {
      metadata: 'steamwand-live-metadata',
      keyValueTags: { steamwand: 'live' },
    });
    // The curated query does not expose metadata or key/value tags, so the
    // proof here is that Steam accepted the update and the item still reads back.
    const item = await steam.workshop.getItem(fileId!, { children: true, additionalPreviews: true });
    expect(item).not.toBeNull();
    expect(item!.children).toEqual([]);
    expect(item!.additionalPreviews).toEqual([]);
  }, 120_000);

  test('dlc list of the running app', () => {
    expect(Array.isArray(steam.dlc.listDlc())).toBe(true);
  });

  test('user items list contains the throwaway', async () => {
    const page = await steam.workshop.getUserItems(1, steam.accountId());
    expect(page.items.map((i) => i.fileId)).toContain(fileId!);
  }, 60_000);

  test('delete item', async () => {
    await steam.workshop.deleteItem(fileId!);
    fileId = undefined;
  }, 60_000);
});
