import { out } from '../runtime/out';
import type { ISteamUtils } from '../generated/interfaces/ISteamUtils';
import type { ISteamApps } from '../generated/interfaces/ISteamApps';
import type { SteamCallbackMap } from '../generated/callbacks';
import {
  EBetaBranchFlags,
  EGamepadTextInputLineMode,
  EGamepadTextInputMode,
  ESteamHardwareType,
} from '../generated/enums';
import { must } from './guards';

/** Steam reports this instead of a percentage when the machine runs on mains power. */
const ON_AC_POWER = 255;
/** Install paths can be long, and Valve's own samples read them into a buffer this size. */
const INSTALL_DIR_BYTES = 1024;
/** Beta branch names are capped well under this by Steam. */
const BETA_NAME_BYTES = 64;
/** Beta branch descriptions are one line of text. */
const BETA_DESCRIPTION_BYTES = 256;
/** The launch command line Steam passes through is capped at 1 KB. */
const LAUNCH_COMMAND_LINE_BYTES = 1024;

/**
 * A decoded Steam image, as returned by the image handle reads.
 *
 * @see System.image
 */
export interface SteamImage {
  /** Width in pixels. */
  width: number;
  /** Height in pixels. */
  height: number;
  /** Raw pixels, 4 bytes per pixel in RGBA order, `width * height * 4` bytes long. */
  rgba: Buffer;
}

/**
 * What the full screen gamepad keyboard should ask for.
 *
 * @see System.showGamepadTextInput
 */
export interface GamepadTextInputOptions {
  /** Prompt shown above the keyboard. */
  description: string;
  /** `EGamepadTextInputMode`: 0 normal, 1 password (the text is masked). */
  mode?: number;
  /** `EGamepadTextInputLineMode`: 0 single line, 1 multiple lines. */
  lineMode?: number;
  /** Maximum characters the user may enter. */
  maxChars?: number;
  /** Text the field starts with. */
  existingText?: string;
}

/**
 * One branch of the running app, as Steam reports it to the client.
 *
 * @see System.listBetas
 */
export interface BetaBranch {
  /** Branch name, the one `setActiveBeta` takes. */
  name: string;
  /** Description the developer wrote for the branch, empty if there is none. */
  description: string;
  /** Build id currently on that branch. */
  buildId: number;
  /** When the branch was last updated, as a Unix time in seconds. */
  lastUpdated: number;
  /** True for the app's default branch, the one a user without a beta opt-in runs. */
  isDefault: boolean;
  /** True while the branch is available to this user. */
  available: boolean;
  /** True if the branch needs a password to opt into. */
  isPrivate: boolean;
  /** True for the branch the user selected in the Steam client. */
  selected: boolean;
  /** True for the branch that is installed right now. */
  installed: boolean;
}

/**
 * Task level wrapper over ISteamUtils: the facts about the machine and the
 * Steam client this app runs under, the install, build, beta and launch facts
 * of the running app, plus the two gamepad keyboards.
 *
 * Everything here is a local read against the running Steam client except
 * `showGamepadTextInput`, which opens the Big Picture keyboard and resolves
 * when the user is done with it. Reach it as `steam.system`. Named `system`
 * because the generated ISteamUtils accessor already owns `steam.utils`.
 *
 * The running app reads come from ISteamApps, because they answer questions
 * about this process rather than about its DLC, which is what `steam.dlc`
 * covers. Avatars have their own decode in `steam.social.avatar`; `image` here
 * is the generic form for any Steam image handle.
 *
 * @see Steam.system
 * @see Apps
 */
export class System {
  /**
   * @param utils - The ISteamUtils interface.
   * @param apps - The ISteamApps interface, for the game language.
   * @param subscribe - Callback subscriber, normally `steam.on` bound to the session.
   * @param once - Awaitable callback subscriber, normally `steam.once` bound to the session.
   */
  constructor(
    private readonly utils: ISteamUtils,
    private readonly apps: ISteamApps,
    private readonly subscribe: <K extends keyof SteamCallbackMap & string>(
      name: K,
      listener: (data: SteamCallbackMap[K]) => void,
    ) => () => void,
    private readonly once: <K extends keyof SteamCallbackMap & string>(
      name: K,
      match?: (data: SteamCallbackMap[K]) => boolean,
    ) => Promise<SteamCallbackMap[K]>,
  ) {}

  /**
   * Reads the app id this process is running under.
   *
   * @returns The app id Steam initialized with.
   */
  appId(): number {
    return this.utils.GetAppID();
  }

  /**
   * Checks whether the app runs on a Steam Deck.
   *
   * Use it to switch to the controller-first UI and the smaller text sizes
   * Valve's Deck Verified checks look for. This SDK replaced the old
   * `IsSteamRunningOnSteamDeck` with `IsRunningOnSteamHardware`, which names
   * the hardware, so this compares against `k_ESteamHardwareTypeSteamDeck`.
   *
   * @returns True on a Steam Deck. False on every other machine, Steam Machine and Steam Frame included.
   * @see isBigPicture
   */
  isSteamDeck(): boolean {
    return this.utils.IsRunningOnSteamHardware() === ESteamHardwareType.k_ESteamHardwareTypeSteamDeck;
  }

  /**
   * Checks whether the Steam client is in Big Picture mode.
   *
   * @returns True in Big Picture mode, which is also the mode a Steam Deck runs in.
   * @see isSteamDeck
   */
  isBigPicture(): boolean {
    return this.utils.IsSteamInBigPictureMode();
  }

  /**
   * Checks whether the Steam client is in VR mode.
   *
   * @returns True if Steam is running in VR.
   */
  isVr(): boolean {
    return this.utils.IsSteamRunningInVR();
  }

  /**
   * Checks whether this is the Steam China launcher.
   *
   * The China build has its own rules for anti-addiction and age checks, so an
   * app that ships there must branch on this.
   *
   * @returns True under the Steam China launcher.
   */
  isChinaLauncher(): boolean {
    return this.utils.IsSteamChinaLauncher();
  }

  /**
   * Reads the language the Steam client UI is in.
   *
   * @returns An API language code, for example `english` or `german`.
   * @see gameLanguage
   */
  uiLanguage(): string {
    return this.utils.GetSteamUILanguage();
  }

  /**
   * Reads the language this app was launched in.
   *
   * This is the one to localize the game with: the user may run the client in
   * one language and the game in another.
   *
   * @returns An API language code, for example `english` or `german`.
   * @see uiLanguage
   */
  gameLanguage(): string {
    return this.apps.GetCurrentGameLanguage();
  }

  // The running app: where it is installed, which build and branch it is, how
  // it was launched, and who owns the license. All ISteamApps reads.

  /**
   * Reads where an app is installed.
   *
   * The default is the running app. Steam answers for an app the user owns but
   * has not installed too, with the path it would install to, so pair this with
   * `isAppInstalled` before touching the files.
   *
   * @param appId - App id to look up.
   * @defaultValue The app id this process runs under.
   * @returns The absolute install directory, or null if Steam knows no path for that app id.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * console.log(steam.system.installDir());
   * steam.close();
   * ```
   * @see isAppInstalled
   */
  installDir(appId: number = this.utils.GetAppID()): string | null {
    const folder = out.string(INSTALL_DIR_BYTES);
    const length = this.apps.GetAppInstallDir(appId, folder.buffer, folder.buffer.length);
    return length === 0 ? null : folder.value;
  }

  /**
   * Checks whether an app is installed on this machine.
   *
   * Meant for the other app in a launcher or a bundle, not for DLC: DLC state
   * is `steam.dlc.isInstalled`.
   *
   * @param appId - App id to check.
   * @returns True if the app's files are on disk.
   * @see installDir
   */
  isAppInstalled(appId: number): boolean {
    return this.apps.BIsAppInstalled(appId);
  }

  /**
   * Reads the build id of the running app.
   *
   * Steamworks assigns a new build id on every upload, so this is the version
   * number to put in a bug report or a crash log.
   *
   * @returns The build id, or 0 if the app is not running under Steam.
   * @see currentBeta
   */
  buildId(): number {
    return this.apps.GetAppBuildId();
  }

  /**
   * Reads which beta branch the app is running from.
   *
   * @returns The branch name, or null on the default branch, which is where a user without a beta opt-in is.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * console.log(steam.system.currentBeta() ?? 'default branch');
   * steam.close();
   * ```
   * @see listBetas
   */
  currentBeta(): string | null {
    const name = out.string(BETA_NAME_BYTES);
    if (!this.apps.GetCurrentBetaName(name.buffer, name.buffer.length)) return null;
    return name.value;
  }

  /**
   * Lists the beta branches of the running app that this user may see.
   *
   * The flags Steam reports per branch are spread into booleans: `isDefault`
   * for the public branch, `available` while the user may switch to it,
   * `isPrivate` when it needs a password, `selected` for what the user picked
   * in the client, and `installed` for what is on disk right now.
   *
   * @returns One entry per branch, in Steam's order. Empty if the app has no branches.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * for (const beta of steam.system.listBetas()) {
   *   console.log(beta.name, beta.buildId, beta.installed);
   * }
   * steam.close();
   * ```
   * @see setActiveBeta
   */
  listBetas(): BetaBranch[] {
    const list: BetaBranch[] = [];
    const count = this.apps.GetNumBetas(null, null);
    for (let i = 0; i < count; i++) {
      const flags = out.uint32();
      const buildId = out.uint32();
      const lastUpdated = out.uint32();
      const name = out.string(BETA_NAME_BYTES);
      const description = out.string(BETA_DESCRIPTION_BYTES);
      const read = this.apps.GetBetaInfo(
        i,
        flags.buffer,
        buildId.buffer,
        name.buffer,
        name.buffer.length,
        description.buffer,
        description.buffer.length,
        lastUpdated.buffer,
      );
      if (!read) continue;
      list.push({
        name: name.value,
        description: description.value,
        buildId: buildId.value,
        lastUpdated: lastUpdated.value,
        isDefault: (flags.value & EBetaBranchFlags.k_EBetaBranch_Default) !== 0,
        available: (flags.value & EBetaBranchFlags.k_EBetaBranch_Available) !== 0,
        isPrivate: (flags.value & EBetaBranchFlags.k_EBetaBranch_Private) !== 0,
        selected: (flags.value & EBetaBranchFlags.k_EBetaBranch_Selected) !== 0,
        installed: (flags.value & EBetaBranchFlags.k_EBetaBranch_Installed) !== 0,
      });
    }
    return list;
  }

  /**
   * Switches the app to a beta branch.
   *
   * Steam only records the choice: the branch is downloaded and the app runs
   * from it after the next restart through Steam. A private branch has to be
   * unlocked with its password in the Steam client first.
   *
   * @param name - Branch name from `listBetas`. The empty string switches back to the default branch.
   * @throws Error if Steam refused the switch, which is what an unknown or locked branch gives.
   * @see listBetas
   */
  setActiveBeta(name: string): void {
    must('SetActiveBeta', this.apps.SetActiveBeta(name));
  }

  /**
   * Reads the command line Steam launched this app with.
   *
   * This is where a `steam://run/<appid>//<params>` link ends up, and where a
   * `+connect` string lands when a friend's invite started the app rather than
   * finding it running. Subscribe with `onLaunchParameters` to catch the same
   * arguments arriving while the app is already up.
   *
   * @returns The arguments Steam passed, or an empty string if there were none.
   * @see launchQueryParam
   * @see onLaunchParameters
   */
  launchCommandLine(): string {
    const line = out.string(LAUNCH_COMMAND_LINE_BYTES);
    this.apps.GetLaunchCommandLine(line.buffer, line.buffer.length);
    return line.value;
  }

  /**
   * Reads one query parameter from the launch URL.
   *
   * The parameters of a `steam://run/<appid>//?key=value` link, already parsed.
   *
   * @param key - Parameter name, with no leading `?` or `&`.
   * @returns The value, or an empty string if the app was not launched with that parameter.
   * @see launchCommandLine
   */
  launchQueryParam(key: string): string {
    return this.apps.GetLaunchQueryParam(key);
  }

  /**
   * Subscribes to new launch arguments arriving for the running app.
   *
   * Fires when Steam passes a `steam://run/<appid>//<params>` link to an app
   * that is already running, which is how a second click on a store or web
   * link reaches it. The callback carries no payload: read the new arguments
   * with `launchCommandLine` or `launchQueryParam`.
   *
   * @param listener - Runs on every `NewUrlLaunchParameters_t`, inside a pump frame.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * steam.system.onLaunchParameters(() => {
   *   console.log(steam.system.launchCommandLine());
   * });
   * ```
   * @see launchCommandLine
   */
  onLaunchParameters(listener: () => void): () => void {
    return this.subscribe('NewUrlLaunchParameters_t', () => listener());
  }

  /**
   * Reads which account owns the license this app runs under.
   *
   * The same as the local Steam id, except under Family Sharing, where the app
   * is borrowed from somebody else's library.
   *
   * @returns Steam id of the license owner. 64-bit, so a `bigint`.
   * @see isFamilyShared
   */
  appOwner(): bigint {
    return this.apps.GetAppOwner();
  }

  /**
   * Checks whether the app is borrowed through Family Sharing.
   *
   * A borrowed session ends the moment the owner starts playing, so a game that
   * cares about long sessions should warn the player.
   *
   * @returns True if this session runs on somebody else's license.
   * @see appOwner
   */
  isFamilyShared(): boolean {
    return this.apps.BIsSubscribedFromFamilySharing();
  }

  /**
   * Reads the timed trial budget, for an app the user is only trying out.
   *
   * @returns The seconds the trial allows and the seconds already played, or null if this is not a timed trial.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const trial = steam.system.timedTrial();
   * if (trial) console.log(trial.secondsAllowed - trial.secondsPlayed, 'seconds left');
   * steam.close();
   * ```
   */
  timedTrial(): { secondsAllowed: number; secondsPlayed: number } | null {
    const allowed = out.uint32();
    const played = out.uint32();
    if (!this.apps.BIsTimedTrial(allowed.buffer, played.buffer)) return null;
    return { secondsAllowed: allowed.value, secondsPlayed: played.value };
  }

  /**
   * Reads the country Steam geolocated this user's IP to.
   *
   * A guess from the IP address, not the country on the account, so treat it
   * as a default for matchmaking or currency, not as a fact.
   *
   * @returns A two letter ISO 3166-1 country code, for example `DE`.
   * @see onIpCountryChanged
   */
  ipCountry(): string {
    return this.utils.GetIPCountry();
  }

  /**
   * Reads Steam's own wall clock time.
   *
   * Use it wherever a local clock could be wrong or tampered with, for example
   * for a daily reward or an event window.
   *
   * @returns Steam's server time.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * console.log(steam.system.serverTime().toISOString());
   * steam.close();
   * ```
   */
  serverTime(): Date {
    return new Date(this.utils.GetServerRealTime() * 1000);
  }

  /**
   * Reads how long this app has been running.
   *
   * @returns Seconds since the app started.
   * @see secondsSinceComputerActive
   */
  secondsSinceAppActive(): number {
    return this.utils.GetSecondsSinceAppActive();
  }

  /**
   * Reads how long the user has been at the machine.
   *
   * @returns Seconds since the last user input on this computer.
   * @see secondsSinceAppActive
   */
  secondsSinceComputerActive(): number {
    return this.utils.GetSecondsSinceComputerActive();
  }

  /**
   * Reads the battery charge on a laptop or a handheld.
   *
   * @returns Remaining charge in percent, or `'ac'` when the machine runs on mains power.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const power = steam.system.batteryPower();
   * if (power !== 'ac' && power < 20) console.log('save the game');
   * steam.close();
   * ```
   * @see onLowBattery
   */
  batteryPower(): number | 'ac' {
    const power = this.utils.GetCurrentBatteryPower();
    return power === ON_AC_POWER ? 'ac' : power;
  }

  /**
   * Checks whether the Steam overlay can render over this app.
   *
   * False until the overlay has hooked the process, which takes a moment after
   * startup, and false forever when the user turned it off.
   *
   * @returns True if the overlay is ready.
   */
  isOverlayEnabled(): boolean {
    return this.utils.IsOverlayEnabled();
  }

  /**
   * Reads one Steam image by handle into raw pixels.
   *
   * Image handles come from other calls, for example the avatar handles on
   * ISteamFriends. Two flat calls: `GetImageSize` for the dimensions, then
   * `GetImageRGBA` into a buffer of exactly that size.
   *
   * @param handle - Image handle. 0 means Steam has no image for that request.
   * @returns The size and the pixels, or null if Steam does not know that handle.
   * @throws Error if the size was known but the pixels could not be read.
   * @see Social.avatar
   */
  image(handle: number): SteamImage | null {
    const width = out.uint32();
    const height = out.uint32();
    if (!this.utils.GetImageSize(handle, width.buffer, height.buffer)) return null;

    const rgba = Buffer.alloc(width.value * height.value * 4);
    must('GetImageRGBA', this.utils.GetImageRGBA(handle, rgba, rgba.length));
    return { width: width.value, height: height.value, rgba };
  }

  /**
   * Opens the full screen gamepad keyboard and resolves with what the user typed.
   *
   * Only shows up in Big Picture mode and on Steam Deck; everywhere else the
   * show call fails and this rejects at once. The text is fetched with
   * `GetEnteredGamepadTextInput` inside the dismissal callback, which is the
   * only moment Steam still holds it.
   *
   * @param options - The prompt, the input mode, and the starting text.
   * @returns The entered text, or null if the user dismissed the keyboard without submitting.
   * @throws Error if Steam refused to show the keyboard, which is the normal outcome outside Big Picture mode.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const name = await steam.system.showGamepadTextInput({ description: 'Your name', maxChars: 32 });
   * if (name !== null) console.log(name);
   * steam.close();
   * ```
   * @see showFloatingGamepadTextInput
   */
  async showGamepadTextInput(options: GamepadTextInputOptions): Promise<string | null> {
    const shown = this.utils.ShowGamepadTextInput(
      options.mode ?? EGamepadTextInputMode.k_EGamepadTextInputModeNormal,
      options.lineMode ?? EGamepadTextInputLineMode.k_EGamepadTextInputLineModeSingleLine,
      options.description,
      options.maxChars ?? 256,
      options.existingText ?? '',
    );
    if (!shown) {
      throw new Error('steamwand: ShowGamepadTextInput returned false (not in Big Picture mode?)');
    }

    const e = await this.once('GamepadTextInputDismissed_t');
    if (!e.m_bSubmitted) return null;
    // Steam reports the length including the terminator; the buffer must
    // hold at least that much or the copy is refused.
    const text = out.string(this.utils.GetEnteredGamepadTextLength() + 1);
    must('GetEnteredGamepadTextInput', this.utils.GetEnteredGamepadTextInput(text.buffer, text.buffer.length));
    return text.value;
  }

  /**
   * Opens the floating gamepad keyboard over a text field.
   *
   * Unlike `showGamepadTextInput` this does not return the text: Steam types
   * into whatever field the app has focused, so the app reads its own field.
   *
   * @param mode - `EFloatingGamepadTextInputMode`: 0 single line, 1 multiple lines, 2 email, 3 numeric.
   * @param x - Left edge of the text field, in pixels from the left of the window.
   * @param y - Top edge of the text field, in pixels from the top of the window.
   * @param width - Width of the text field in pixels.
   * @param height - Height of the text field in pixels.
   * @returns True if the keyboard opened. False outside Big Picture mode.
   * @see dismissFloatingGamepadTextInput
   */
  showFloatingGamepadTextInput(mode: number, x: number, y: number, width: number, height: number): boolean {
    return this.utils.ShowFloatingGamepadTextInput(mode, x, y, width, height);
  }

  /**
   * Closes the floating gamepad keyboard.
   *
   * @returns True if a keyboard was open and is now closing.
   * @see showFloatingGamepadTextInput
   */
  dismissFloatingGamepadTextInput(): boolean {
    return this.utils.DismissFloatingGamepadTextInput();
  }

  /**
   * Subscribes to the country changing under this user's IP.
   *
   * The callback carries no payload, so read the new value with `ipCountry`.
   *
   * @param listener - Runs whenever Steam geolocates this user somewhere else.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @see ipCountry
   */
  onIpCountryChanged(listener: () => void): () => void {
    return this.subscribe('IPCountry_t', () => listener());
  }

  /**
   * Subscribes to Steam's low battery warning.
   *
   * Steam sends it once the battery drops under 10 percent, and again every
   * minute after that. A good moment to autosave.
   *
   * @param listener - Runs with the minutes of battery Steam thinks are left.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @see batteryPower
   */
  onLowBattery(listener: (minutesLeft: number) => void): () => void {
    return this.subscribe('LowBatteryPower_t', (e) => listener(e.m_nMinutesBatteryLeft));
  }
}
