import koffi from 'koffi';
import { defaultLibPath } from './platform';

/**
 * Loaded steam_api dynamic library plus the handwritten core exports
 * (init, shutdown, manual dispatch). Everything else is registered lazily
 * by the generated interface modules through `func()`.
 */
export class SteamNative {
  readonly lib: koffi.IKoffiLib;
  private readonly cache = new Map<string, koffi.KoffiFunction>();

  readonly initFlat: (errMsg: Buffer) => number;
  readonly shutdown: () => void;
  readonly getHSteamPipe: () => number;
  readonly manualDispatchInit: () => void;
  readonly manualDispatchRunFrame: (pipe: number) => void;
  readonly manualDispatchGetNextCallback: (pipe: number, msg: Buffer) => boolean;
  readonly manualDispatchFreeLastCallback: (pipe: number) => void;
  readonly manualDispatchGetAPICallResult: (
    pipe: number,
    call: bigint,
    out: Buffer,
    size: number,
    expectedId: number,
    failed: Buffer,
  ) => boolean;

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

  /** Register (and cache) a flat API export. Throws if the symbol is missing. */
  func(name: string, result: string, params: (string | koffi.IKoffiCType)[]): koffi.KoffiFunction {
    let fn = this.cache.get(name);
    if (!fn) {
      fn = this.lib.func(name, result, params);
      this.cache.set(name, fn);
    }
    return fn;
  }
}
