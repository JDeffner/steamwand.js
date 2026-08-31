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

export class SteamApiCallError extends Error {
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
 */
export class SteamDispatch {
  private readonly getNextCallback: koffi.KoffiFunction;
  private timer: NodeJS.Timeout | undefined;
  private readonly pending = new Map<bigint, PendingCall>();
  private readonly listeners = new Map<number, Set<(buf: Buffer) => void>>();

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

  start(intervalMs = 50): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.runFrame(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const p of this.pending.values()) {
      p.reject(new Error('steamwand: dispatch stopped while call was in flight'));
    }
    this.pending.clear();
  }

  /** Await the raw bytes of a call result. */
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
   * The pump must not keep an idle process alive, but a pending Steam call
   * must: ref the interval while calls are in flight, unref when drained.
   */
  private updateRef(): void {
    if (!this.timer) return;
    if (this.pending.size > 0) this.timer.ref();
    else this.timer.unref();
  }

  /** Await a call result and decode it with the given layout. */
  async callResultStruct<T>(call: bigint, layout: StructLayout): Promise<T> {
    const buf = await this.callResult(call);
    return decodeStruct<T>(buf, layout);
  }

  /** Subscribe to a plain callback by id; returns an unsubscribe function. */
  on(callbackId: number, listener: (buf: Buffer) => void): () => void {
    let set = this.listeners.get(callbackId);
    if (!set) {
      set = new Set();
      this.listeners.set(callbackId, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Drain everything Steam has queued. Called by the interval; callable directly in tests. */
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

  /** Copy the callback param bytes before FreeLastCallback invalidates them. */
  private readParam(msg: CallbackMsgJs): Buffer {
    const decoded = koffi.decode(msg.m_pubParam, koffi.array('uint8', msg.m_cubParam)) as Uint8Array;
    return Buffer.from(decoded);
  }

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
