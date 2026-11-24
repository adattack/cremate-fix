// The ledger's file must stand alone after close().
//
// WAL mode keeps committed pages — including the schema itself — in
// `<database>-wal` until a checkpoint folds them back. A backup that copies
// only `ledger.sqlite` therefore reads an EMPTY database, and every recall id
// silently answers not-found. Both halves are pinned here: the pre-fix shape
// (WAL carries the data) and the post-close guarantee (the main file carries it).

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';

import { FileBlobStore } from '../src/ledger/file-blob-store.js';
import { SqliteLedger } from '../src/ledger/sqlite-ledger.js';
import type { SessionId } from '../src/types/identity.js';

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cremator-checkpoint-'));
  dirs.push(dir);
  return dir;
}
// Windows refuses to remove a directory while any handle inside it is open, and
// a failed assertion can leave one behind. Cleanup is therefore best-effort and
// retried; a leftover temp directory must never turn a green suite red.
after(() => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
    catch { /* a lingering handle on Windows; the OS reclaims the temp dir */ }
  }
});

const clock = { nowMs: () => 1_700_000_000_000 };
const SESSION = 'session-checkpoint' as SessionId;

async function openLedger(root: string): Promise<SqliteLedger> {
  return SqliteLedger.open({
    databasePath: join(root, 'ledger.sqlite'),
    blobStore: new FileBlobStore(join(root, 'blobs')),
    clock,
  });
}

/** A ledger with one committed event, so the schema and a row both exist. */
async function seed(root: string): Promise<SqliteLedger> {
  const ledger = await openLedger(root);
  await ledger.append({
    kind: 'validation', sessionId: SESSION,
    eventKey: 'engine-validation:["test"]', atMs: 1_700_000_000_000,
    eventId: 'test:event', ok: true, issues: [],
    breaker: { consecutiveValidationFailures: 0, disabled: false },
  });
  return ledger;
}

/** What an operator's plain file copy would see: the main file with no sidecars. */
function copyWithoutWal(root: string): DatabaseSync {
  const copy = join(root, 'copied.sqlite');
  copyFileSync(join(root, 'ledger.sqlite'), copy);
  return new DatabaseSync(copy, { readOnly: true });
}

/** The event count a copy of the main file alone can read, or the refusal it hit. */
function eventsInMainFileOnly(root: string): number | string {
  const copy = copyWithoutWal(root);
  try {
    return (copy.prepare('SELECT count(*) AS c FROM ledger_events').get() as { c: number }).c;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally { copy.close(); }
}

describe('the ledger file stands alone', () => {
  it('WAL carries the schema until a checkpoint, which is why close() folds it', async () => {
    const root = scratch();
    const ledger = await seed(root);
    try {
      // The pre-fix shape, asserted so the fix cannot be read as cosmetic: while
      // the ledger is open the main file is a shell, so a copy of it alone fails.
      assert.ok(existsSync(join(root, 'ledger.sqlite-wal')), 'an open WAL ledger keeps a -wal sidecar');
      const answer = eventsInMainFileOnly(root);
      assert.equal(typeof answer, 'string');
      assert.match(answer as string, /no such table/, 'the main file alone has no schema yet');
    } finally { await ledger.close(); }
  });

  it('after close() the main file answers on its own, and the WAL is empty', async () => {
    const root = scratch();
    const ledger = await seed(root);
    await ledger.close();
    assert.equal(eventsInMainFileOnly(root), 1, 'the committed event travelled with the main file');
    const wal = join(root, 'ledger.sqlite-wal');
    assert.equal(existsSync(wal) ? statSync(wal).size : 0, 0, 'TRUNCATE left an empty WAL');
  });

  it('checkpoint() is callable before an export and answers whether it folded', async () => {
    const root = scratch();
    const ledger = await seed(root);
    try {
      assert.equal(ledger.checkpoint(), true);
      assert.equal(eventsInMainFileOnly(root), 1);
    } finally { await ledger.close(); }
  });

  it('a checkpoint after close() is a no-op, never a throw', async () => {
    const root = scratch();
    const ledger = await seed(root);
    await ledger.close();
    assert.equal(ledger.checkpoint(), false);
  });

  it('close() still succeeds when a competing reader pins the WAL', async () => {
    const root = scratch();
    const ledger = await seed(root);
    // A read-only connection holding an open read mark is the shape a competing
    // reader takes in production. Whatever SQLite answers, close() completes:
    // housekeeping never fails a close.
    const reader = new DatabaseSync(join(root, 'ledger.sqlite'), { readOnly: true });
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT count(*) FROM ledger_events').get();
      await assert.doesNotReject(ledger.close());
    } finally {
      try { reader.exec('ROLLBACK'); } catch { /* the transaction may be gone */ }
      reader.close();
    }
  });
});
