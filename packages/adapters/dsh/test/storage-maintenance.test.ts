/**
 * The operator lanes: `/cremate gc` and `/cremate export`.
 *
 * Storage never expires on its own (ADR-0013: archived bytes live until the
 * session directory is deleted), so these two commands are the only way an
 * install's footprint is ever bounded or carried elsewhere. Both are therefore
 * pinned on the things that would make them dangerous: what a sweep refuses to
 * delete, and what an export refuses to write.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { FileBlobStore, SqliteLedger } from '@cremator/core';
import type { SessionId } from '@cremator/core';

import {
  StorageMaintenanceError, collectGarbage, exportRecall, listStoredSessions, readJournalRecords,
} from '../src/storage-maintenance.js';

const roots: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cremator-storage-'));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
    catch { /* a lingering handle on Windows; the OS reclaims it */ }
  }
});

/** A durable root holding one real ledger per named session, oldest first. */
async function seedRoot(sessions: readonly string[]): Promise<string> {
  const root = scratch();
  for (const [index, sessionId] of sessions.entries()) {
    const dir = join(root, 'sessions', sessionId);
    mkdirSync(dir, { recursive: true });
    const ledger = await SqliteLedger.open({
      databasePath: join(dir, 'ledger.sqlite'),
      blobStore: new FileBlobStore(join(dir, 'blobs')),
      clock: { nowMs: () => 1_700_000_000_000 + index * 1_000 },
    });
    await ledger.append({ kind: 'validation', sessionId: sessionId as SessionId,
      eventKey: `engine-validation:["${sessionId}"]`, atMs: 1_700_000_000_000,
      eventId: 'test:event', ok: true, issues: [],
      breaker: { consecutiveValidationFailures: 0, disabled: false } });
    await ledger.close();
    // Space the activity out so "newest" is unambiguous.
    const stamp = 1_700_000_000 + index * 100;
    utimesSync(join(dir, 'ledger.sqlite'), stamp, stamp);
  }
  return root;
}

describe('listing', () => {
  it('orders stored sessions newest activity first, with their sizes', async () => {
    const root = await seedRoot(['session-old', 'session-mid', 'session-new']);
    const listed = listStoredSessions(root);
    assert.deepEqual(listed.map(session => session.sessionId),
      ['session-new', 'session-mid', 'session-old']);
    for (const session of listed) assert.ok(session.bytes > 0, 'a seeded ledger has bytes');
  });

  it('answers an empty list for a root that has no sessions directory', () => {
    assert.deepEqual(listStoredSessions(scratch()), []);
  });
});

describe('the sweep', () => {
  it('keeps the newest N and removes the rest', async () => {
    const root = await seedRoot(['session-1', 'session-2', 'session-3', 'session-4']);
    const result = collectGarbage({ root, retain: 2 });
    assert.deepEqual(result.removed.map(entry => entry.sessionId).sort(),
      ['session-1', 'session-2']);
    assert.deepEqual(result.kept.map(entry => entry.sessionId).sort(),
      ['session-3', 'session-4']);
    assert.ok(result.bytesFreed > 0);
    // The directories really went, and the kept ones really stayed.
    assert.equal(existsSync(join(root, 'sessions', 'session-1')), false);
    assert.equal(existsSync(join(root, 'sessions', 'session-4')), true);
    assert.deepEqual(listStoredSessions(root).map(session => session.sessionId),
      ['session-4', 'session-3']);
  });

  it('never removes a session a live mount holds, and counts it against the budget', async () => {
    const root = await seedRoot(['session-1', 'session-2', 'session-3']);
    const result = collectGarbage({ root, retain: 1, liveSessionIds: ['session-1'] });
    // session-1 is live: kept, and it consumes the whole budget...
    assert.deepEqual(result.kept.map(entry => entry.sessionId).sort(),
      ['session-1', 'session-3']);
    assert.equal(result.kept.find(entry => entry.sessionId === 'session-1')?.reason, 'live');
    // ...so only the oldest non-live session is removed.
    assert.deepEqual(result.removed.map(entry => entry.sessionId), ['session-2']);
    assert.equal(existsSync(join(root, 'sessions', 'session-1')), true);
  });

  it('refuses to be asked to remove everything', () => {
    assert.throws(() => collectGarbage({ root: scratch(), retain: 0 }),
      (error: unknown) => error instanceof StorageMaintenanceError
        && error.code === 'no-storage-root');
    assert.throws(() => collectGarbage({ root: scratch(), retain: -1 }),
      (error: unknown) => error instanceof StorageMaintenanceError);
  });

  it('refuses a mount with no durable root', () => {
    assert.throws(() => collectGarbage({ root: undefined, retain: 1 }),
      (error: unknown) => error instanceof StorageMaintenanceError
        && error.code === 'no-storage-root');
  });

  it('accounts for every session exactly once, removed or kept with a reason', async () => {
    const root = await seedRoot(['session-1', 'session-2', 'session-3']);
    const result = collectGarbage({ root, retain: 1 });
    // The sweep's own invariant: no session may be both removed and kept, and
    // none may vanish from the report — otherwise an operator cannot tell a
    // refused delete from a directory the sweep never saw.
    const removed = result.removed.map(entry => entry.sessionId);
    const kept = result.kept.map(entry => entry.sessionId);
    assert.equal(new Set([...removed, ...kept]).size, 3);
    assert.equal(removed.length + kept.length, 3);
    for (const entry of result.kept) {
      assert.ok(['retained', 'live', 'unreadable'].includes(entry.reason));
    }
    // The freed total is the sum of what it removed, never a guess.
    assert.equal(result.bytesFreed, result.removed.reduce((sum, entry) => sum + entry.bytes, 0));
  });
});

describe('the export', () => {
  it('writes the archive bytes core produces, which carry the session', async () => {
    const root = await seedRoot(['session-export']);
    const target = join(root, 'session-export.archive.json');
    const written = await exportRecall({ root, sessionId: 'session-export', targetPath: target });
    assert.ok(written.bytes > 0);
    assert.equal(readFileSync(target).length, written.bytes);
    const document = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(document.sessionId, 'session-export');
    assert.equal(written.archive.sessionId, 'session-export');
    // The archive's own digest is what hydrate re-checks.
    assert.match(written.archive.archiveSha256, /^[0-9a-f]{64}$/u);
  });

  it('folds the WAL first, so the archive is not an empty shell', async () => {
    // The export checkpoints the ledger before reading it. Without that, a
    // ledger whose pages still live in the -wal file would export an EMPTY
    // document — the failure mode the checkpoint case in core pins.
    const root = await seedRoot(['session-wal']);
    const target = join(root, 'out.json');
    const written = await exportRecall({ root, sessionId: 'session-wal', targetPath: target });
    const document = JSON.parse(readFileSync(target, 'utf8'));
    const validations = document.tables.ledger_events as { kind: string }[];
    assert.ok(validations.some(row => row.kind === 'validation'), 'the committed event exported');
    assert.ok(written.bytes > 100, 'a real document, not an empty envelope');
  });

  it('refuses an unknown session instead of writing an empty archive', async () => {
    const root = await seedRoot(['session-known']);
    const target = join(root, 'nothing.json');
    await assert.rejects(
      exportRecall({ root, sessionId: 'session-absent', targetPath: target }),
      (error: unknown) => error instanceof StorageMaintenanceError
        && error.code === 'unknown-session',
    );
    assert.equal(existsSync(target), false, 'no file was written for a session that does not exist');
  });

  it('refuses a mount with no durable root', async () => {
    await assert.rejects(
      exportRecall({ root: undefined, sessionId: 's', targetPath: 'x.json' }),
      (error: unknown) => error instanceof StorageMaintenanceError
        && error.code === 'no-storage-root',
    );
  });
});

describe('reading a journal back', () => {
  it('skips a torn last line instead of failing the read', () => {
    const dir = scratch();
    const path = join(dir, 'journal.jsonl');
    writeFileSync(path, '{"kind":"prune-ask","inputTokens":10}\n{"kind":"prune-apply"');
    const records = readJournalRecords(path);
    assert.equal(records.length, 1, 'the complete line survives, the torn one is dropped');
    assert.equal(records[0]!.kind, 'prune-ask');
  });

  it('answers an empty list for a journal that is not there', () => {
    assert.deepEqual(readJournalRecords(join(scratch(), 'absent.jsonl')), []);
  });
});
