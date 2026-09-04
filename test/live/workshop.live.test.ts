/**
 * Live acceptance test against the running Steam client, using Spacewar
 * (appid 480). Creates a PRIVATE throwaway item, round-trips a German
 * translation through it, subscribes to it and downloads it like a player
 * would, and deletes it again.
 *
 * Run: pnpm test:live   (requires a running, logged-in Steam client)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { init, SteamResultError, type Steam } from '../../src';
import { flat } from '../../src';

const live = !!process.env.STEAM_LIVE;

/** A real, 70 byte 1x1 PNG. Steam rejects a preview that is not a valid image. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

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
    const item = await steam.workshop.getItem(fileId!, {
      children: true,
      additionalPreviews: true,
      metadata: true,
      keyValueTags: true,
    });
    expect(item).not.toBeNull();
    expect(item!.children).toEqual([]);
    expect(item!.additionalPreviews).toEqual([]);
    expect(item!.metadata).toBe('steamwand-live-metadata');
    expect(item!.keyValueTags).toBeDefined();
    expect({ ...item!.keyValueTags }).toEqual({ steamwand: 'live' });
  }, 120_000);

  test('preview image round trip', async () => {
    const previewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steamwand-preview-'));
    const previewPath = path.join(previewDir, 'preview.png');
    fs.writeFileSync(previewPath, ONE_PIXEL_PNG);
    await steam.workshop.submitUpdate(fileId!, { previewImages: [previewPath] });

    const item = await steam.workshop.getItem(fileId!, { additionalPreviews: true });
    expect(item).not.toBeNull();
    expect(item!.additionalPreviews.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  test('app dependency round trip', async () => {
    // Not 480: Steam refuses an item depending on its own consumer app and
    // returns an invalid call handle. 481 is Spacewar's dedicated server app.
    await steam.workshop.addAppDependency(fileId!, 481);
    expect(await steam.workshop.getAppDependencies(fileId!)).toContain(481);
    await steam.workshop.removeAppDependency(fileId!, 481);
  }, 120_000);

  test('dlc list of the running app', () => {
    expect(Array.isArray(steam.dlc.listDlc())).toBe(true);
  });

  test('user items list contains the throwaway', async () => {
    const page = await steam.workshop.getUserItems(1, steam.accountId());
    expect(page.items.map((i) => i.fileId)).toContain(fileId!);
  }, 60_000);

  test('player side: subscribe, download, find on disk, unsubscribe', async () => {
    await steam.workshop.subscribe(fileId!);
    expect(steam.workshop.listSubscribed()).toContain(fileId!);
    const progress: bigint[] = [];
    await steam.workshop.download(fileId!, { onProgress: (p) => progress.push(p.bytesDownloaded) });
    expect(steam.workshop.getState(fileId!).installed).toBe(true);
    const info = steam.workshop.getInstallInfo(fileId!);
    expect(info).not.toBeNull();
    expect(fs.existsSync(path.join(info!.path, 'readme.txt'))).toBe(true);
    expect(await steam.workshop.getVote(fileId!)).toBeNull();
    // The local subscription list catches up on the client's next sync, so
    // it may still carry the id right after this resolves.
    await steam.workshop.unsubscribe(fileId!);
  }, 180_000);

  test('browse the Spacewar workshop and read the legal agreement status', async () => {
    const page = await steam.workshop.browse({ queryType: flat.EUGCQuery.k_EUGCQuery_RankedByPublicationDate });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.totalResults).toBeGreaterThanOrEqual(page.items.length);
    // Spacewar has no workshop legal agreement configured, so Steam answers
    // k_EResultInvalidParam. Either outcome proves the call result round trip.
    try {
      const eula = await steam.workshop.getEulaStatus();
      expect(typeof eula.accepted).toBe('boolean');
    } catch (err) {
      expect(err).toBeInstanceOf(SteamResultError);
    }
  }, 60_000);

  test('delete item', async () => {
    await steam.workshop.deleteItem(fileId!);
    fileId = undefined;
  }, 60_000);
});
