/**
 * Offline test for the after-close guard in `SteamNative`.
 *
 * Loading the bundled library and binding symbols needs no Steam client;
 * `SteamAPI_Shutdown` before any init is a no-op in the redistributable. What
 * matters is that the next `func()` call throws instead of reaching the
 * unloaded API, which would crash the process.
 */
import { describe, expect, test } from 'vitest';
import { SteamNative } from '../src/runtime/native';

describe('SteamNative', () => {
  test('func() throws after shutdown instead of calling into Steam', () => {
    const nat = new SteamNative();
    expect(typeof nat.func('SteamAPI_IsSteamRunning', 'bool', [])).toBe('function');
    nat.shutdown();
    expect(() => nat.func('SteamAPI_IsSteamRunning', 'bool', [])).toThrow(/after close\(\)/);
  });
});
