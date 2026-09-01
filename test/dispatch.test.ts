/**
 * Offline tests for the manual dispatch pump.
 *
 * `SteamDispatch` only ever touches four native entry points, so a fake
 * `SteamNative` with a callback queue we control exercises the whole pump
 * without a Steam client. Frames are driven by calling `runFrame()` directly,
 * so no timer is ever started.
 */
import { describe, expect, test } from 'vitest';
import { SteamApiCallError, SteamDispatch } from '../src/runtime/dispatch';
import type { SteamNative } from '../src/runtime/native';

const PIPE = 1;

/** SteamAPICallCompleted_t payload: uint64 handle, int32 callback id, uint32 size. */
function completion(call: bigint, callbackId: number, size: number): Buffer {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(call, 0);
  b.writeInt32LE(callbackId, 8);
  b.writeUInt32LE(size, 12);
  return b;
}

/** Minimal stand-in for the native surface the pump uses. */
class FakeNative {
  /** Callbacks `GetNextCallback` will hand out, in order. */
  readonly queue: { id: number; param: Buffer }[] = [];
  /** What `GetAPICallResult` writes into the out buffer. */
  resultBytes = Buffer.alloc(0);
  /** Return value of `GetAPICallResult`. */
  resultOk = true;
  /** Value of its `failed` out byte. */
  resultFailed = false;
  freed = 0;

  readonly lib = {
    func: () => (_pipe: number, msg: Record<string, unknown>) => {
      const next = this.queue.shift();
      if (!next) return false;
      msg.m_hSteamUser = 1;
      msg.m_iCallback = next.id;
      msg.m_pubParam = next.param; // koffi.decode reads straight from a Buffer
      msg.m_cubParam = next.param.length;
      return true;
    },
  };

  manualDispatchRunFrame = (): void => {};
  manualDispatchFreeLastCallback = (): void => {
    this.freed++;
  };
  manualDispatchGetAPICallResult = (
    _pipe: number,
    _call: bigint,
    out: Buffer,
    _size: number,
    _expectedId: number,
    failed: Buffer,
  ): boolean => {
    this.resultBytes.copy(out);
    failed[0] = this.resultFailed ? 1 : 0;
    return this.resultOk;
  };
}

function makeDispatch(): { nat: FakeNative; dispatch: SteamDispatch } {
  const nat = new FakeNative();
  return { nat, dispatch: new SteamDispatch(nat as unknown as SteamNative, PIPE) };
}

describe('call results', () => {
  test('a completion resolves the matching call with the result bytes', async () => {
    const { nat, dispatch } = makeDispatch();
    nat.resultBytes = Buffer.from([0x01, 0x00, 0x00, 0x00, 0xef, 0xbe]);

    const result = dispatch.callResult(0x1234n);
    nat.queue.push({ id: 703, param: completion(0x1234n, 3403, nat.resultBytes.length) });
    dispatch.runFrame();

    await expect(result).resolves.toEqual(nat.resultBytes);
    expect(nat.freed).toBe(1);
  });

  test('an invalid call handle rejects without a frame', async () => {
    const { dispatch } = makeDispatch();
    await expect(dispatch.callResult(0n)).rejects.toBeInstanceOf(SteamApiCallError);
  });

  test('an IO failure flag rejects the call', async () => {
    const { nat, dispatch } = makeDispatch();
    nat.resultBytes = Buffer.alloc(4);
    nat.resultFailed = true;

    const result = dispatch.callResult(9n);
    nat.queue.push({ id: 703, param: completion(9n, 3403, 4) });
    dispatch.runFrame();

    await expect(result).rejects.toThrow(SteamApiCallError);
  });

  test('a completion with the wrong callback id rejects instead of decoding', async () => {
    const { nat, dispatch } = makeDispatch();
    let read = false;
    nat.manualDispatchGetAPICallResult = () => {
      read = true;
      return true;
    };

    const result = dispatch.callResult(5n, 3401);
    nat.queue.push({ id: 703, param: completion(5n, 3403, 8) });
    dispatch.runFrame();

    await expect(result).rejects.toThrow(/3401.*3403/);
    expect(read).toBe(false);
  });

  test('stop() rejects a call that is still in flight', async () => {
    const { dispatch } = makeDispatch();
    const result = dispatch.callResult(42n);
    dispatch.stop();
    await expect(result).rejects.toThrow(/dispatch stopped/);
  });
});

describe('plain callbacks', () => {
  test('a callback reaches its listener until it unsubscribes', () => {
    const { nat, dispatch } = makeDispatch();
    const seen: Buffer[] = [];
    const off = dispatch.on(3405, (buf) => seen.push(buf));

    nat.queue.push({ id: 3405, param: Buffer.from([7, 8, 9]) });
    dispatch.runFrame();
    expect(seen).toEqual([Buffer.from([7, 8, 9])]);

    off();
    nat.queue.push({ id: 3405, param: Buffer.from([1, 2, 3]) });
    dispatch.runFrame();
    expect(seen).toHaveLength(1);
    expect(nat.freed).toBe(2);
  });
});
