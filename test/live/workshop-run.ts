import * as fs from 'node:fs';
import * as path from 'node:path';
import { SteamApiCallError } from '../../src/runtime/dispatch';
import { SteamResultError } from '../../src/api/errors';
import { EResult } from '../../src/generated/enums';

export class LiveTimeoutError extends Error {}

export async function within<T>(operation: Promise<T>, label: string, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LiveTimeoutError(`${label} timed out; Steam may still be processing it.`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A local journal and exclusive directory for one Workshop acceptance run. */
export class WorkshopRun {
  readonly directory: string;
  readonly journal: string;
  private uncertain = false;
  private record: { appId: number; steamId: bigint; startedAt: string; stage: string; fileId?: bigint };

  constructor(root: string, appId: number, steamId: bigint) {
    this.directory = path.resolve(root, 'workshop');
    this.journal = path.join(this.directory, 'recovery.json');
    fs.mkdirSync(path.resolve(root), { recursive: true });
    try {
      fs.mkdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new Error(`Another or unfinished Workshop run exists at ${this.directory}. Inspect and resolve it before retrying.`);
    }
    this.record = { appId, steamId, startedAt: new Date().toISOString(), stage: 'ready' };
    this.save();
  }

  private save(): void {
    const temporary = path.join(this.directory, 'recovery.tmp');
    // JSON needs decimal strings for 64-bit IDs. Keep bigint everywhere in memory.
    fs.writeFileSync(temporary, JSON.stringify(this.record, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    fs.renameSync(temporary, this.journal);
  }

  recordItem(fileId: bigint): void {
    if (fileId <= 0n) throw new Error('Steam returned an invalid Workshop item ID.');
    this.record.fileId = fileId;
    this.save();
  }

  async call<T>(label: string, operation: () => Promise<T>, milliseconds = 60_000): Promise<T> {
    if (this.uncertain) throw new Error(`Resolve ${this.journal} before starting another operation.`);
    this.record.stage = label;
    this.save();
    try {
      return await within(operation(), label, milliseconds);
    } catch (error) {
      // An IO failure or deadline cannot prove whether a remote write completed.
      if (error instanceof LiveTimeoutError || error instanceof SteamApiCallError ||
          (error instanceof SteamResultError &&
            (error.result === EResult.k_EResultTimeout || error.result === EResult.k_EResultDuplicateRequest))) {
        this.uncertain = true;
      }
      throw error;
    }
  }

  async cleanup(deleteItem: (fileId: bigint) => Promise<void>, milliseconds = 60_000): Promise<void> {
    if (this.uncertain) {
      throw new Error(`Workshop outcome is uncertain. No delete or retry was sent. Recover using ${this.journal}.`);
    }
    if (this.record.fileId !== undefined) {
      try {
        await this.call('delete item', () => deleteItem(this.record.fileId!), milliseconds);
      } catch (error) {
        throw new Error(`Workshop cleanup failed. Keep ${this.journal} for recovery.`, { cause: error });
      }
    }
    // Only remove the fixed directory this run created, never a path from Steam or the journal.
    fs.rmSync(this.directory, { recursive: true });
  }
}
