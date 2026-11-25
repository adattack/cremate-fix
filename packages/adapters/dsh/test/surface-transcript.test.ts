/**
 * The surface fold, and the carry that makes it incremental.
 *
 * Two properties are pinned here, and they pull in opposite directions:
 *   - the fold must be CORRECT for the ordinals the guard reads, the bytes the
 *     model reads and the pairing a tool result needs, and
 *   - a repeated fold must not re-derive what cannot have changed, because a
 *     boundary folds the same surface several times a step and encoding every
 *     body again is the expensive half.
 *
 * Every carry case therefore asserts the SAME projection both ways: cold, and
 * through a carry that has already folded the log. A carry that answered
 * differently from a cold fold would be a correctness bug wearing a speed-up's
 * clothes.
 *
 * The `replace` block below is a REGRESSION suite for one live failure: a
 * re-published system prompt used to make the ordinal walk go backwards, and
 * core refused every plan built on it. See that block's header.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_CONFIG, Guard } from '@cremator/core';
import type { TranscriptNode } from '@cremator/core';
import { toCoreTranscript } from '../src/envelope.js';

/** One core transcript node, as `toCoreTranscript` produces it. */
type EnvelopeNode = TranscriptNode;
import { createSurfaceCarry, surfaceTranscript } from '../src/plugin.js';

const decoder = new TextDecoder();

/**
 * One host log: turns of a system prompt, a user turn, a call and its result.
 *
 * The two host spellings the fold reads are stated exactly as dsh states them:
 * a user message's content sits on `data`, every other role's sits under
 * `data.message`, and a tool result names its call through
 * `data.message.source.callId` (`callIdOf`).
 */
function makeLog(turns: number): { log: any[]; nodes: number[] } {
  const log: any[] = [];
  let seq = 0;
  for (let turn = 1; turn <= turns; turn += 1) {
    log.push({ type: 'turn/start', seq: seq++, data: { turn } });
    log.push({ type: 'step/start', seq: seq++, data: { turn, step: 1 } });
    log.push({ type: 'system/message', seq: seq++, surfaceOp: 'append',
      data: { turn, step: 1, message: { content: [{ type: 'text', text: 'SYS ' + turn }] } } });
    log.push({ type: 'user/message', seq: seq++, surfaceOp: 'append',
      data: { content: [{ type: 'text', text: 'ask ' + turn }] } });
    log.push({ type: 'tool/call', seq: seq++,
      data: { callId: 'call-' + turn, name: 'read', arguments: '{"path":"a"}' } });
    log.push({ type: 'tool/result', seq: seq++, surfaceOp: 'append',
      data: { message: { source: { callId: 'call-' + turn },
        content: [{ type: 'text', text: 'result ' + turn }] } } });
    log.push({ type: 'turn/end', seq: seq++, data: { turn } });
  }
  return { log, nodes: log.filter(event => event.surfaceOp === 'append').map(event => event.seq) };
}

function sessionOf(log: any[], nodes: number[]) {
  return { id: 'session-fold', seq: log.length, surface: { nodes },
    eventAt: (seq: number) => log[seq], append: () => ({ type: 'x', seq: 0 }) };
}

function summarize(projected: { items: any[]; seqs: number[] }) {
  return { ids: projected.items.map(item => item.id),
    roles: projected.items.map(item => item.role),
    texts: projected.items.map(item => decoder.decode(item.bytes)),
    ordinals: projected.items.map(item => item.turnOrdinal + ':' + item.stepOrdinal),
    seqs: projected.seqs };
}

describe('the surface fold', () => {
  it('projects one item per surface position, with monotone ordinals', () => {
    const { log, nodes } = makeLog(2);
    const projected = surfaceTranscript(sessionOf(log, nodes), { sessionId: 'session-fold' });
    assert.equal(projected.items.length, nodes.length);
    assert.deepEqual(projected.items.map(item => item.role),
      ['system', 'user', 'tool', 'system', 'user', 'tool']);
    assert.deepEqual(projected.items.map(item => decoder.decode(item.bytes)),
      ['SYS 1', 'ask 1', 'result 1', 'SYS 2', 'ask 2', 'result 2']);
    let previousTurn = -1;
    let previousStep = -1;
    for (const item of projected.items) {
      assert.ok(item.turnOrdinal >= previousTurn, 'turn ordinals never decrease');
      assert.ok(item.stepOrdinal >= previousStep, 'step ordinals never decrease');
      previousTurn = item.turnOrdinal;
      previousStep = item.stepOrdinal;
    }
  });

  it('carries the call facts a tool result needs from the log itself', () => {
    const { log, nodes } = makeLog(1);
    const projected = surfaceTranscript(sessionOf(log, nodes), { sessionId: 'session-fold' });
    const tool = projected.items.find(item => item.role === 'tool') as any;
    assert.equal(tool.toolName, 'read');
    assert.equal(tool.callId, 'call-1');
  });

  it('cuts at beforeSeq, exclusive', () => {
    const { log, nodes } = makeLog(2);
    const all = surfaceTranscript(sessionOf(log, nodes), { sessionId: 'session-fold' });
    const cut = surfaceTranscript(sessionOf(log, nodes),
      { sessionId: 'session-fold', beforeSeq: all.seqs[2]! });
    assert.equal(cut.items.length, 2, 'the position at the cut is excluded');
    assert.deepEqual(cut.seqs, all.seqs.slice(0, 2));
  });
});

describe('surfaceOp REPLACE keeps the slot it took over', () => {
  /**
   * A re-published slot, stated as dsh states it: `{op:'replace', startSeq,
   * endSeq}` at a LATER seq, while the surface keeps the slot it names.
   */
  function replaceLog() {
    const log: any[] = [
      { type: 'session', seq: 0, data: {} },
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 2, data: { turn: 1, step: 1 } },
      { type: 'system/message', seq: 3, surfaceOp: 'append',
        data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'SYS v1' }] } } },
      { type: 'user/message', seq: 4, surfaceOp: 'append',
        data: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'turn/end', seq: 5, data: { turn: 1 } },
      { type: 'turn/start', seq: 6, data: { turn: 2 } },
      { type: 'step/start', seq: 7, data: { turn: 2, step: 1 } },
      { type: 'system/message', seq: 8, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 },
        data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'SYS v2' }] } } },
      { type: 'user/message', seq: 9, surfaceOp: 'append',
        data: { content: [{ type: 'text', text: 'again' }] } },
    ];
    // The surface after the replace: the slot keeps its PLACE, its content moved.
    return { log, nodes: [8, 4, 9] };
  }

  it('projects the replaced slot in place, with the new bytes', () => {
    const { log, nodes } = replaceLog();
    const projected = surfaceTranscript(sessionOf(log, nodes), { sessionId: 'session-fold' });
    assert.deepEqual(projected.seqs, [8, 4, 9],
      'the replaced position stays first, at the seq that re-published it');
    assert.deepEqual(projected.items.map(item => decoder.decode(item.bytes)),
      ['SYS v2', 'hi', 'again']);
    assert.deepEqual(projected.items.map(item => item.role), ['system', 'user', 'user']);
  });

  /**
   * REGRESSION: a re-published slot keeps the ordinal of the PLACE it occupies.
   *
   * An ordinal is a property of a transcript position, not of the moment a
   * message was published, and the guard requires the walk to be monotone.
   * dsh re-publishes the system prompt (the project instructions) every turn,
   * and that event carries its OWN `(turn, step)` while it still sits in the
   * transcript's first slot. Reading the event's own pair first stamped `2:2`
   * on the FIRST item and left `1:1` on the second — the walk went backwards
   * and every plan built on that snapshot was refused with
   * `adjacency-changed: Node ordinals are invalid or disagree with transcript
   * order`, which reached the user as
   * `Cremation failed: prune apply rejected: adjacency-changed`.
   *
   * This case is the live failure reproduced on one turn pair. It asserts the
   * FIXED behaviour: the re-published node reads `1:1`, its own `(2, …)` pair
   * is not consulted, and the whole walk stays monotone.
   */
  it('keeps the SLOT ordinal on a replaced node, so the walk never walks backwards', () => {
    const { log, nodes } = replaceLog();
    const projected = surfaceTranscript(sessionOf(log, nodes), { sessionId: 'session-fold' });
    // The replaced node reads the slot's ordinal (1:1), not its own publish pair.
    assert.deepEqual(projected.items.map(item => item.turnOrdinal + ':' + item.stepOrdinal),
      ['1:1', '1:1', '2:2'],
      'a re-published slot keeps the ordinal of the place it took over');
    // The property the guard actually requires, asserted directly so a future
    // edit that "restores" the old order fails here by name.
    let previousTurn = -1;
    let previousStep = -1;
    for (const item of projected.items) {
      assert.ok(item.turnOrdinal >= previousTurn && item.stepOrdinal >= previousStep,
        'the walk never decreases: this is what checkTranscript refuses on');
      previousTurn = item.turnOrdinal;
      previousStep = item.stepOrdinal;
    }
    // A chain of replaces inherits transactionally to the position that started
    // it: the LAST publish carries the FIRST slot's ordinal, not its own.
    const chained: any[] = [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
      { type: 'system/message', seq: 2, surfaceOp: 'append',
        data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'v1' }] } } },
      { type: 'turn/start', seq: 3, data: { turn: 2 } },
      { type: 'step/start', seq: 4, data: { turn: 2, step: 1 } },
      { type: 'system/message', seq: 5, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
        data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'v2' }] } } },
      { type: 'turn/start', seq: 6, data: { turn: 3 } },
      { type: 'step/start', seq: 7, data: { turn: 3, step: 1 } },
      { type: 'system/message', seq: 8, surfaceOp: { op: 'replace', startSeq: 5, endSeq: 5 },
        data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: 'v3' }] } } },
    ];
    const chainProjected = surfaceTranscript(sessionOf(chained, [8]), { sessionId: 'session-fold' });
    assert.equal(chainProjected.items.length, 1);
    assert.equal(decoder.decode(chainProjected.items[0]!.bytes), 'v3');
    assert.equal(chainProjected.items[0]!.turnOrdinal, 1,
      'the chain keeps the ordinal of the slot it started from, whatever re-published it');
  });

  /**
   * The other half of the regression: CORE is what refuses the old order, and
   * this drives its public validation rather than trusting the fold.
   *
   * A snapshot whose walk decreases is rejected with `adjacency-changed`,
   * which is the verdict that reached the user as
   * `Cremation failed: prune apply rejected: adjacency-changed`. Asserting it
   * here keeps the two sides agreeing: if core ever relaxed that rule, the case
   * above would stop being the guarantee its comment claims.
   */
  it('core refuses a transcript whose walk decreases, which is why the slot wins', async () => {
    const { log, nodes } = replaceLog();
    const projected = surfaceTranscript(sessionOf(log, nodes), { sessionId: 'session-fold' });
    const envelopes = toCoreTranscript(projected.items);
    /** Core's own verdict on one node list, with an empty plan set. */
    const verdict = async (nodesInOrder: readonly EnvelopeNode[]): Promise<string[]> => {
      // The Guard requires a ledger and a breaker seed; neither is touched by
      // transcript validation, which runs before any plan is considered.
      const guard = new Guard({ ledger: undefined as never,
        initialState: { consecutiveValidationFailures: 0, disabled: false } });
      const result = await guard.validate({
        nowMs: 1_700_000_000_000,
        snapshot: {
          sessionId: 'session-fold',
          nodes: nodesInOrder,
          revision: '0:1',
          currentTurnOrdinal: projected.currentTurnOrdinal,
          currentStepOrdinal: projected.currentStepOrdinal,
          completedThroughTurnOrdinal: projected.completedThroughTurnOrdinal,
          cache: { kind: 'unknown' },
          retentionEvidence: [],
        },
        plans: [],
        sealedEpisodeIds: [],
        input: { kind: 'at-rest', eventId: 'test:at-rest', reason: 'step' },
        capabilities: { mutateResult: false, rewriteHistory: true, atRest: true,
          liveTokens: true, log: true, appendRecords: true, rehydrateOnResume: false },
        config: DEFAULT_CONFIG,
      }) as { issues?: readonly { code: string }[] };
      return [...new Set((result.issues ?? []).map(issue => issue.code))];
    };
    // The fixed order: what the fold now produces passes core.
    assert.deepEqual(await verdict(envelopes.map(envelope => envelope.node)), [],
      "the fixed fold passes core transcript validation");
    // The OLD order: stamp the replaced node with its own publish pair again.
    const regressed = envelopes.map(envelope => ({ ...envelope.node })) as EnvelopeNode[];
    regressed[0] = { ...regressed[0]!, turnOrdinal: projected.currentTurnOrdinal,
      stepOrdinal: projected.currentStepOrdinal };
    assert.deepEqual(await verdict(regressed), ['adjacency-changed'],
      'core refuses exactly this shape: the reason the slot ordinal must win');
  });
});

describe('the carry', () => {
  it('answers exactly what a cold fold answers', () => {
    const { log, nodes } = makeLog(4);
    const cold = summarize(surfaceTranscript(sessionOf(log, nodes), { sessionId: 'session-fold' }));
    const carry = createSurfaceCarry();
    // Fold progressively, the way boundaries do: one turn at a time.
    for (let turn = 1; turn <= 4; turn += 1) {
      const prefixLog = log.slice(0, 7 * turn);
      const prefixNodes = nodes.filter(seq => seq < prefixLog.length);
      surfaceTranscript(sessionOf(prefixLog, prefixNodes), { sessionId: 'session-fold', carry });
    }
    const warm = summarize(surfaceTranscript(sessionOf(log, nodes),
      { sessionId: 'session-fold', carry }));
    assert.deepEqual(warm, cold);
  });

  it('re-reads only the tail: a grown log keeps the items it already folded', () => {
    const { log, nodes } = makeLog(2);
    const carry = createSurfaceCarry();
    const first = surfaceTranscript(sessionOf(log, nodes), { sessionId: 'session-fold', carry });
    const grownLog = [...log,
      { type: 'step/start', seq: log.length, data: { turn: 3, step: 1 } },
      { type: 'tool/result', seq: log.length + 1, surfaceOp: 'append',
        data: { message: { source: { callId: 'call-3' },
          content: [{ type: 'text', text: 'result 3' }] } } }];
    const grownNodes = [...nodes, log.length + 1];
    const second = surfaceTranscript(sessionOf(grownLog, grownNodes),
      { sessionId: 'session-fold', carry });
    assert.equal(second.items.length, first.items.length + 1);
    for (let index = 0; index < first.items.length; index += 1) {
      assert.equal(second.items[index], first.items[index],
        'an unchanged surface item must be reused, not rebuilt');
    }
    assert.equal(decoder.decode(second.items.at(-1)!.bytes), 'result 3');
  });

  it('re-derives a position a REPLACE took over, and nothing else', () => {
    const { log, nodes } = makeLog(2);
    const carry = createSurfaceCarry();
    const first = surfaceTranscript(sessionOf(log, nodes), { sessionId: 'session-fold', carry });
    const replaced = [...log,
      { type: 'system/message', seq: log.length,
        surfaceOp: { op: 'replace', startSeq: nodes[0]!, endSeq: nodes[0]! },
        data: { turn: 3, step: 1,
          message: { content: [{ type: 'text', text: 'SYS rewritten' }] } } }];
    const replacedNodes = [log.length, ...nodes.slice(1)];
    const second = surfaceTranscript(sessionOf(replaced, replacedNodes),
      { sessionId: 'session-fold', carry });
    assert.equal(decoder.decode(second.items[0]!.bytes), 'SYS rewritten');
    assert.notEqual(second.items[0], first.items[0],
      'the replaced position is rebuilt from its new event');
    for (let index = 1; index < second.items.length; index += 1) {
      assert.equal(second.items[index], first.items[index]);
    }
  });

  it('ignores the carry for a beforeSeq cut, which is a different projection', () => {
    const { log, nodes } = makeLog(3);
    const carry = createSurfaceCarry();
    const full = surfaceTranscript(sessionOf(log, nodes), { sessionId: 'session-fold', carry });
    const cut = surfaceTranscript(sessionOf(log, nodes),
      { sessionId: 'session-fold', beforeSeq: full.seqs[3]!, carry });
    assert.equal(cut.items.length, 3);
    assert.deepEqual(cut.seqs, full.seqs.slice(0, 3));
  });

  it('starts over when the log shrank', () => {
    const { log, nodes } = makeLog(3);
    const carry = createSurfaceCarry();
    surfaceTranscript(sessionOf(log, nodes), { sessionId: 'session-fold', carry });
    const { log: smallLog, nodes: smallNodes } = makeLog(1);
    const projected = surfaceTranscript(sessionOf(smallLog, smallNodes),
      { sessionId: 'session-fold', carry });
    assert.deepEqual(summarize(projected),
      summarize(surfaceTranscript(sessionOf(smallLog, smallNodes), { sessionId: 'session-fold' })));
  });
});
