import koffi from 'koffi';
import type { SteamNative } from './native';
import { decodeStruct, type StructLayout } from './struct';

/** SteamAPICallCompleted_t (id 703). Same layout under pack(8) and pack(4). */
const CALL_COMPLETED_ID = 703;

/**
 * CallbackMsg_t: int32 user, int32 id, uint8* param, int32 size.
 * Offsets are identical on all supported 64-bit platforms (0, 4, 8, 16).
 */
const CallbackMsg = koffi.struct('SW_CallbackMsg_t', {
  m_hSteamUser: 'int32',
  m_iCallback: 'int32',
  m_pubParam: 'uint8 *',
  m_cubParam: 'int32',
});

interface CallbackMsgJs {
  m_hSteamUser: number;
  m_iCallback: number;
  m_pubParam: unknown;
  m_cubParam: number;
}

interface PendingCall {
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
}

/**
 * An async Steam call could not be completed: the handle was invalid, the
 * result could not be read, or Steam reported an IO failure.
 *
 * A call that completes with a non-OK `EResult` is not this error. The high
 * level API throws {@link SteamResultError} for that.
 *
 * @see SteamDispatch.callResult
 */
export class SteamApiCallError extends Error {
  /**
   * @param message - What failed.
   * @param callbackId - Id of the expected result struct, or 0 if the handle was already invalid.
   */
  constructor(
    message: string,
    readonly callbackId: number,
  ) {
    super(message);
    this.name = 'SteamApiCallError';
  }
}

/**
 * Valve's manual dispatch pump. One per process; never combine with
 * SteamAPI_RunCallbacks. Resolves call-result promises and fans plain
 * callbacks out to listeners.
 *
 * `init()` creates and starts one, reachable as `steam.dispatch`. Mixing this
 * pump with SteamAPI_RunCallbacks makes both miss callbacks.
 *
 * @see init
 * @see Steam.dispatch
 */
export class SteamDispatch {
  private readonly getNextCallback: koffi.KoffiFunction;
  private timer: NodeJS.Timeout | undefined;
  private readonly pending = new Map<bigint, PendingCall>();
  private readonly listeners = new Map<number, Set<(buf: Buffer) => void>>();

  /**
   * @param nat - Loaded library. `SteamAPI_ManualDispatch_Init` must already have run on it.
   * @param pipe - Pipe handle from `nat.getHSteamPipe()`.
   */
  constructor(
    private readonly nat: SteamNative,
    private readonly pipe: number,
  ) {
    // Registered here (not in SteamNative) because the out param is a koffi
    // struct type, not a plain string type.
    this.getNextCallback = nat.lib.func('SteamAPI_ManualDispatch_GetNextCallback', 'bool', [
      'int32',
      koffi.out(koffi.pointer(CallbackMsg)),
    ]);
  }

  /**
   * Starts the pump interval. Does nothing if it is already running.
   *
   * The timer is unref'd, so it never keeps an idle process alive. It is ref'd
   * again while a call is in flight, so an awaited call cannot let the process
   * exit.
   *
   * @param intervalMs - Milliseconds between frames.
   * @defaultValue 50
   * @see stop
   */
  start(intervalMs = 50): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.runFrame(), intervalMs);
    this.timer.unref();
  }

  /**
   * Stops the pump and rejects every call that is still in flight.
   *
   * Safe to call more than once. Listeners stay registered, so a later
   * `start()` resumes them.
   *
   * @see Steam.close
   */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const p of this.pending.values()) {
      p.reject(new Error('steamwand: dispatch stopped while call was in flight'));
    }
    this.pending.clear();
  }

  /**
   * Awaits the raw bytes of a call result.
   *
   * Flat methods that start an async call return a 64-bit call handle as a
   * `bigint`. Pass that handle here to wait for its result struct.
   *
   * @param call - Call handle from a flat method. `0n` means Steam refused the call.
   * @returns The result struct bytes. Decode them with {@link decodeStruct}.
   * @throws SteamApiCallError if the handle is `0n`, if the result cannot be read, or if Steam reports an IO failure.
   * @throws Error if `stop()` runs while the call is in flight.
   * @see callResultStruct
   */
  callResult(call: bigint): Promise<Buffer> {
    if (call === 0n) {
      return Promise.reject(new SteamApiCallError('Steam returned an invalid API call handle', 0));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(call, { resolve, reject });
      this.updateRef();
    });
  }

  /**
   * Re-evaluates whether the pump timer keeps the event loop alive.
   *
   * The pump must not keep an idle process alive, but a pending Steam call
   * must: ref the interval while calls are in flight, unref when drained.
   * Called on every add to and removal from the pending map.
   */
  private updateRef(): void {
    if (!this.timer) return;
    if (this.pending.size > 0) this.timer.ref();
    else this.timer.unref();
  }

  /**
   * Awaits a call result and decodes it with the given layout.
   *
   * @param call - Call handle from a flat method.
   * @param layout - Layout of the expected result struct, from `layoutOf(name)`.
   * @typeParam T - Generated struct interface to type the result as.
   * @returns The decoded result struct. 64-bit fields are `bigint`.
   * @throws SteamApiCallError if the call cannot be completed.
   * @throws Error if the returned bytes are shorter than `layout.size`.
   * @example
   * ```ts
   * import { init, flat } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const call = steam.ugc.CreateItem(480, flat.EWorkshopFileType.k_EWorkshopFileTypeCommunity);
   * const r = await steam.dispatch.callResultStruct<flat.CreateItemResult_t>(
   *   call,
   *   flat.layoutOf('CreateItemResult_t'),
   * );
   * console.log(r.m_nPublishedFileId); // bigint
   * ```
   * @see callResult
   */
  async callResultStruct<T>(call: bigint, layout: StructLayout): Promise<T> {
    const buf = await this.callResult(call);
    return decodeStruct<T>(buf, layout);
  }

  /**
   * Subscribes to a plain callback by id.
   *
   * The listener gets the raw struct bytes. `Steam.on` wraps this and decodes
   * them for you.
   *
   * @param callbackId - Numeric callback id, for example from `callbacksById`.
   * @param listener - Runs on every matching callback, inside the pump frame. Keep it short and do not let it throw.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @see Steam.on
   */
  on(callbackId: number, listener: (buf: Buffer) => void): () => void {
    let set = this.listeners.get(callbackId);
    if (!set) {
      set = new Set();
      this.listeners.set(callbackId, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  /**
   * Drains everything Steam has queued: resolves finished calls, then fans the
   * remaining callbacks out to their listeners.
   *
   * Called by the interval. Call it directly to pump on your own schedule, for
   * example from a game loop or a test.
   */
  runFrame(): void {
    this.nat.manualDispatchRunFrame(this.pipe);
    const msg: Partial<CallbackMsgJs> = {};
    while (this.getNextCallback(this.pipe, msg)) {
      try {
        const id = msg.m_iCallback as number;
        if (id === CALL_COMPLETED_ID) {
          const bytes = this.readParam(msg as CallbackMsgJs);
          this.completeCall(bytes.readBigUInt64LE(0), bytes.readInt32LE(8), bytes.readUInt32LE(12));
        } else {
          const set = this.listeners.get(id);
          if (set && set.size > 0) {
            const bytes = this.readParam(msg as CallbackMsgJs);
            for (const listener of set) listener(bytes);
          }
        }
      } finally {
        this.nat.manualDispatchFreeLastCallback(this.pipe);
      }
    }
  }

  /**
   * Copies the callback param bytes out of Steam's memory.
   *
   * The pointer is only valid until `FreeLastCallback`, so the bytes must be
   * copied inside the same loop turn.
   *
   * @param msg - The message `GetNextCallback` just filled in.
   * @returns An owned copy of `m_cubParam` bytes.
   */
  private readParam(msg: CallbackMsgJs): Buffer {
    const decoded = koffi.decode(msg.m_pubParam, koffi.array('uint8', msg.m_cubParam)) as Uint8Array;
    return Buffer.from(decoded);
  }

  /**
   * Settles the promise for one finished async call.
   *
   * The fields come from the `SteamAPICallCompleted_t` payload. A handle that
   * nobody awaits is ignored, which also covers a second completion for a call
   * that was already settled.
   *
   * @param call - The completed call handle.
   * @param callbackId - Id of the result struct, passed to `GetAPICallResult` as the expected id.
   * @param size - Size of the result struct in bytes.
   */
  private completeCall(call: bigint, callbackId: number, size: number): void {
    const pending = this.pending.get(call);
    if (!pending) return; // not ours (or already handled)
    this.pending.delete(call);
    this.updateRef();

    const out = Buffer.alloc(Math.max(size, 1));
    const failed = Buffer.alloc(1);
    const ok = this.nat.manualDispatchGetAPICallResult(this.pipe, call, out, size, callbackId, failed);
    if (!ok) {
      pending.reject(new SteamApiCallError('SteamAPI_ManualDispatch_GetAPICallResult failed', callbackId));
    } else if (failed[0] !== 0) {
      pending.reject(new SteamApiCallError('Steam reported an IO failure for this API call', callbackId));
    } else {
      pending.resolve(out);
    }
  }
}
