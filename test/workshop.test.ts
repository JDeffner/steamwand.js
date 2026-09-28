import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Workshop, type QueryOptions, type WorkshopItemUpdate } from '../src/api/workshop';
import { SteamResultError } from '../src/api/errors';
import { EResult } from '../src/generated/enums';
import { k_UGCQueryHandleInvalid } from '../src/generated/consts';
import { layoutOf } from '../src/generated/structs';
import type { GetAppDependenciesResult_t } from '../src/generated/structs';
import type { ISteamUGC } from '../src/generated/interfaces/ISteamUGC';
import type { SteamDispatch } from '../src/runtime/dispatch';

vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof fs>() }));

const FILE_ID = 98765432101234567n;
const HANDLE = 42n;
const OK = EResult.k_EResultOK;

function fixture(methods: Partial<ISteamUGC>, result: unknown) {
  const callResultStruct = vi.fn().mockResolvedValue(result);
  const workshop = new Workshop(methods as ISteamUGC, { callResultStruct } as unknown as SteamDispatch, 480);
  return { workshop, callResultStruct };
}

function queryFixture(results: number[] = [OK]) {
  const layout = layoutOf('SteamUGCDetails_t');
  const offset = (name: string) => layout.fields.find((field) => field.name === name)!.offset;
  const ugc = {
    CreateQueryUGCDetailsRequest: vi.fn().mockReturnValue(HANDLE),
    CreateQueryUserUGCRequest: vi.fn().mockReturnValue(HANDLE),
    SetLanguage: vi.fn().mockReturnValue(true),
    SetReturnLongDescription: vi.fn().mockReturnValue(true),
    SetReturnChildren: vi.fn().mockReturnValue(true),
    SetReturnAdditionalPreviews: vi.fn().mockReturnValue(true),
    SetReturnMetadata: vi.fn().mockReturnValue(true),
    SetReturnKeyValueTags: vi.fn().mockReturnValue(true),
    SendQueryUGCRequest: vi.fn().mockReturnValue(123n),
    ReleaseQueryUGCRequest: vi.fn().mockReturnValue(true),
    GetQueryUGCResult: vi.fn<ISteamUGC['GetQueryUGCResult']>().mockImplementation((_handle, index, buffer) => {
      if (!buffer) throw new Error('expected a details buffer');
      buffer.fill(0);
      buffer.writeInt32LE(results[index], offset('m_eResult'));
      buffer.writeBigUInt64LE(FILE_ID + BigInt(index), offset('m_nPublishedFileId'));
      buffer.write('Test item', offset('m_rgchTitle'));
      return true;
    }),
    GetQueryUGCPreviewURL: vi.fn().mockReturnValue(false),
    GetQueryUGCStatistic: vi.fn().mockReturnValue(false),
    GetQueryUGCNumAdditionalPreviews: vi.fn().mockReturnValue(0),
    GetQueryUGCAdditionalPreview: vi.fn<ISteamUGC['GetQueryUGCAdditionalPreview']>().mockImplementation(
      (_handle, _row, index, url, _urlSize, name, _nameSize, type) => {
        if (!url || !name || !type) throw new Error('expected preview buffers');
        url.write(`https://example.test/${index}.png`);
        name.write(`${index}.png`);
        type.writeInt32LE(0);
        return true;
      },
    ),
  };
  return {
    ugc,
    ...fixture(ugc, { m_eResult: OK, m_handle: HANDLE, m_unNumResultsReturned: results.length, m_unTotalMatchingResults: results.length }),
  };
}

function expectReleased(ugc: ReturnType<typeof queryFixture>['ugc']) {
  expect(ugc.ReleaseQueryUGCRequest).toHaveBeenCalledExactlyOnceWith(HANDLE);
}

describe('Workshop query ownership and row failures (#17, #18)', () => {
  const options = [
    ['SetLanguage', { language: 'german' }],
    ['SetReturnLongDescription', { longDescription: true }],
    ['SetReturnChildren', { children: true }],
    ['SetReturnAdditionalPreviews', { additionalPreviews: true }],
    ['SetReturnMetadata', { metadata: true }],
    ['SetReturnKeyValueTags', { keyValueTags: true }],
  ] as const satisfies ReadonlyArray<readonly [keyof ReturnType<typeof queryFixture>['ugc'], QueryOptions]>;

  it.each(options)('releases without sending when %s returns false', async (setter, opts) => {
    const { workshop, ugc } = queryFixture();
    ugc[setter].mockReturnValue(false);
    await expect(workshop.getItem(FILE_ID, opts)).rejects.toThrow(setter);
    expect(ugc.SendQueryUGCRequest).not.toHaveBeenCalled();
    expectReleased(ugc);
  });

  it('preserves a thrown setup error even when release also throws', async () => {
    const { workshop, ugc } = queryFixture();
    const failure = new Error('setter exception');
    ugc.SetLanguage.mockImplementation(() => { throw failure; });
    ugc.ReleaseQueryUGCRequest.mockImplementation(() => { throw new Error('cleanup exception'); });
    await expect(workshop.getItem(FILE_ID, { language: 'german' })).rejects.toBe(failure);
    expect(ugc.SendQueryUGCRequest).not.toHaveBeenCalled();
    expectReleased(ugc);
  });

  it.each(['details', 'user'] as const)('does not use or release a failed %s allocation', async (kind) => {
    const { workshop, ugc } = queryFixture();
    ugc.CreateQueryUGCDetailsRequest.mockReturnValue(k_UGCQueryHandleInvalid);
    ugc.CreateQueryUserUGCRequest.mockReturnValue(k_UGCQueryHandleInvalid);
    const query = kind === 'details'
      ? workshop.getItem(FILE_ID, { language: 'german' })
      : workshop.getUserItems(1, 123, { language: 'german' });
    await expect(query).rejects.toThrow('invalid handle');
    expect(ugc.SetLanguage).not.toHaveBeenCalled();
    expect(ugc.SendQueryUGCRequest).not.toHaveBeenCalled();
    expect(ugc.ReleaseQueryUGCRequest).not.toHaveBeenCalled();
  });

  it('decodes an OK row and releases once', async () => {
    const { workshop, ugc } = queryFixture();
    await expect(workshop.getItem(FILE_ID)).resolves.toMatchObject({ fileId: FILE_ID, title: 'Test item' });
    expectReleased(ugc);
  });

  it.each([{ results: [] }, { results: [EResult.k_EResultFileNotFound] }])('returns null for missing rows $results', async ({ results }) => {
    const { workshop, ugc } = queryFixture(results);
    await expect(workshop.getItem(FILE_ID)).resolves.toBeNull();
    expectReleased(ugc);
  });

  it.each([EResult.k_EResultAccessDenied, EResult.k_EResultFail])('retains per-item EResult %i and row context', async (result) => {
    const { workshop, ugc } = queryFixture([result]);
    const error = await workshop.getItem(FILE_ID).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(SteamResultError);
    expect(error).toMatchObject({ result, operation: `GetQueryUGCResult (row 0, item ${FILE_ID})` });
    expect(ugc.GetQueryUGCPreviewURL).not.toHaveBeenCalled();
    expectReleased(ugc);
  });

  it('rejects an unreadable row instead of reporting an absent item', async () => {
    const { workshop, ugc } = queryFixture();
    ugc.GetQueryUGCResult.mockReturnValue(false);
    await expect(workshop.getItem(FILE_ID)).rejects.toThrow('GetQueryUGCResult (row 0)');
    expectReleased(ugc);
  });

  it('rejects a mixed page instead of returning a successful subset', async () => {
    const { workshop, ugc } = queryFixture([OK, EResult.k_EResultAccessDenied, OK]);
    await expect(workshop.getUserItems(1, 123)).rejects.toMatchObject({
      result: EResult.k_EResultAccessDenied,
      operation: `GetQueryUGCResult (row 1, item ${FILE_ID + 1n})`,
    });
    expectReleased(ugc);
  });

  it('skips only file-not-found rows while preserving the native total', async () => {
    const { workshop, ugc } = queryFixture([OK, EResult.k_EResultFileNotFound, OK]);
    const page = await workshop.getUserItems(1, 123);
    expect(page.items.map((item) => item.fileId)).toEqual([FILE_ID, FILE_ID + 2n]);
    expect(page.totalResults).toBe(3);
    expectReleased(ugc);
  });

  it('releases when sending throws', async () => {
    const { workshop, ugc } = queryFixture();
    const failure = new Error('send exception');
    ugc.SendQueryUGCRequest.mockImplementation(() => { throw failure; });
    await expect(workshop.getItem(FILE_ID)).rejects.toBe(failure);
    expectReleased(ugc);
  });

  it('preserves a dispatch failure when release returns false', async () => {
    const { workshop, ugc, callResultStruct } = queryFixture();
    const failure = new Error('dispatch failure');
    callResultStruct.mockRejectedValue(failure);
    ugc.ReleaseQueryUGCRequest.mockReturnValue(false);
    await expect(workshop.getItem(FILE_ID)).rejects.toBe(failure);
    expectReleased(ugc);
  });

  it('rejects an overall query failure before reading rows', async () => {
    const { workshop, ugc, callResultStruct } = queryFixture();
    callResultStruct.mockResolvedValue({ m_eResult: EResult.k_EResultFail });
    await expect(workshop.getItem(FILE_ID)).rejects.toMatchObject({ result: EResult.k_EResultFail });
    expect(ugc.GetQueryUGCResult).not.toHaveBeenCalled();
    expectReleased(ugc);
  });

  it('releases when item decoding throws', async () => {
    const { workshop, ugc } = queryFixture();
    const failure = new Error('preview decoding exception');
    ugc.GetQueryUGCPreviewURL.mockImplementation(() => { throw failure; });
    await expect(workshop.getItem(FILE_ID)).rejects.toBe(failure);
    expectReleased(ugc);
  });

  it('reports a cleanup failure when the query otherwise succeeded', async () => {
    const { workshop, ugc } = queryFixture();
    ugc.ReleaseQueryUGCRequest.mockReturnValue(false);
    await expect(workshop.getItem(FILE_ID)).rejects.toThrow('ReleaseQueryUGCRequest');
    expectReleased(ugc);
  });
});

describe('Workshop complete additional previews (#16)', () => {
  it('returns all previews in native index order', async () => {
    const { workshop, ugc } = queryFixture();
    ugc.GetQueryUGCNumAdditionalPreviews.mockReturnValue(3);
    const item = await workshop.getItem(FILE_ID, { additionalPreviews: true });
    expect(item!.additionalPreviews).toEqual([0, 1, 2].map((index) => ({
      index, type: 0, urlOrVideoId: `https://example.test/${index}.png`, originalFileName: `${index}.png`,
    })));
    expectReleased(ugc);
  });

  it.each([0, 1, 2])('rejects a failed preview at index %i with item context', async (failedIndex) => {
    const { workshop, ugc } = queryFixture();
    ugc.GetQueryUGCNumAdditionalPreviews.mockReturnValue(3);
    ugc.GetQueryUGCAdditionalPreview.mockImplementation((_handle, _row, index) => index !== failedIndex);
    await expect(workshop.getItem(FILE_ID, { additionalPreviews: true })).rejects.toThrow(
      `GetQueryUGCAdditionalPreview (item ${FILE_ID}, row 0, preview ${failedIndex})`,
    );
    expectReleased(ugc);
  });

  it('returns a complete empty gallery when Steam reports zero previews', async () => {
    const { workshop, ugc } = queryFixture();
    await expect(workshop.getItem(FILE_ID, { additionalPreviews: true })).resolves.toMatchObject({ additionalPreviews: [] });
    expect(ugc.GetQueryUGCNumAdditionalPreviews).toHaveBeenCalledExactlyOnceWith(HANDLE, 0);
    expect(ugc.GetQueryUGCAdditionalPreview).not.toHaveBeenCalled();
    expectReleased(ugc);
  });

  it.each([{}, { additionalPreviews: false }])('does not read the gallery when not requested: %j', async (opts) => {
    const { workshop, ugc } = queryFixture();
    ugc.GetQueryUGCNumAdditionalPreviews.mockReturnValue(3);
    await expect(workshop.getItem(FILE_ID, opts)).resolves.toMatchObject({ additionalPreviews: [] });
    expect(ugc.GetQueryUGCNumAdditionalPreviews).not.toHaveBeenCalled();
    expect(ugc.GetQueryUGCAdditionalPreview).not.toHaveBeenCalled();
    expectReleased(ugc);
  });
});

function updateFixture() {
  const ugc = {
    StartItemUpdate: vi.fn().mockReturnValue(HANDLE),
    SetItemContent: vi.fn().mockReturnValue(true),
    SetItemPreview: vi.fn().mockReturnValue(true),
    AddItemPreviewFile: vi.fn().mockReturnValue(true),
    SetItemUpdateLanguage: vi.fn().mockReturnValue(true),
    SubmitItemUpdate: vi.fn().mockReturnValue(123n),
  };
  return { ugc, ...fixture(ugc, { m_eResult: OK, m_bUserNeedsToAcceptWorkshopLegalAgreement: false }) };
}

describe('Workshop upload preflight (#19)', () => {
  let directory: string;
  let content: string;
  let preview: string;

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steamwand-path-test-'));
    content = path.join(directory, 'content');
    preview = path.join(directory, 'preview.png');
    fs.mkdirSync(content);
    fs.writeFileSync(preview, 'Path validation does not decode images.');
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => {
    // Only remove the temporary directory created by this suite.
    expect(path.dirname(path.resolve(directory))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(directory)).toMatch(/^steamwand-path-test-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const fields = ['contentPath', 'previewPath', 'previewImages'] as const;
  function updateFor(field: typeof fields[number], input: string): WorkshopItemUpdate {
    return field === 'previewImages' ? { previewImages: [preview, input] } : { [field]: input };
  }
  const label = (field: typeof fields[number]) => field === 'previewImages' ? 'previewImages[1]' : field;

  it.each(fields)('rejects missing %s before allocating an update', async (field) => {
    const { workshop, ugc } = updateFixture();
    const input = path.join(directory, 'missing');
    const error = await workshop.submitUpdate(FILE_ID, updateFor(field, input)).catch((error: unknown) => error);
    expect(error).toMatchObject({ cause: { code: 'ENOENT' } });
    expect((error as Error).message).toContain(label(field));
    expect((error as Error).message).toContain(JSON.stringify(input));
    expect(ugc.StartItemUpdate).not.toHaveBeenCalled();
  });

  it.each(fields)('rejects the wrong path type for %s before allocating an update', async (field) => {
    const { workshop, ugc } = updateFixture();
    const input = field === 'contentPath' ? preview : content;
    const error = await workshop.submitUpdate(FILE_ID, updateFor(field, input)).catch((error: unknown) => error);
    expect((error as Error).message).toContain(label(field));
    expect((error as Error).message).toContain(JSON.stringify(input));
    expect((error as Error).message).toContain(`expected a ${field === 'contentPath' ? 'directory' : 'regular file'}`);
    expect(ugc.StartItemUpdate).not.toHaveBeenCalled();
  });

  it.each(fields)('rejects relative %s before allocating an update', async (field) => {
    const { workshop, ugc } = updateFixture();
    await expect(workshop.submitUpdate(FILE_ID, updateFor(field, 'relative/path'))).rejects.toThrow(`${label(field)} must be an absolute path`);
    expect(ugc.StartItemUpdate).not.toHaveBeenCalled();
  });

  it('passes valid paths to the native setters unchanged', async () => {
    const { workshop, ugc } = updateFixture();
    await expect(workshop.submitUpdate(FILE_ID, { contentPath: content, previewPath: preview, previewImages: [preview] }))
      .resolves.toEqual({ legalAgreementRequired: false });
    expect(ugc.SetItemContent).toHaveBeenCalledExactlyOnceWith(HANDLE, content);
    expect(ugc.SetItemPreview).toHaveBeenCalledExactlyOnceWith(HANDLE, preview);
    expect(ugc.AddItemPreviewFile).toHaveBeenCalledExactlyOnceWith(HANDLE, preview, 0);
    expect(ugc.SubmitItemUpdate).toHaveBeenCalledExactlyOnceWith(HANDLE, null);
  });

  it.each(['statSync', 'opendirSync', 'openSync'] as const)('preserves permission errors from %s', async (method) => {
    const { workshop, ugc } = updateFixture();
    const cause = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.spyOn(fs, method).mockImplementation(() => { throw cause; });
    const field = method === 'openSync' ? 'previewPath' : 'contentPath';
    const error = await workshop.submitUpdate(FILE_ID, updateFor(field, method === 'openSync' ? preview : content))
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ cause });
    expect((error as Error).message).toContain(field);
    expect((error as Error).message).toContain('permission denied');
    expect(ugc.StartItemUpdate).not.toHaveBeenCalled();
  });

  it('follows directory links, rejects them as previews, and reports broken targets', async () => {
    const link = path.join(directory, 'content-link');
    const broken = path.join(directory, 'broken-link');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(content, link, linkType);
    fs.symlinkSync(path.join(directory, 'missing-target'), broken, linkType);
    const valid = updateFixture();
    await expect(valid.workshop.submitUpdate(FILE_ID, { contentPath: link })).resolves.toBeDefined();
    expect(valid.ugc.SetItemContent).toHaveBeenCalledExactlyOnceWith(HANDLE, link);
    for (const field of ['previewPath', 'previewImages'] as const) {
      const invalid = updateFixture();
      await expect(invalid.workshop.submitUpdate(FILE_ID, updateFor(field, link))).rejects.toThrow('regular file');
      expect(invalid.ugc.StartItemUpdate).not.toHaveBeenCalled();
    }
    const invalid = updateFixture();
    await expect(invalid.workshop.submitUpdate(FILE_ID, { contentPath: broken })).rejects.toMatchObject({ cause: { code: 'ENOENT' } });
    expect(invalid.ugc.StartItemUpdate).not.toHaveBeenCalled();
  });

  it('follows file links and rejects file links as content', async (context) => {
    const link = path.join(directory, 'preview-link.png');
    try {
      fs.symlinkSync(preview, link, 'file');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        context.skip(true, 'Windows file symlinks require Developer Mode or symlink privileges');
        return;
      }
      throw error;
    }
    const valid = updateFixture();
    await expect(valid.workshop.submitUpdate(FILE_ID, { previewPath: link, previewImages: [link] })).resolves.toBeDefined();
    const invalid = updateFixture();
    await expect(invalid.workshop.submitUpdate(FILE_ID, { contentPath: link })).rejects.toThrow('expected a directory');
    expect(invalid.ugc.StartItemUpdate).not.toHaveBeenCalled();
  });
});

describe('Workshop app dependency completeness (#20)', () => {
  function dependencies(count: number, totalCount: number, byteLength = 128) {
    const buffer = Buffer.alloc(byteLength);
    for (let i = 0; i < Math.floor(byteLength / 4); i++) buffer.writeUInt32LE(480 + i, i * 4);
    const result: GetAppDependenciesResult_t = {
      m_eResult: OK, m_nPublishedFileId: FILE_ID, m_rgAppIDs: buffer,
      m_nNumAppDependencies: count, m_nTotalNumAppDependencies: totalCount,
    };
    return fixture({ GetAppDependencies: vi.fn().mockReturnValue(123n) }, result);
  }

  it.each([[0, 0, true], [3, 3, true], [32, 32, true], [32, 40, false], [0, 4, false]] as const)(
    'reports %i returned of %i total as complete=%s', async (count, totalCount, complete) => {
      const { workshop } = dependencies(count, totalCount);
      await expect(workshop.getAppDependenciesResult(FILE_ID)).resolves.toEqual({
        appIds: Array.from({ length: count }, (_, i) => 480 + i), totalCount, complete,
      });
    },
  );

  it.each([[33, 40, 132], [32, 40, 127], [3, 2, 128], [-1, 0, 128], [1.5, 2, 128], [0, -1, 128], [0, NaN, 128], [0, 2 ** 32, 128]])(
    'rejects inconsistent counts or buffers (%s, %s, %s)', async (count, totalCount, bytes) => {
      const { workshop } = dependencies(count, totalCount, bytes);
      await expect(workshop.getAppDependenciesResult(FILE_ID)).rejects.toThrow('GetAppDependencies returned invalid counts');
    },
  );

  it('keeps the legacy array return for existing callers', async () => {
    const { workshop } = dependencies(32, 40);
    await expect(workshop.getAppDependencies(FILE_ID)).resolves.toEqual(Array.from({ length: 32 }, (_, i) => 480 + i));
  });

  it.each(['getAppDependencies', 'getAppDependenciesResult'] as const)('retains Steam errors through %s', async (method) => {
    const { workshop, callResultStruct } = dependencies(0, 0);
    callResultStruct.mockResolvedValue({ m_eResult: EResult.k_EResultAccessDenied });
    await expect(workshop[method](FILE_ID)).rejects.toMatchObject({
      name: 'SteamResultError', operation: 'GetAppDependencies', result: EResult.k_EResultAccessDenied,
    });
  });
});

it('submits one language-labeled note with the content update (#15)', async () => {
  const { workshop, ugc } = updateFixture();
  const note = 'English:\nFixed the map.\n\nDeutsch:\nKarte korrigiert.';
  await workshop.submitUpdate(FILE_ID, { contentPath: path.resolve('test'), language: 'german', changeNote: note });
  expect(ugc.SetItemUpdateLanguage).toHaveBeenCalledExactlyOnceWith(HANDLE, 'german');
  expect(ugc.SubmitItemUpdate).toHaveBeenCalledExactlyOnceWith(HANDLE, note);
});
