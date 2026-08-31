import koffi from 'koffi';
import { defaultLibPath } from './platform';

/**
 * Loaded steam_api dynamic library plus the handwritten core exports
 * (init, shutdown, manual dispatch). Everything else is registered lazily
 * by the generated interface modules through `func()`.
 *
 * `init()` builds one of these. Construct it directly only to drive the flat
 * API without the pump, for example in a test.
 *
 * @see init
 */
export class SteamNative {
  /** The loaded koffi library handle. Use `func()` instead of calling into it directly. */
  readonly lib: koffi.IKoffiLib;
  private readonly cache = new Map<string, koffi.KoffiFunction>();

  /**
   * SteamAPI_InitFlat. Starts the Steam API for the app id in the environment.
   *
   * @param errMsg - Out buffer for Valve's diagnostic text, at least 1024 bytes.
   * @returns An `ESteamAPIInitResult`. Anything other than `k_ESteamAPIInitResult_OK` is a failure.
   */
  readonly initFlat: (errMsg: Buffer) => number;
  /** SteamAPI_Shutdown. Releases the Steam API. Stop the pump first. */
  readonly shutdown: () => void;
  /** SteamAPI_GetHSteamPipe. Returns the pipe handle every dispatch call takes. */
  readonly getHSteamPipe: () => number;
  /**
   * SteamAPI_ManualDispatch_Init. Switches the process to manual dispatch.
   * Call once, after `initFlat`, and never call SteamAPI_RunCallbacks after it.
   */
  readonly manualDispatchInit: () => void;
  /**
   * SteamAPI_ManualDispatch_RunFrame. Lets Steam queue what is waiting.
   *
   * @param pipe - Handle from `getHSteamPipe`.
   */
  readonly manualDispatchRunFrame: (pipe: number) => void;
  /**
   * SteamAPI_ManualDispatch_GetNextCallback. Pops one queued callback.
   *
   * `SteamDispatch` registers its own binding for this symbol, because the out
   * param is a koffi struct type rather than a plain buffer.
   *
   * @param pipe - Handle from `getHSteamPipe`.
   * @param msg - Out buffer for a `CallbackMsg_t`, at least 24 bytes.
   * @returns True while a callback was written to `msg`, false when the queue is drained.
   */
  readonly manualDispatchGetNextCallback: (pipe: number, msg: Buffer) => boolean;
  /**
   * SteamAPI_ManualDispatch_FreeLastCallback. Releases the bytes the last
   * `manualDispatchGetNextCallback` pointed at. Copy them out first.
   *
   * @param pipe - Handle from `getHSteamPipe`.
   */
  readonly manualDispatchFreeLastCallback: (pipe: number) => void;
  /**
   * SteamAPI_ManualDispatch_GetAPICallResult. Reads the payload of a completed
   * async call.
   *
   * @param pipe - Handle from `getHSteamPipe`.
   * @param call - The 64-bit call handle the flat method returned.
   * @param out - Out buffer for the result struct, at least `size` bytes.
   * @param size - Size of the result struct in bytes.
   * @param expectedId - Callback id of the expected result struct.
   * @param failed - Out buffer of 1 byte. Non-zero means Steam reported an IO failure.
   * @returns True if the result was copied into `out`.
   */
  readonly manualDispatchGetAPICallResult: (
    pipe: number,
    call: bigint,
    out: Buffer,
    size: number,
    expectedId: number,
    failed: Buffer,
  ) => boolean;

  /**
   * Loads the steam_api library and binds the core exports.
   *
   * @param libPath - Path of the library file to load.
   * @defaultValue the bundled redistributable for this platform ({@link defaultLibPath})
   * @throws Error if the library cannot be loaded, or if a core symbol is missing.
   */
  constructor(libPath: string = defaultLibPath()) {
    this.lib = koffi.load(libPath);
    this.initFlat = this.func('SteamAPI_InitFlat', 'int32', ['void *']) as never;
    this.shutdown = this.func('SteamAPI_Shutdown', 'void', []) as never;
    this.getHSteamPipe = this.func('SteamAPI_GetHSteamPipe', 'int32', []) as never;
    this.manualDispatchInit = this.func('SteamAPI_ManualDispatch_Init', 'void', []) as never;
    this.manualDispatchRunFrame = this.func('SteamAPI_ManualDispatch_RunFrame', 'void', ['int32']) as never;
    this.manualDispatchGetNextCallback = this.func('SteamAPI_ManualDispatch_GetNextCallback', 'bool', [
      'int32',
      'void *',
    ]) as never;
    this.manualDispatchFreeLastCallback = this.func('SteamAPI_ManualDispatch_FreeLastCallback', 'void', [
      'int32',
    ]) as never;
    this.manualDispatchGetAPICallResult = this.func('SteamAPI_ManualDispatch_GetAPICallResult', 'bool', [
      'int32',
      'uint64',
      'void *',
      'int32',
      'int32',
      'void *',
    ]) as never;
  }

  /**
   * Registers (and caches) a flat API export.
   *
   * The generated interfaces call this on every method, so the signature is
   * bound once per symbol and reused after that.
   *
   * @param name - Exported C symbol, for example `SteamAPI_ISteamUGC_CreateItem`.
   * @param result - koffi type of the return value.
   * @param params - koffi types of the parameters, in order.
   * @returns The callable binding. The cached one wins, so the types of a repeat call are ignored.
   * @throws Error if the library does not export `name`.
   */
  func(name: string, result: string, params: (string | koffi.IKoffiCType)[]): koffi.KoffiFunction {
    let fn = this.cache.get(name);
    if (!fn) {
      fn = this.lib.func(name, result, params);
      this.cache.set(name, fn);
    }
    return fn;
  }
}
