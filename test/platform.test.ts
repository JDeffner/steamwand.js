/**
 * Offline tests for platform detection and the bundled redistributables.
 *
 * `detectPlatform` reads `process.platform` and `process.arch`, so both are
 * overridden per case and restored afterwards. The existence check pins the
 * `runtime/` folder contents: a platform the loader can name must ship its
 * library in the package.
 */
import * as fs from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import { defaultLibPath, detectPlatform, type SteamPlatform } from '../src/runtime/platform';

const real = { platform: process.platform, arch: process.arch };

function pretend(platform: NodeJS.Platform, arch: NodeJS.Architecture): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}

afterEach(() => pretend(real.platform, real.arch));

describe('detectPlatform', () => {
  test.each<[NodeJS.Platform, NodeJS.Architecture, SteamPlatform]>([
    ['win32', 'x64', 'win64'],
    ['linux', 'x64', 'linux64'],
    ['linux', 'arm64', 'linuxarm64'],
    ['darwin', 'x64', 'osx'],
    ['darwin', 'arm64', 'osx'],
  ])('%s %s -> %s', (platform, arch, expected) => {
    pretend(platform, arch);
    expect(detectPlatform()).toBe(expected);
  });

  test('rejects an unsupported platform', () => {
    pretend('freebsd', 'x64');
    expect(() => detectPlatform()).toThrow(/unsupported platform/);
  });
});

describe('bundled redistributables', () => {
  test.each<SteamPlatform>(['win64', 'linux64', 'linuxarm64', 'osx'])('%s library ships in runtime/', (platform) => {
    expect(fs.existsSync(defaultLibPath(platform))).toBe(true);
  });
});
