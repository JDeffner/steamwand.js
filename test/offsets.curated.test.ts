/**
 * Offset regression tests for every struct the curated layers in `src/api/`
 * decode, beyond the workshop set pinned in `offsets.test.ts`.
 *
 * Expected values were verified 2026-09-03 against steamworks-sys 0.13.0's
 * bindgen layout asserts (independent of our generator), reading its Windows
 * table for `win64` and its Linux and macOS tables for `posix`: 450
 * comparisons, 0 diffs. If an SDK bump moves any of these, this test fails
 * and the new values must be re-verified before being accepted.
 */
import { describe, expect, test } from 'vitest';
import { callbackId } from '../src/generated/callbacks';
import { structLayouts } from '../src/generated/structs';
import type { StructLayout } from '../src/runtime/struct';

function offsets(l: StructLayout): Record<string, number> {
  return Object.fromEntries(l.fields.map((f) => [f.name, f.offset]));
}

describe('curated callback ids', () => {
  test('ids match the SDK k_iCallback constants', () => {
    expect(callbackId.AddAppDependencyResult_t).toBe(3414);
    expect(callbackId.RemoveAppDependencyResult_t).toBe(3415);
    expect(callbackId.GetAppDependenciesResult_t).toBe(3416);
    expect(callbackId.AddUGCDependencyResult_t).toBe(3412);
    expect(callbackId.RemoveUGCDependencyResult_t).toBe(3413);
    expect(callbackId.DeleteItemResult_t).toBe(3417);
    expect(callbackId.UserStatsReceived_t).toBe(1101);
    expect(callbackId.GlobalAchievementPercentagesReady_t).toBe(1110);
    expect(callbackId.NumberOfCurrentPlayers_t).toBe(1107);
    expect(callbackId.RemoteStorageFileReadAsyncComplete_t).toBe(1332);
    expect(callbackId.RemoteStorageFileWriteAsyncComplete_t).toBe(1331);
    expect(callbackId.LeaderboardFindResult_t).toBe(1104);
    expect(callbackId.LeaderboardScoresDownloaded_t).toBe(1105);
    expect(callbackId.LeaderboardScoreUploaded_t).toBe(1106);
    expect(callbackId.LeaderboardUGCSet_t).toBe(1111);
    expect(callbackId.LobbyCreated_t).toBe(513);
    expect(callbackId.LobbyEnter_t).toBe(504);
    expect(callbackId.LobbyMatchList_t).toBe(510);
    expect(callbackId.LobbyChatMsg_t).toBe(507);
    expect(callbackId.PersonaStateChange_t).toBe(304);
    expect(callbackId.GameLobbyJoinRequested_t).toBe(333);
    expect(callbackId.GameRichPresenceJoinRequested_t).toBe(337);
    expect(callbackId.GameOverlayActivated_t).toBe(331);
    expect(callbackId.GamepadTextInputDismissed_t).toBe(714);
    expect(callbackId.GetAuthSessionTicketResponse_t).toBe(163);
    expect(callbackId.GetTicketForWebApiResponse_t).toBe(168);
    expect(callbackId.ValidateAuthTicketResponse_t).toBe(143);
    expect(callbackId.EncryptedAppTicketResponse_t).toBe(154);
    expect(callbackId.IPCountry_t).toBe(701);
    expect(callbackId.LowBatteryPower_t).toBe(702);
    expect(callbackId.ScreenshotReady_t).toBe(2301);
    expect(callbackId.ScreenshotRequested_t).toBe(2302);
    expect(callbackId.SteamInputDeviceConnected_t).toBe(2801);
    expect(callbackId.SteamInputDeviceDisconnected_t).toBe(2802);
    expect(callbackId.SteamInputConfigurationLoaded_t).toBe(2803);
  });
});

describe('workshop dependency and delete results (apps + workshop layers)', () => {
  test('AddAppDependencyResult_t', () => {
    const l = structLayouts.AddAppDependencyResult_t;
    expect(l.win64.size).toBe(24);
    expect(offsets(l.win64)).toEqual({
      m_eResult: 0,
      m_nPublishedFileId: 8,
      m_nAppID: 16,
    });
    expect(l.posix.size).toBe(16);
    expect(offsets(l.posix)).toEqual({
      m_eResult: 0,
      m_nPublishedFileId: 4,
      m_nAppID: 12,
    });
  });

  test('RemoveAppDependencyResult_t', () => {
    const l = structLayouts.RemoveAppDependencyResult_t;
    expect(l.win64.size).toBe(24);
    expect(offsets(l.win64)).toEqual({
      m_eResult: 0,
      m_nPublishedFileId: 8,
      m_nAppID: 16,
    });
    expect(l.posix.size).toBe(16);
    expect(offsets(l.posix)).toEqual({
      m_eResult: 0,
      m_nPublishedFileId: 4,
      m_nAppID: 12,
    });
  });

  test('GetAppDependenciesResult_t', () => {
    const l = structLayouts.GetAppDependenciesResult_t;
    expect(l.win64.size).toBe(152);
    expect(offsets(l.win64)).toEqual({
      m_eResult: 0,
      m_nPublishedFileId: 8,
      m_rgAppIDs: 16,
      m_nNumAppDependencies: 144,
      m_nTotalNumAppDependencies: 148,
    });
    expect(l.posix.size).toBe(148);
    expect(offsets(l.posix)).toEqual({
      m_eResult: 0,
      m_nPublishedFileId: 4,
      m_rgAppIDs: 12,
      m_nNumAppDependencies: 140,
      m_nTotalNumAppDependencies: 144,
    });
  });

  test('AddUGCDependencyResult_t', () => {
    const l = structLayouts.AddUGCDependencyResult_t;
    expect(l.win64.size).toBe(24);
    expect(offsets(l.win64)).toEqual({
      m_eResult: 0,
      m_nPublishedFileId: 8,
      m_nChildPublishedFileId: 16,
    });
    expect(l.posix.size).toBe(20);
    expect(offsets(l.posix)).toEqual({
      m_eResult: 0,
      m_nPublishedFileId: 4,
      m_nChildPublishedFileId: 12,
    });
  });

  test('RemoveUGCDependencyResult_t', () => {
    const l = structLayouts.RemoveUGCDependencyResult_t;
    expect(l.win64.size).toBe(24);
    expect(offsets(l.win64)).toEqual({
      m_eResult: 0,
      m_nPublishedFileId: 8,
      m_nChildPublishedFileId: 16,
    });
    expect(l.posix.size).toBe(20);
    expect(offsets(l.posix)).toEqual({
      m_eResult: 0,
      m_nPublishedFileId: 4,
      m_nChildPublishedFileId: 12,
    });
  });

  test('DeleteItemResult_t', () => {
    const l = structLayouts.DeleteItemResult_t;
    expect(l.win64.size).toBe(16);
    expect(offsets(l.win64)).toEqual({
      m_eResult: 0,
      m_nPublishedFileId: 8,
    });
    expect(l.posix.size).toBe(12);
    expect(offsets(l.posix)).toEqual({
      m_eResult: 0,
      m_nPublishedFileId: 4,
    });
  });
});

describe('stats layer', () => {
  test('UserStatsReceived_t', () => {
    const l = structLayouts.UserStatsReceived_t;
    expect(l.win64.size).toBe(24);
    expect(offsets(l.win64)).toEqual({
      m_nGameID: 0,
      m_eResult: 8,
      m_steamIDUser: 12,
    });
    expect(l.posix.size).toBe(20);
    expect(offsets(l.posix)).toEqual({
      m_nGameID: 0,
      m_eResult: 8,
      m_steamIDUser: 12,
    });
  });

  test('GlobalAchievementPercentagesReady_t', () => {
    const l = structLayouts.GlobalAchievementPercentagesReady_t;
    expect(l.win64.size).toBe(16);
    expect(offsets(l.win64)).toEqual({
      m_nGameID: 0,
      m_eResult: 8,
    });
    expect(l.posix.size).toBe(12);
    expect(offsets(l.posix)).toEqual({
      m_nGameID: 0,
      m_eResult: 8,
    });
  });

  test('NumberOfCurrentPlayers_t', () => {
    const l = structLayouts.NumberOfCurrentPlayers_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(8);
      expect(offsets(p)).toEqual({
        m_bSuccess: 0,
        m_cPlayers: 4,
      });
    }
  });
});

describe('cloud layer', () => {
  test('RemoteStorageFileReadAsyncComplete_t', () => {
    const l = structLayouts.RemoteStorageFileReadAsyncComplete_t;
    expect(l.win64.size).toBe(24);
    expect(offsets(l.win64)).toEqual({
      m_hFileReadAsync: 0,
      m_eResult: 8,
      m_nOffset: 12,
      m_cubRead: 16,
    });
    expect(l.posix.size).toBe(20);
    expect(offsets(l.posix)).toEqual({
      m_hFileReadAsync: 0,
      m_eResult: 8,
      m_nOffset: 12,
      m_cubRead: 16,
    });
  });

  test('RemoteStorageFileWriteAsyncComplete_t', () => {
    const l = structLayouts.RemoteStorageFileWriteAsyncComplete_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(4);
      expect(offsets(p)).toEqual({
        m_eResult: 0,
      });
    }
  });
});

describe('leaderboards layer', () => {
  test('LeaderboardFindResult_t', () => {
    const l = structLayouts.LeaderboardFindResult_t;
    expect(l.win64.size).toBe(16);
    expect(offsets(l.win64)).toEqual({
      m_hSteamLeaderboard: 0,
      m_bLeaderboardFound: 8,
    });
    expect(l.posix.size).toBe(12);
    expect(offsets(l.posix)).toEqual({
      m_hSteamLeaderboard: 0,
      m_bLeaderboardFound: 8,
    });
  });

  test('LeaderboardScoresDownloaded_t', () => {
    const l = structLayouts.LeaderboardScoresDownloaded_t;
    expect(l.win64.size).toBe(24);
    expect(offsets(l.win64)).toEqual({
      m_hSteamLeaderboard: 0,
      m_hSteamLeaderboardEntries: 8,
      m_cEntryCount: 16,
    });
    expect(l.posix.size).toBe(20);
    expect(offsets(l.posix)).toEqual({
      m_hSteamLeaderboard: 0,
      m_hSteamLeaderboardEntries: 8,
      m_cEntryCount: 16,
    });
  });

  test('LeaderboardEntry_t', () => {
    const l = structLayouts.LeaderboardEntry_t;
    expect(l.win64.size).toBe(32);
    expect(offsets(l.win64)).toEqual({
      m_steamIDUser: 0,
      m_nGlobalRank: 8,
      m_nScore: 12,
      m_cDetails: 16,
      m_hUGC: 24,
    });
    expect(l.posix.size).toBe(28);
    expect(offsets(l.posix)).toEqual({
      m_steamIDUser: 0,
      m_nGlobalRank: 8,
      m_nScore: 12,
      m_cDetails: 16,
      m_hUGC: 20,
    });
  });

  test('LeaderboardScoreUploaded_t', () => {
    const l = structLayouts.LeaderboardScoreUploaded_t;
    expect(l.win64.size).toBe(32);
    expect(offsets(l.win64)).toEqual({
      m_bSuccess: 0,
      m_hSteamLeaderboard: 8,
      m_nScore: 16,
      m_bScoreChanged: 20,
      m_nGlobalRankNew: 24,
      m_nGlobalRankPrevious: 28,
    });
    expect(l.posix.size).toBe(28);
    expect(offsets(l.posix)).toEqual({
      m_bSuccess: 0,
      m_hSteamLeaderboard: 4,
      m_nScore: 12,
      m_bScoreChanged: 16,
      m_nGlobalRankNew: 20,
      m_nGlobalRankPrevious: 24,
    });
  });

  test('LeaderboardUGCSet_t', () => {
    const l = structLayouts.LeaderboardUGCSet_t;
    expect(l.win64.size).toBe(16);
    expect(offsets(l.win64)).toEqual({
      m_eResult: 0,
      m_hSteamLeaderboard: 8,
    });
    expect(l.posix.size).toBe(12);
    expect(offsets(l.posix)).toEqual({
      m_eResult: 0,
      m_hSteamLeaderboard: 4,
    });
  });
});

describe('lobbies layer', () => {
  test('LobbyCreated_t', () => {
    const l = structLayouts.LobbyCreated_t;
    expect(l.win64.size).toBe(16);
    expect(offsets(l.win64)).toEqual({
      m_eResult: 0,
      m_ulSteamIDLobby: 8,
    });
    expect(l.posix.size).toBe(12);
    expect(offsets(l.posix)).toEqual({
      m_eResult: 0,
      m_ulSteamIDLobby: 4,
    });
  });

  test('LobbyEnter_t', () => {
    const l = structLayouts.LobbyEnter_t;
    expect(l.win64.size).toBe(24);
    expect(offsets(l.win64)).toEqual({
      m_ulSteamIDLobby: 0,
      m_rgfChatPermissions: 8,
      m_bLocked: 12,
      m_EChatRoomEnterResponse: 16,
    });
    expect(l.posix.size).toBe(20);
    expect(offsets(l.posix)).toEqual({
      m_ulSteamIDLobby: 0,
      m_rgfChatPermissions: 8,
      m_bLocked: 12,
      m_EChatRoomEnterResponse: 16,
    });
  });

  test('LobbyMatchList_t', () => {
    const l = structLayouts.LobbyMatchList_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(4);
      expect(offsets(p)).toEqual({
        m_nLobbiesMatching: 0,
      });
    }
  });

  test('LobbyChatMsg_t', () => {
    const l = structLayouts.LobbyChatMsg_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(24);
      expect(offsets(p)).toEqual({
        m_ulSteamIDLobby: 0,
        m_ulSteamIDUser: 8,
        m_eChatEntryType: 16,
        m_iChatID: 20,
      });
    }
  });
});

describe('social layer', () => {
  test('PersonaStateChange_t', () => {
    const l = structLayouts.PersonaStateChange_t;
    expect(l.win64.size).toBe(16);
    expect(offsets(l.win64)).toEqual({
      m_ulSteamID: 0,
      m_nChangeFlags: 8,
    });
    expect(l.posix.size).toBe(12);
    expect(offsets(l.posix)).toEqual({
      m_ulSteamID: 0,
      m_nChangeFlags: 8,
    });
  });

  test('GameLobbyJoinRequested_t', () => {
    const l = structLayouts.GameLobbyJoinRequested_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(16);
      expect(offsets(p)).toEqual({
        m_steamIDLobby: 0,
        m_steamIDFriend: 8,
      });
    }
  });

  test('GameRichPresenceJoinRequested_t', () => {
    const l = structLayouts.GameRichPresenceJoinRequested_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(264);
      expect(offsets(p)).toEqual({
        m_steamIDFriend: 0,
        m_rgchConnect: 8,
      });
    }
  });
});

describe('overlay layer', () => {
  test('GameOverlayActivated_t', () => {
    const l = structLayouts.GameOverlayActivated_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(12);
      expect(offsets(p)).toEqual({
        m_bActive: 0,
        m_bUserInitiated: 1,
        m_nAppID: 4,
        m_dwOverlayPID: 8,
      });
    }
  });

  test('GamepadTextInputDismissed_t', () => {
    const l = structLayouts.GamepadTextInputDismissed_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(12);
      expect(offsets(p)).toEqual({
        m_bSubmitted: 0,
        m_unSubmittedText: 4,
        m_unAppID: 8,
      });
    }
  });
});

describe('auth layer', () => {
  test('GetAuthSessionTicketResponse_t', () => {
    const l = structLayouts.GetAuthSessionTicketResponse_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(8);
      expect(offsets(p)).toEqual({
        m_hAuthTicket: 0,
        m_eResult: 4,
      });
    }
  });

  test('GetTicketForWebApiResponse_t', () => {
    const l = structLayouts.GetTicketForWebApiResponse_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(2572);
      expect(offsets(p)).toEqual({
        m_hAuthTicket: 0,
        m_eResult: 4,
        m_cubTicket: 8,
        m_rgubTicket: 12,
      });
    }
  });

  test('ValidateAuthTicketResponse_t', () => {
    const l = structLayouts.ValidateAuthTicketResponse_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(20);
      expect(offsets(p)).toEqual({
        m_SteamID: 0,
        m_eAuthSessionResponse: 8,
        m_OwnerSteamID: 12,
      });
    }
  });

  test('EncryptedAppTicketResponse_t', () => {
    const l = structLayouts.EncryptedAppTicketResponse_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(4);
      expect(offsets(p)).toEqual({
        m_eResult: 0,
      });
    }
  });
});

describe('system layer', () => {
  test('IPCountry_t', () => {
    const l = structLayouts.IPCountry_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(1);
      expect(offsets(p)).toEqual({});
    }
  });

  test('LowBatteryPower_t', () => {
    const l = structLayouts.LowBatteryPower_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(1);
      expect(offsets(p)).toEqual({
        m_nMinutesBatteryLeft: 0,
      });
    }
  });
});

describe('capture layer', () => {
  test('ScreenshotReady_t', () => {
    const l = structLayouts.ScreenshotReady_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(8);
      expect(offsets(p)).toEqual({
        m_hLocal: 0,
        m_eResult: 4,
      });
    }
  });

  test('ScreenshotRequested_t', () => {
    const l = structLayouts.ScreenshotRequested_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(1);
      expect(offsets(p)).toEqual({});
    }
  });
});

describe('controllers layer', () => {
  test('SteamInputDeviceConnected_t', () => {
    const l = structLayouts.SteamInputDeviceConnected_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(8);
      expect(offsets(p)).toEqual({
        m_ulConnectedDeviceHandle: 0,
      });
    }
  });

  test('SteamInputDeviceDisconnected_t', () => {
    const l = structLayouts.SteamInputDeviceDisconnected_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(8);
      expect(offsets(p)).toEqual({
        m_ulDisconnectedDeviceHandle: 0,
      });
    }
  });

  test('SteamInputConfigurationLoaded_t', () => {
    const l = structLayouts.SteamInputConfigurationLoaded_t;
    expect(l.win64.size).toBe(40);
    expect(offsets(l.win64)).toEqual({
      m_unAppID: 0,
      m_ulDeviceHandle: 8,
      m_ulMappingCreator: 16,
      m_unMajorRevision: 24,
      m_unMinorRevision: 28,
      m_bUsesSteamInputAPI: 32,
      m_bUsesGamepadAPI: 33,
    });
    expect(l.posix.size).toBe(32);
    expect(offsets(l.posix)).toEqual({
      m_unAppID: 0,
      m_ulDeviceHandle: 4,
      m_ulMappingCreator: 12,
      m_unMajorRevision: 20,
      m_unMinorRevision: 24,
      m_bUsesSteamInputAPI: 28,
      m_bUsesGamepadAPI: 29,
    });
  });
});

describe('controllers layer by-value action data (pack(1), same on every platform)', () => {
  test('InputDigitalActionData_t', () => {
    const l = structLayouts.InputDigitalActionData_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(2);
      expect(offsets(p)).toEqual({
        bState: 0,
        bActive: 1,
      });
    }
  });

  test('InputAnalogActionData_t', () => {
    const l = structLayouts.InputAnalogActionData_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(13);
      expect(offsets(p)).toEqual({
        eMode: 0,
        x: 4,
        y: 8,
        bActive: 12,
      });
    }
  });

  test('InputMotionData_t', () => {
    const l = structLayouts.InputMotionData_t;
    for (const p of [l.win64, l.posix]) {
      expect(p.size).toBe(40);
      expect(offsets(p)).toEqual({
        rotQuatX: 0,
        rotQuatY: 4,
        rotQuatZ: 8,
        rotQuatW: 12,
        posAccelX: 16,
        posAccelY: 20,
        posAccelZ: 24,
        rotVelX: 28,
        rotVelY: 32,
        rotVelZ: 36,
      });
    }
  });
});
