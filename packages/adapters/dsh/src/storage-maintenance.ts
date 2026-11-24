/**
 * Session storage maintenance: what an operator asks for and the mount never
 * does on its own.
 *
 * Two facts drive this module.
 *
 * 1. **Nothing expires.** Archived bytes live until the session directory is
 *    deleted (README: "There is no automatic deletion and no expiry in v1"), so
 *    a long-lived install only ever grows. `collectGarbage` is the seam that
 *    gives the operator a way to bound it: keep the N most recently used
 *    sessions, remove the rest.
 *
 * 2. **An archive is a file a user carries between devices** (ADR-0019), so
 *    reading one back must be possible without a live mount. `exportRecall`
 *    wraps core's `exportSession` for one session and writes it where the
 *    operator named.
 *
 * Both are deliberately offline: they read the directory, they never open a
 * live session's ledger for writing, and a session currently held by a live
 * mount is left alone by `collectGarbage` unless the caller says otherwise.
 * Deleting a directory out from under an open SQLite handle is the one thing
 * this module will not do by default.
 */

import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FileBlobStore, SqliteLedger } from '@cremator/core';
import type { LedgerArchive, SessionId } from '@cremator/core';

/** One session directory found under a storage root's `sessions/`. */
export interface StoredSession {
  readonly sessionId: string;
  /** Absolute path of the session's own directory. */
  readonly path: string;
  /** Last modification seen anywhere in the directory, as epoch millis. */
  readonly lastActivityMs: number;
  /** Total bytes on disk for this session (ledger + blobs). */
  readonly bytes: number;
}

/** One removal `collectGarbage` performed. */
export interface CollectedSession {
  readonly sessionId: string;
  readonly bytes: number;
}

/** What `collectGarbage` did, and what it left behind on purpose. */
export interface GarbageCollection {
  /** Sessions it removed, newest-last. */
  readonly removed: readonly CollectedSession[];
  /** Sessions it kept, with the reason. */
  readonly kept: readonly { readonly sessionId: string; readonly reason: 'retained' | 'live' | 'unreadable' }[];
  readonly bytesFreed: number;
}

/** A refusal the caller can branch on, with the session or path at fault. */
export class StorageMaintenanceError extends Error {
  readonly code: 'no-storage-root' | 'unknown-session' | 'export-failed';
  readonly path: string | null;
  constructor(code: StorageMaintenanceError['code'], message: string, path: string | null = null,
    options?: ErrorOptions) {
    super(message, options);
    this.name = 'StorageMaintenanceError';
    this.code = code;
    this.path = path;
  }
}

/** Every session directory under `root/sessions`, newest activity first. */
export function listStoredSessions(root: string): StoredSession[] {
  const sessionsDir = join(root, 'sessions');
  let names: string[];
  try { names = readdirSync(sessionsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch { return []; }
  const sessions: StoredSession[] = [];
  for (const name of names) {
    const path = join(sessionsDir, name);
    let lastActivityMs = 0;
    let bytes = 0;
    try {
      for (const file of readdirSync(path, { withFileTypes: true })) {
        const target = join(path, file.name);
        try {
          const stat = file.isDirectory() ? directoryUsage(target) : { bytes: statSync(target).size, mtimeMs: statSync(target).mtimeMs };
          bytes += stat.bytes;
          lastActivityMs = Math.max(lastActivityMs, stat.mtimeMs);
        } catch { /* a file that vanished mid-scan is not this session's problem */ }
      }
    } catch { /* an unreadable session is still listed, with zero activity */ }
    sessions.push({ sessionId: name, path, lastActivityMs, bytes });
  }
  return sessions.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

/** Bytes and newest mtime under one directory, recursively. */
function directoryUsage(dir: string): { bytes: number; mtimeMs: number } {
  let bytes = 0;
  let mtimeMs = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const target = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        const nested = directoryUsage(target);
        bytes += nested.bytes;
        mtimeMs = Math.max(mtimeMs, nested.mtimeMs);
      } else {
        const stat = statSync(target);
        bytes += stat.size;
        mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
      }
    } catch { /* vanished */ }
  }
  return { bytes, mtimeMs };
}

/**
 * Keep the `retain` most recently active sessions and remove the rest.
 *
 * "Most recently active" is the newest mtime anywhere in the session directory,
 * which is the only activity signal the storage itself carries: a session that
 * has not been touched since its last pass has an old mtime, and one in use now
 * has a current one.
 *
 * `liveSessionIds` names sessions a live mount currently holds. Those are
 * KEPT — deleting a directory under an open SQLite handle is not something a
 * maintenance sweep should do — and reported as `live`.
 *
 * `retain: 0` is refused rather than read as "remove everything": an operator
 * asking for that wants a different command, not a typo of this one.
 */
export function collectGarbage(options: {
  readonly root: string | undefined;
  readonly retain: number;
  readonly liveSessionIds?: readonly string[];
}): GarbageCollection {
  const { root, retain } = options;
  if (root === undefined) {
    throw new StorageMaintenanceError('no-storage-root',
      'this mount is in memory; there is no session directory to collect');
  }
  if (!Number.isSafeInteger(retain) || retain < 1) {
    throw new StorageMaintenanceError('no-storage-root',
      'retain must be a positive integer: removing every session is not this command');
  }
  const live = new Set(options.liveSessionIds ?? []);
  const sessions = listStoredSessions(root);
  const removed: CollectedSession[] = [];
  const kept: { sessionId: string; reason: 'retained' | 'live' | 'unreadable' }[] = [];
  let bytesFreed = 0;
  // Walk newest-first: a live session counts against the retain budget, because
  // it is one of the sessions this install is actually using.
  let budget = retain;
  for (const session of sessions) {
    if (live.has(session.sessionId)) {
      kept.push({ sessionId: session.sessionId, reason: 'live' });
      budget = Math.max(0, budget - 1);
      continue;
    }
    if (budget > 0) {
      kept.push({ sessionId: session.sessionId, reason: 'retained' });
      budget -= 1;
      continue;
    }
    try {
      // A checkpoint before the delete keeps a half-written WAL from looking
      // like a session that is still being written to; a refusal is harmless
      // here because the directory is about to go.
      rmSync(session.path, { recursive: true, force: true });
      removed.push({ sessionId: session.sessionId, bytes: session.bytes });
      bytesFreed += session.bytes;
    } catch {
      kept.push({ sessionId: session.sessionId, reason: 'unreadable' });
    }
  }
  return { removed, kept, bytesFreed };
}

/**
 * Export one session's archive to `targetPath`.
 *
 * Folds the ledger's WAL first (`SqliteLedger.checkpoint`) so the archive
 * describes everything the ledger committed, then writes core's canonical
 * archive document — the same bytes `SqliteLedger.export` answers, suitable
 * for `hydrate` on another device.
 *
 * An unknown session is refused by name instead of writing an empty archive: a
 * missing id and an empty session are different facts, and only one of them is
 * worth a file.
 */
export async function exportRecall(options: {
  readonly root: string | undefined;
  readonly sessionId: string;
  readonly targetPath: string;
}): Promise<{ readonly archive: LedgerArchive; readonly bytes: number }> {
  const { root, sessionId, targetPath } = options;
  if (root === undefined) {
    throw new StorageMaintenanceError('no-storage-root',
      'this mount is in memory; there is no session directory to export from');
  }
  const sessionsDir = join(root, 'sessions');
  const sessionPath = join(sessionsDir, sessionId);
  try { statSync(sessionPath); }
  catch (error) {
    throw new StorageMaintenanceError('unknown-session',
      `no stored session named ${sessionId}`, sessionPath, { cause: error });
  }
  // `exportSession` is core's seam over a live DatabaseSync; it is reached here
  // through `SqliteLedger` so the caller never holds the handle.
  const ledger = await SqliteLedger.open({
    databasePath: join(sessionPath, 'ledger.sqlite'),
    blobStore: new FileBlobStore(join(sessionPath, 'blobs')),
    clock: { nowMs: () => Date.now() },
  });
  try {
    ledger.checkpoint();
    // `LedgerArchive.bytes` IS the archive: core's canonical document, the same
    // bytes `hydrate` reads back. It is written verbatim — re-encoding it here
    // would be a second serializer that could disagree with the reader.
    const archive = await ledger.export(sessionId as SessionId);
    writeFileSync(targetPath, archive.bytes);
    return { archive, bytes: archive.bytes.length };
  } catch (error) {
    throw new StorageMaintenanceError('export-failed',
      `could not export ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      sessionPath, { cause: error });
  } finally {
    await ledger.close();
  }
}

/**
 * Re-export for a caller that wants the raw document rather than a file, or
 * that already holds a path pair (a rig, a test). Kept separate so `exportRecall`
 * stays the operator's one-call shape.
 */
export async function readArchive(databasePath: string, blobRoot: string,
  sessionId: string): Promise<LedgerArchive> {
  const ledger = await SqliteLedger.open({ databasePath, blobStore: new FileBlobStore(blobRoot),
    clock: { nowMs: () => Date.now() } });
  try {
    ledger.checkpoint();
    return await ledger.export(sessionId as SessionId);
  } finally { await ledger.close(); }
}

/** Read a growing JSONL journal file back, one record per line. Tolerates a torn tail. */
export function readJournalRecords(path: string): Record<string, unknown>[] {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  const records: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch { /* a torn last line is expected while the file is being written */ }
  }
  return records;
}
