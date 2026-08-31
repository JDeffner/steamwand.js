import * as path from 'node:path';

/**
 * The three platforms Valve ships a 64-bit redistributable for. The name is
 * also the folder name under `runtime/` in this package.
 */
export type SteamPlatform = 'win64' | 'linux64' | 'osx';

/**
 * Maps `process.platform` to the matching Steam platform name.
 *
 * @returns `'win64'`, `'linux64'`, or `'osx'`.
 * @throws Error if the current platform is not one of win32, linux, or darwin.
 */
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

/**
 * Builds the absolute path of the bundled Steam API redistributable.
 *
 * The file is `steam_api64.dll`, `libsteam_api.so`, or `libsteam_api.dylib`
 * under `runtime/<platform>/`. Pass the path to the `SteamNative` constructor,
 * or to `init` as `libPath`, to load a different copy.
 *
 * @param platform - Platform folder to resolve.
 * @defaultValue the result of {@link detectPlatform}
 * @returns Absolute path of the library file. The file is not checked for existence.
 * @throws Error from {@link detectPlatform} if the platform is not supported and no argument is given.
 * @see SteamNative
 */
export function defaultLibPath(platform: SteamPlatform = detectPlatform()): string {
  return path.join(__dirname, '..', '..', 'runtime', platform, LIB_NAMES[platform]);
}

/**
 * Reports the struct packing that callback structs use on a platform.
 *
 * Callback structs use #pragma pack(8) on Windows and pack(4) on Linux/macOS
 * (VALVE_CALLBACK_PACK_LARGE / _SMALL in steamclientpublic.h). The generator
 * emits one offset table per packing, so decoding picks the table by platform
 * instead of by this value.
 *
 * @param platform - Platform to report the packing for.
 * @defaultValue the result of {@link detectPlatform}
 * @returns 8 on Windows, 4 on Linux and macOS.
 * @throws Error from {@link detectPlatform} if the platform is not supported and no argument is given.
 * @see StructLayout
 */
export function callbackPack(platform: SteamPlatform = detectPlatform()): 4 | 8 {
  return platform === 'win64' ? 8 : 4;
}
