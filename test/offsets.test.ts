/**
 * Offset regression tests for the workshop struct set.
 *
 * Expected values were verified 2026-08-31 against steamworks-sys 0.13.0's
 * bindgen layout asserts (independent of our generator): 428 comparisons,
 * 0 diffs. If an SDK bump moves any of these, this test fails and the new
 * values must be re-verified before being accepted.
 */
import { describe, expect, test } from 'vitest';
import { callbackId, callbacksById } from '../src/generated/callbacks';
import { structLayouts } from '../src/generated/structs';
import type { StructLayout } from '../src/runtime/struct';

function offsets(l: StructLayout): Record<string, number> {
  return Object.fromEntries(l.fields.map((f) => [f.name, f.offset]));
}

describe('workshop callback ids', () => {
  test('ids match ISteamUGC constants', () => {
    expect(callbackId.SteamUGCQueryCompleted_t).toBe(3401);
    expect(callbackId.CreateItemResult_t).toBe(3403);
    expect(callbackId.SubmitItemUpdateResult_t).toBe(3404);
    expect(callbackId.ItemInstalled_t).toBe(3405);
    expect(callbackId.DownloadItemResult_t).toBe(3406);
    expect(callbacksById[3403]?.name).toBe('CreateItemResult_t');
  });
});

describe('workshop struct layouts', () => {
  test('CreateItemResult_t', () => {
    const l = structLayouts.CreateItemResult_t;
    expect(l.win64.size).toBe(24);
    expect(offsets(l.win64)).toEqual({
      m_eResult: 0,
      m_nPublishedFileId: 8,
      m_bUserNeedsToAcceptWorkshopLegalAgreement: 16,
    });
    expect(l.posix.size).toBe(16);
    expect(offsets(l.posix)).toEqual({
      m_eResult: 0,
      m_nPublishedFileId: 4,
      m_bUserNeedsToAcceptWorkshopLegalAgreement: 12,
    });
  });

  test('SubmitItemUpdateResult_t', () => {
    const l = structLayouts.SubmitItemUpdateResult_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(16);
      expect(offsets(p)).toEqual({
        m_eResult: 0,
        m_bUserNeedsToAcceptWorkshopLegalAgreement: 4,
        m_nPublishedFileId: 8,
      });
    }
  });

  test('SteamUGCQueryCompleted_t', () => {
    const l = structLayouts.SteamUGCQueryCompleted_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(280);
      expect(offsets(p)).toEqual({
        m_handle: 0,
        m_eResult: 8,
        m_unNumResultsReturned: 12,
        m_unTotalMatchingResults: 16,
        m_bCachedData: 20,
        m_rgchNextCursor: 21,
      });
    }
  });

  test('SteamUGCDetails_t key fields', () => {
    const l = structLayouts.SteamUGCDetails_t;
    expect(l.win64.size).toBe(9784);
    const w = offsets(l.win64);
    expect(w.m_rgchTitle).toBe(24);
    expect(w.m_rgchDescription).toBe(153);
    expect(w.m_ulSteamIDOwner).toBe(8160);
    expect(w.m_rgchTags).toBe(8187);
    expect(w.m_rgchURL).toBe(9500);
    expect(w.m_ulTotalFilesSize).toBe(9776);
    expect(l.posix.size).toBe(9772);
    const p = offsets(l.posix);
    expect(p.m_rgchTitle).toBe(24);
    expect(p.m_ulSteamIDOwner).toBe(8156);
    expect(p.m_rgchTags).toBe(8183);
    expect(p.m_ulTotalFilesSize).toBe(9764);
  });

  test('ItemInstalled_t / DownloadItemResult_t', () => {
    expect(structLayouts.ItemInstalled_t.win64.size).toBe(32);
    expect(structLayouts.ItemInstalled_t.posix.size).toBe(28);
    expect(structLayouts.DownloadItemResult_t.win64.size).toBe(24);
    expect(structLayouts.DownloadItemResult_t.posix.size).toBe(16);
  });
});
