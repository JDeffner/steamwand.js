import * as path from 'node:path';

export type SteamPlatform = 'win64' | 'linux64' | 'osx';

export function detectPlatform(): SteamPlatform {
  switch (process.platform) {
    case 'win32':
      return 'win64';
    case 'linux':
      return 'linux64';
    case 'darwin':
      return 'osx';
    default:
      throw new Error(`steamwand: unsupported platform ${process.platform}`);
  }
}

const LIB_NAMES: Record<SteamPlatform, string> = {
  win64: 'steam_api64.dll',
  linux64: 'libsteam_api.so',
  osx: 'libsteam_api.dylib',
};

/** Absolute path of the bundled Steam API redistributable for this platform. */
export function defaultLibPath(platform: SteamPlatform = detectPlatform()): string {
  return path.join(__dirname, '..', '..', 'runtime', platform, LIB_NAMES[platform]);
}

/**
 * Callback structs use #pragma pack(8) on Windows and pack(4) on Linux/macOS
 * (VALVE_CALLBACK_PACK_LARGE / _SMALL in steamclientpublic.h).
 */
export function callbackPack(platform: SteamPlatform = detectPlatform()): 4 | 8 {
  return platform === 'win64' ? 8 : 4;
}
