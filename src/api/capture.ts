import type { ISteamScreenshots } from '../generated/interfaces/ISteamScreenshots';
import type { SteamCallbackMap } from '../generated/callbacks';
import { must } from './guards';

/** Steam returns this handle when it refuses a screenshot. `INVALID_SCREENSHOT_HANDLE` in the SDK. */
const INVALID_SCREENSHOT_HANDLE = 0;

/**
 * One finished screenshot, as delivered to an `onReady` listener.
 *
 * @see Capture.onReady
 */
export interface ScreenshotReady {
  /** Handle of the screenshot Steam just wrote. `setLocation` and the tag calls take it. */
  handle: number;
  /** The `EResult` Steam finished with. `k_EResultOK` means the file is in the library. */
  result: number;
}

/**
 * Task level wrapper over ISteamScreenshots: take screenshots, add existing
 * images to the Steam screenshot library, tag them, and hook Steam's own
 * screenshot key.
 *
 * Everything here is a local call against the Steam client, so nothing awaits
 * a call result. A screenshot lands durably in the user's Steam library, so
 * `addFromFile`, `writeRgb`, and `addVr` are not reversible from this API.
 * Reach it as `steam.capture`, since the generated interface already owns
 * `steam.screenshots`.
 *
 * @see Steam.capture
 */
export class Capture {
  /**
   * @param screenshots - The ISteamScreenshots interface.
   * @param subscribe - Callback subscriber, normally `steam.on` bound to the session.
   */
  constructor(
    private readonly screenshots: ISteamScreenshots,
    private readonly subscribe: <K extends keyof SteamCallbackMap & string>(
      name: K,
      listener: (data: SteamCallbackMap[K]) => void,
    ) => () => void,
  ) {}

  /**
   * Asks Steam to take a screenshot of the game window.
   *
   * With hooking off, Steam takes the screenshot itself and fires
   * `ScreenshotReady_t`. With hooking on, Steam fires `ScreenshotRequested_t`
   * instead and expects the game to write the image with `writeRgb` or
   * `addFromFile`.
   *
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const off = steam.capture.onReady((s) => console.log(s.handle, s.result));
   * steam.capture.trigger();
   * // later: off(); steam.close();
   * ```
   * @see onReady
   * @see hook
   */
  trigger(): void {
    this.screenshots.TriggerScreenshot();
  }

  /**
   * Adds an image file on disk to the Steam screenshot library.
   *
   * Steam copies the file, so it may be deleted afterwards. The thumbnail is
   * left to Steam, which builds one from the image. The image must be a JPEG,
   * TGA, or PNG of at most 16000 pixels per side and 4:1 aspect ratio.
   *
   * @param path - Absolute path of the image file.
   * @param width - Image width in pixels.
   * @param height - Image height in pixels.
   * @returns The new screenshot handle, for `setLocation` and the tag calls.
   * @throws Error if Steam refused the image, for example because the path or the size is wrong.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const handle = steam.capture.addFromFile('C:/shots/win.png', 1920, 1080);
   * steam.capture.setLocation(handle, 'Final boss');
   * steam.close();
   * ```
   * @see writeRgb
   */
  addFromFile(path: string, width: number, height: number): number {
    // A NULL thumbnail path is what tells Steam to build the thumbnail itself.
    const thumbnail = null as unknown as string;
    const handle = this.screenshots.AddScreenshotToLibrary(path, thumbnail, width, height);
    if (handle === INVALID_SCREENSHOT_HANDLE) {
      throw new Error(`steamwand: AddScreenshotToLibrary rejected '${path}' (${width}x${height})`);
    }
    return handle;
  }

  /**
   * Writes raw RGB pixels to the Steam screenshot library.
   *
   * The buffer holds one byte per channel, three channels per pixel, rows top
   * to bottom with no padding, which is exactly `width * height * 3` bytes.
   *
   * @param rgb - The pixels. Must be `width * height * 3` bytes long.
   * @param width - Image width in pixels.
   * @param height - Image height in pixels.
   * @returns The new screenshot handle, for `setLocation` and the tag calls.
   * @throws Error if the buffer length does not match the size, or Steam refused the image.
   * @see addFromFile
   */
  writeRgb(rgb: Buffer, width: number, height: number): number {
    const expected = width * height * 3;
    if (rgb.length !== expected) {
      throw new Error(`steamwand: writeRgb needs ${expected} bytes for ${width}x${height}, got ${rgb.length}`);
    }
    const handle = this.screenshots.WriteScreenshot(rgb, rgb.length, width, height);
    if (handle === INVALID_SCREENSHOT_HANDLE) {
      throw new Error(`steamwand: WriteScreenshot rejected a ${width}x${height} image`);
    }
    return handle;
  }

  /**
   * Adds a VR screenshot to the Steam screenshot library.
   *
   * Valve takes no size here: the dimensions come from the files themselves.
   * `path` is the flat 2D image shown in the library, `vrPath` the VR data
   * whose format `type` names.
   *
   * @param type - EVRScreenshotType (1 mono, 2 stereo, 3 mono cubemap, 4 mono panorama, 5 stereo panorama).
   * @param path - Absolute path of the flat 2D image.
   * @param vrPath - Absolute path of the VR image.
   * @returns The new screenshot handle, for `setLocation` and the tag calls.
   * @throws Error if Steam refused the images.
   * @see addFromFile
   */
  addVr(type: number, path: string, vrPath: string): number {
    const handle = this.screenshots.AddVRScreenshotToLibrary(type, path, vrPath);
    if (handle === INVALID_SCREENSHOT_HANDLE) {
      throw new Error(`steamwand: AddVRScreenshotToLibrary rejected '${path}' / '${vrPath}'`);
    }
    return handle;
  }

  /**
   * Sets the place a screenshot was taken in, shown next to it in the library.
   *
   * @param handle - Screenshot to tag, from `addFromFile`, `writeRgb`, `addVr`, or `onReady`.
   * @param location - Free text, at most 255 UTF-8 bytes, for example a level name.
   * @throws Error if the handle is unknown or the text is too long.
   */
  setLocation(handle: number, location: string): void {
    must('SetLocation', this.screenshots.SetLocation(handle, location));
  }

  /**
   * Tags a user who appears in a screenshot.
   *
   * Steam allows at most 32 tags per screenshot, users and workshop items
   * together.
   *
   * @param handle - Screenshot to tag.
   * @param steamId - User to tag. 64-bit, so a `bigint`.
   * @throws Error if the handle is unknown or the screenshot is already full.
   * @see tagPublishedFile
   */
  tagUser(handle: number, steamId: bigint): void {
    must('TagUser', this.screenshots.TagUser(handle, steamId));
  }

  /**
   * Tags a workshop item that appears in a screenshot.
   *
   * Steam allows at most 32 tags per screenshot, users and workshop items
   * together.
   *
   * @param handle - Screenshot to tag.
   * @param fileId - Published file id of the item. 64-bit, so a `bigint`.
   * @throws Error if the handle is unknown or the screenshot is already full.
   * @see tagUser
   */
  tagPublishedFile(handle: number, fileId: bigint): void {
    must('TagPublishedFile', this.screenshots.TagPublishedFile(handle, fileId));
  }

  /**
   * Takes Steam's screenshot key over, or hands it back.
   *
   * While hooked, the key fires `ScreenshotRequested_t` instead of writing a
   * file, so the game renders its own image and calls `writeRgb` or
   * `addFromFile`. Steam forgets the hook when the app exits.
   *
   * @param enabled - True to hook, false to let Steam handle the key again.
   * @see onRequested
   * @see isHooked
   */
  hook(enabled: boolean): void {
    this.screenshots.HookScreenshots(enabled);
  }

  /**
   * Returns whether the screenshot key is currently hooked by the app.
   *
   * @returns True while `hook(true)` is in effect.
   * @see hook
   */
  isHooked(): boolean {
    return this.screenshots.IsScreenshotsHooked();
  }

  /**
   * Subscribes to the hooked screenshot key.
   *
   * Only fires while `hook(true)` is in effect. The callback carries nothing:
   * it means the user pressed the key and the app should write an image now.
   *
   * @param listener - Runs on every press of the hooked key.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * steam.capture.hook(true);
   * const off = steam.capture.onRequested(() => {
   *   steam.capture.writeRgb(renderToRgb(), 1920, 1080);
   * });
   * // later: off(); steam.capture.hook(false); steam.close();
   * ```
   * @see hook
   */
  onRequested(listener: () => void): () => void {
    return this.subscribe('ScreenshotRequested_t', () => listener());
  }

  /**
   * Subscribes to finished screenshots.
   *
   * Fires for screenshots Steam took itself and for the ones this app added,
   * which is where the handle for `setLocation` and the tag calls comes from
   * when Steam took the shot.
   *
   * @param listener - Runs on every finished screenshot with its handle and `EResult`.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @see trigger
   */
  onReady(listener: (screenshot: ScreenshotReady) => void): () => void {
    return this.subscribe('ScreenshotReady_t', (e) => listener({ handle: e.m_hLocal, result: e.m_eResult }));
  }
}
