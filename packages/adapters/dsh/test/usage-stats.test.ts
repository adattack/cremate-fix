/**
 * `/cremate stats`: what the journal already recorded, totalled.
 *
 * The two accounting kinds exist for exactly this reading (`prune-ask` carries
 * the host's usage for every table send, `prune-apply` the bytes a settled pass
 * freed), and nothing read them back. The cases below pin the three rules that
 * make the totals honest: an ask with no usage is an unknown cost, not a free
 * one; a pass that did not apply freed nothing; and the net is never stated
 * when the cost is unknown.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatUsageReport, summarizeUsage } from '../src/usage-stats.js';

describe('the cost of an ask', () => {
  it('sums the three input buckets the host states', () => {
    const report = summarizeUsage([
      { kind: 'prune-ask', round: 1, tables: 1,
        usage: { input: { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 10 }, outputTokens: 40 } },
    ]);
    assert.equal(report.asks, 1);
    assert.equal(report.asksWithUsage, 1);
    assert.equal(report.inputTokens, 1010, 'input + cacheRead + cacheWrite');
    assert.equal(report.outputTokens, 40);
  });

  it('reads a flat input count too, the other shape the host may state', () => {
    const report = summarizeUsage([
      { kind: 'prune-ask', round: 1, tables: 1, usage: { input: 500, outputTokens: 20 } },
    ]);
    assert.equal(report.inputTokens, 500);
  });

  it('counts an ask with no usage as one ask and zero tokens, never as free', () => {
    const report = summarizeUsage([{ kind: 'prune-ask', round: 1, tables: 2 }]);
    assert.equal(report.asks, 1);
    assert.equal(report.asksWithUsage, 0, 'the ask is not claimed as measured');
    assert.equal(report.inputTokens, 0);
    assert.equal(report.netTokens, null, 'a net over unknown costs is never stated');
  });

  it('totals several asks', () => {
    const report = summarizeUsage([
      { kind: 'prune-ask', round: 1, tables: 1, usage: { input: 100, outputTokens: 10 } },
      { kind: 'prune-ask', round: 2, tables: 2, usage: { input: { inputTokens: 200 }, outputTokens: 20 } },
    ]);
    assert.equal(report.asks, 2);
    assert.equal(report.inputTokens, 300);
    assert.equal(report.outputTokens, 30);
    assert.deepEqual(report.askCosts.map(cost => cost.round), [1, 2]);
  });
});

describe('the bytes a pass freed', () => {
  it('counts bytes only for a pass that APPLIED', () => {
    const report = summarizeUsage([
      { kind: 'prune-apply', round: 1, status: 'applied', removals: 3, removedBytes: 4000 },
      // Planned removals the engine refused freed nothing.
      { kind: 'prune-apply', round: 2, status: 'rejected', removals: 5, removedBytes: 9000 },
      { kind: 'prune-apply', round: 3, status: 'unchanged', removals: 0 },
    ]);
    assert.equal(report.passes, 3);
    assert.equal(report.appliedPasses, 1);
    assert.equal(report.removedBytes, 4000, 'a refused pass frees nothing');
    assert.equal(report.removals, 3, 'removals count only where the pass applied');
  });

  it('reads the applied outcome per pass, oldest first', () => {
    const report = summarizeUsage([
      { kind: 'prune-apply', round: 1, status: 'applied', removals: 2, removedBytes: 100 },
      { kind: 'prune-apply', round: 2, status: 'rejected', removals: 1, removedBytes: 50 },
    ]);
    assert.deepEqual(report.applyOutcomes, [
      { round: 1, status: 'applied', removals: 2, removedBytes: 100 },
      { round: 2, status: 'rejected', removals: 1, removedBytes: 0 },
    ]);
  });
});

describe('the net', () => {
  it('is freed bytes over four, minus the tokens billed', () => {
    const report = summarizeUsage([
      { kind: 'prune-ask', usage: { input: 1000, outputTokens: 100 } },
      { kind: 'prune-apply', status: 'applied', removals: 1, removedBytes: 8000 },
    ]);
    // 8000 bytes / 4 = 2000 tokens freed, minus 1100 billed.
    assert.equal(report.netTokens, 900);
  });

  it('goes negative when the passes cost more than they freed', () => {
    const report = summarizeUsage([
      { kind: 'prune-ask', usage: { input: 50_000, outputTokens: 100 } },
      { kind: 'prune-apply', status: 'applied', removals: 1, removedBytes: 400 },
    ]);
    assert.equal(report.netTokens, -50_000);
    assert.match(formatUsageReport(report), /Net: -50000 tokens/u);
  });

  it('ignores records of any other kind', () => {
    const report = summarizeUsage([
      { kind: 'prune-plan', units: 4 },
      { kind: 'at-rest', status: 'unchanged' },
      { kind: 'prune-ask', usage: { input: 10 } },
    ]);
    assert.equal(report.asks, 1);
    assert.equal(report.passes, 0);
  });
});

describe('the card', () => {
  it('states the cost, the passes and the net in one readable block', () => {
    const report = summarizeUsage([
      { kind: 'prune-ask', round: 1, tables: 1, usage: { input: 1000, outputTokens: 100 } },
      { kind: 'prune-apply', round: 1, status: 'applied', removals: 2, removedBytes: 8000 },
    ]);
    const text = formatUsageReport(report);
    assert.match(text, /spent 1 ask/u);
    assert.match(text, /freed 8000 bytes/u);
    assert.match(text, /Tokens billed: 1000 in, 100 out/u);
    assert.ok(text.includes('Passes: 1 (1 applied, 2 removals).'),
      'the pass line states applied passes and planned removals separately');
    assert.ok(text.includes('Net: +900 tokens'), 'a positive net is signed');
  });

  it('says the cost is unknown rather than printing a net', () => {
    const report = summarizeUsage([{ kind: 'prune-ask' }]);
    const text = formatUsageReport(report);
    assert.ok(text.includes('No ask reported a usage reading, so the token cost is unknown.'),
      'an unmeasured cost is named, never printed as zero');
    assert.match(text, /Net: unknown \(no usage reading\)\./u);
  });

  it('reads cleanly on an empty journal', () => {
    const text = formatUsageReport(summarizeUsage([]));
    assert.match(text, /spent 0 asks and freed 0 bytes/u);
    assert.match(text, /Net: unknown/u);
  });
});
