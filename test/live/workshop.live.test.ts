/** Explicit Workshop acceptance run. See AGENTS.md for setup and recovery. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { flat, out, type WorkshopItemUpdate } from '../../src';
import { openSteam, testAppId, writes } from './config';
import { WorkshopRun } from './workshop-run';

/** A valid 1x1 PNG fixture. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PRIVATE = flat.ERemoteStoragePublishedFileVisibility.k_ERemoteStoragePublishedFileVisibilityPrivate;

describe.skipIf(!writes)('Workshop acceptance (live writes)', () => {
  // One sequential test stops at its first failure. Per-call deadlines expire
  // before Vitest's outer timeout, preventing later steps after a timeout.
  test('private create, update, download, and delete', async () => {
    const appId = testAppId(process.env.STEAM_TEST_APP_ID);
    const dependencyAppId = process.env.STEAM_TEST_DEPENDENCY_APP_ID
      ? testAppId(process.env.STEAM_TEST_DEPENDENCY_APP_ID)
      : appId === 480 ? 481 : undefined;
    if (dependencyAppId === appId) throw new Error('The dependency app must differ from STEAM_TEST_APP_ID.');
    const steam = openSteam(appId);
    let run: WorkshopRun | undefined;
    const errors: unknown[] = [];
    try {
      run = new WorkshopRun('.steamwand-live', appId, steam.steamId());
      const activeRun = run;
      const marker = `steamwand-test-${randomUUID()}`;
      const content = Buffer.from(`${marker}\nOriginal content for a private steamwand acceptance test.\n`);
      const contentDir = path.join(run.directory, 'content');
      fs.mkdirSync(contentDir);
      fs.writeFileSync(path.join(contentDir, 'readme.txt'), content);
      const previewPath = path.join(run.directory, 'preview.png');
      fs.writeFileSync(previewPath, ONE_PIXEL_PNG);

      const eula = await run.call('check app Workshop EULA', () => steam.async.ugc.GetWorkshopEULAStatus());
      expect(eula.m_eResult).toBe(flat.EResult.k_EResultOK);
      expect(eula.m_nAppID).toBe(appId);
      if (eula.m_bNeedsAction) throw new Error('Accept the app Workshop EULA yourself in Steam before running this test.');

      const created = await run.call('create item', async () => {
        const result = await steam.workshop.createItem();
        activeRun.recordItem(result.fileId);
        return result;
      });
      const fileId = created.fileId;
      const checkAgreement = (required: boolean): void => {
        if (required) throw new Error(`Accept the Workshop agreement yourself in Steam before retrying (item ${fileId}).`);
      };
      checkAgreement(created.legalAgreementRequired);

      const update = async (label: string, fields: WorkshopItemUpdate): Promise<void> => {
        const result = await activeRun.call(label, () => steam.workshop.submitUpdate(fileId, {
          ...fields,
          visibility: PRIVATE,
        }), 120_000);
        checkAgreement(result.legalAgreementRequired);
      };

      await update('upload content and English text', {
        language: 'english',
        title: marker,
        description: 'Private steamwand acceptance fixture. Cleanup is attempted after the test.',
        contentPath: contentDir,
        previewPath,
        tags: ['steamwand', 'test'],
      });
      await update('upload German translation', {
        language: 'german',
        title: `${marker} Deutsch`,
        description: 'Deutscher Testtext.',
      });

      const item = await run.call('query English details', () => steam.workshop.getItem(fileId, { language: 'english', longDescription: true }));
      expect(item).not.toBeNull();
      expect(item!.title).toBe(marker);
      expect(item!.tags).toContain('steamwand');
      expect(item!.ownerSteamId).toBe(steam.steamId());
      expect(item!.consumerAppId).toBe(appId);
      expect(item!.visibility).toBe(PRIVATE);
      const german = await run.call('query German details', () => steam.workshop.getItem(fileId, { language: 'german' }));
      expect(german?.title).toBe(`${marker} Deutsch`);

      await update('upload metadata and key/value tags', { metadata: marker, keyValueTags: { steamwand: marker } });
      const metadata = await run.call('query metadata', () => steam.workshop.getItem(fileId, {
        children: true, additionalPreviews: true, metadata: true, keyValueTags: true,
      }));
      expect(metadata).not.toBeNull();
      expect(metadata!.children).toEqual([]);
      expect(metadata!.additionalPreviews).toEqual([]);
      expect(metadata!.metadata).toBe(marker);
      expect({ ...metadata!.keyValueTags }).toEqual({ steamwand: marker });

      await update('upload extra preview', { previewImages: [previewPath] });
      const preview = await run.call('query extra preview', () => steam.workshop.getItem(fileId, { additionalPreviews: true }));
      expect(preview?.additionalPreviews.length).toBe(1);
      expect(preview?.additionalPreviews[0].index).toBe(0);
      expect(preview?.visibility).toBe(PRIVATE);

      if (dependencyAppId !== undefined) {
        await run.call('add app dependency', () => steam.workshop.addAppDependency(fileId, dependencyAppId));
        const requirements = await run.call('query app dependencies', () => steam.workshop.getAppDependenciesResult(fileId));
        expect(requirements.complete).toBe(true);
        expect(requirements.totalCount).toBe(requirements.appIds.length);
        expect(requirements.appIds).toContain(dependencyAppId);
        await run.call('remove app dependency', () => steam.workshop.removeAppDependency(fileId, dependencyAppId));
      } else {
        console.info('App dependency check omitted: set STEAM_TEST_DEPENDENCY_APP_ID to include it.');
      }
      expect(Array.isArray(steam.dlc.listDlc())).toBe(true);
      const page = await run.call('query own items', () => steam.workshop.getUserItems(1, steam.accountId()));
      expect(page.items.map((entry) => entry.fileId)).toContain(fileId);

      let off = () => {};
      try {
        await run.call('download uploaded content', () => new Promise<void>((resolve, reject) => {
          // Downloads broadcast to all apps. Register first and filter both IDs.
          off = steam.on('DownloadItemResult_t', (event) => {
            if (event.m_unAppID !== appId || event.m_nPublishedFileId !== fileId) return;
            if (event.m_eResult === flat.EResult.k_EResultOK) resolve();
            else reject(new Error(`Workshop download failed with EResult ${event.m_eResult}.`));
          });
          if (!steam.ugc.DownloadItem(fileId, false)) reject(new Error('Steam refused to start the Workshop download.'));
        }), 120_000);
      } finally {
        off();
      }
      const size = out.uint64(), folder = out.string(4096), timestamp = out.uint32();
      expect(steam.ugc.GetItemInstallInfo(fileId, size.buffer, folder.buffer, folder.buffer.length, timestamp.buffer)).toBe(true);
      expect(path.isAbsolute(folder.value)).toBe(true);
      expect(fs.readFileSync(path.join(folder.value, 'readme.txt'))).toEqual(content);
      // Steam owns its download cache. Remove only our remote item and fixture directory.
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        if (run) await run.cleanup((fileId) => steam.workshop.deleteItem(fileId));
      } catch (error) {
        errors.push(error);
      } finally {
        steam.close();
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Workshop acceptance failed. Inspect the errors and any .steamwand-live/workshop recovery record.');
  }, 25 * 60_000);
});
