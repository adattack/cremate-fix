/**
 * The host-shape probe (see `src/host-compat.ts`).
 *
 * The adapter reads a session through `eventAt`, `surface.nodes` and the two
 * `surfaceOp` spellings. When one of those moves, the old behaviour was to
 * mount anyway and fail later with a guard verdict about the PLAN — which
 * named the wrong component and cost a debugging session (ISSUE-064). These
 * cases pin the refusal at the seam that can name the field.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DshHostIncompatibleError, probeEvent, probeHost, probeSession, probeSurfaceOp,
} from '../src/host-compat.js';

const EVENT = { type: 'user/message', seq: 3, data: {}, surfaceOp: 'append' };
const SESSION = { id: 'session-1', seq: 4, surface: { nodes: [0, 3] },
  eventAt: (seq: number) => (seq === 0 ? { type: 'turn/start', seq: 0, data: {} } : undefined),
  append: () => ({ type: 'x', seq: 0 }) };

describe('the surface op shapes the fold understands', () => {
  it('accepts both shipped spellings and an absent op', () => {
    assert.equal(probeSurfaceOp(undefined), null);
    assert.equal(probeSurfaceOp(null), null);
    assert.equal(probeSurfaceOp('append'), null);
    assert.equal(probeSurfaceOp({ op: 'replace', startSeq: 8, endSeq: 8 }), null);
  });

  it('names an unknown spelling instead of folding it wrongly', () => {
    const problem = probeSurfaceOp({ op: 'splice', startSeq: 1, endSeq: 2 });
    assert.equal(problem?.field, 'event.surfaceOp.op');
    assert.match(String(problem?.actual), /splice/u);
  });

  it('requires both replace positions as safe integers', () => {
    assert.equal(probeSurfaceOp({ op: 'replace', startSeq: 1 })?.field, 'event.surfaceOp.endSeq');
    assert.equal(probeSurfaceOp({ op: 'replace', startSeq: -1, endSeq: 0 })?.field,
      'event.surfaceOp.startSeq');
    assert.equal(probeSurfaceOp({ op: 'replace', startSeq: 1.5, endSeq: 2 })?.field,
      'event.surfaceOp.startSeq');
  });

  it('refuses a non-object op by shape', () => {
    assert.equal(probeSurfaceOp(7)?.field, 'event.surfaceOp');
    assert.equal(probeSurfaceOp(['append'])?.field, 'event.surfaceOp');
  });
});

describe('one event', () => {
  it('accepts a well-formed event', () => {
    assert.equal(probeEvent(EVENT), null);
  });

  it('names a missing type or a non-integer seq', () => {
    assert.equal(probeEvent({ seq: 1 })?.field, 'event.type');
    assert.equal(probeEvent({ type: 'user/message', seq: 1.5 })?.field, 'event.seq');
    assert.equal(probeEvent(null)?.field, 'session.eventAt(seq)');
  });
});

describe('one session', () => {
  it('accepts the shape the fold reads', () => {
    assert.deepEqual(probeSession(SESSION), []);
  });

  it('requires a readable eventAt seam', () => {
    const problems = probeSession({ id: 's', append: () => undefined });
    assert.deepEqual(problems.map(problem => problem.field), ['session.eventAt']);
  });

  it('refuses a surface whose nodes are not an array', () => {
    const problems = probeSession({ ...SESSION, surface: { nodes: 'not-an-array' } });
    assert.deepEqual(problems.map(problem => problem.field), ['session.surface.nodes']);
  });

  it('treats an absent log position as legal, and a throwing seam as a problem', () => {
    // An empty session reads no events and plans nothing: not a defect.
    assert.deepEqual(probeSession({ id: 's', eventAt: () => undefined }), []);
    const problems = probeSession({ id: 's', eventAt: () => { throw new Error('boom'); } });
    assert.equal(problems[0]?.field, 'session.eventAt(0)');
    assert.match(String(problems[0]?.actual), /boom/u);
  });

  it('reports a repeated field once across many sessions', () => {
    const broken = { id: 's', append: () => undefined };
    assert.equal(probeHost([broken, broken, broken]).length, 1);
  });
});

describe('the refusal', () => {
  it('names every field and the tested range in one message', () => {
    const error = new DshHostIncompatibleError([
      { field: 'session.eventAt', expected: 'a function over a log position', actual: 'nothing' },
      { field: 'session.surface.nodes', expected: 'an array of log positions when declared',
        actual: 'a string' },
    ]);
    assert.equal(error.name, 'DshHostIncompatibleError');
    assert.match(error.message, /session\.eventAt/u);
    assert.match(error.message, /session\.surface\.nodes/u);
    assert.match(error.message, /refusing to mount/u);
    assert.equal(error.problems.length, 2);
  });
});
