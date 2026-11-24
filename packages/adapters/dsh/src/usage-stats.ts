/**
 * What the mount has SPENT and FREED, read back from its own journal.
 *
 * The journal already records both halves: `prune-ask` carries the host's
 * `usage` reading for every table send (ISSUE-178), and `prune-apply` carries
 * the bytes a settled pass removed. Neither had a reader, so the one question an
 * operator actually has — "is this plugin worth its cost?" — could only be
 * answered by opening SQLite.
 *
 * The arithmetic is deliberately conservative:
 *
 *   - an ask whose `usage` is absent claimed NOTHING, so it counts as one ask
 *     and zero tokens. The journal's own contract says an absent `usage` is
 *     "never a zero reading", which is the distinction that matters here: an
 *     unknown cost must not be read as a free call.
 *   - a pass that planned removals but did not apply them freed NOTHING, so only
 *     `status: 'applied'` contributes bytes.
 *   - the net is reported BOTH ways. `netTokens` asks what the pass freed in
 *     the unit it was paid in (a rough bytes/4 estimate); `removedBytes` is the
 *     raw fact. Neither is a promise about cache pricing, which the mount cannot
 *     see.
 */

/** One `prune-ask` record's cost, as the host stated it. */
export interface AskCost {
  /** The pass round the ask belonged to. */
  readonly round: number | null;
  /** Tables the ask covered. */
  readonly tables: number;
  /** Input tokens the host billed, or null when it stated no usage. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/** One `prune-apply` record's outcome. */
export interface ApplyOutcome {
  readonly round: number | null;
  readonly status: string;
  readonly removals: number;
  readonly removedBytes: number;
}

/** Everything one journal contributes to the totals. */
export interface UsageTotals {
  /** How many `prune-ask` records were seen. */
  readonly asks: number;
  /** How many of those carried a usable usage reading. */
  readonly asksWithUsage: number;
  /** Summed input tokens over the asks that stated one. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** `prune-apply` records, all statuses. */
  readonly passes: number;
  /** Passes that actually applied. */
  readonly appliedPasses: number;
  /** Summed removed bytes over the applied passes. */
  readonly removedBytes: number;
  /** Summed planned removals over the applied passes. */
  readonly removals: number;
}

/** The two totals a single journal file adds up to, plus the per-record detail. */
export interface UsageReport extends UsageTotals {
  /** The asks, oldest first, so a caller can chart or list them. */
  readonly askCosts: readonly AskCost[];
  /** The applies, oldest first. */
  readonly applyOutcomes: readonly ApplyOutcome[];
  /**
   * Removed bytes minus the tokens spent, both expressed in tokens (bytes/4).
   * Negative means the passes cost more context than they freed. Null when no
   * ask stated a usage reading, because a net over unknown costs is a guess.
   */
  readonly netTokens: number | null;
}

/** Empty totals, the answer for a journal with no passes in it. */
function emptyTotals(): UsageTotals {
  return { asks: 0, asksWithUsage: 0, inputTokens: 0, outputTokens: 0,
    passes: 0, appliedPasses: 0, removedBytes: 0, removals: 0 };
}

function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function tokensIn(usage: unknown): { input: number | null; output: number | null } {
  if (usage === null || typeof usage !== 'object') return { input: null, output: null };
  const record = usage as Record<string, unknown>;
  // The host states input as the sum of its three buckets, exactly as the entry
  // lane reads it (`readAssistantUsage`): a completion-only count is not the
  // prompt the pass paid for.
  const input = record['input'];
  if (input !== null && typeof input === 'object') {
    const buckets = input as Record<string, unknown>;
    const parts = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens']
      .map(key => countOf(buckets[key]) ?? 0);
    const total = parts.reduce((sum, value) => sum + value, 0);
    return { input: total, output: countOf(record['outputTokens']) };
  }
  return { input: countOf(input), output: countOf(record['outputTokens']) };
}

/**
 * Fold one journal's records into a report.
 *
 * Only the two kinds it reads are touched; every other record is skipped
 * without interpretation, so a journal written by a different version still
 * yields the right answer for the rows both versions share.
 */
export function summarizeUsage(records: readonly Record<string, unknown>[]): UsageReport {
  let totals = emptyTotals();
  const askCosts: AskCost[] = [];
  const applyOutcomes: ApplyOutcome[] = [];
  for (const record of records) {
    const kind = record['kind'];
    if (kind === 'prune-ask') {
      const tokens = tokensIn(record['usage']);
      const cost: AskCost = { round: countOf(record['round']), tables: countOf(record['tables']) ?? 0,
        inputTokens: tokens.input, outputTokens: tokens.output };
      askCosts.push(cost);
      totals = { ...totals, asks: totals.asks + 1,
        asksWithUsage: totals.asksWithUsage + (tokens.input === null ? 0 : 1),
        inputTokens: totals.inputTokens + (tokens.input ?? 0),
        outputTokens: totals.outputTokens + (tokens.output ?? 0) };
      continue;
    }
    if (kind === 'prune-apply') {
      const status = typeof record['status'] === 'string' ? record['status'] : 'unknown';
      const applied = status === 'applied';
      const outcome: ApplyOutcome = { round: countOf(record['round']), status,
        removals: countOf(record['removals']) ?? 0,
        // A pass that did not apply freed nothing, whatever it planned.
        removedBytes: applied ? countOf(record['removedBytes']) ?? 0 : 0 };
      applyOutcomes.push(outcome);
      totals = { ...totals, passes: totals.passes + 1,
        appliedPasses: totals.appliedPasses + (applied ? 1 : 0),
        removedBytes: totals.removedBytes + outcome.removedBytes,
        removals: totals.removals + (applied ? outcome.removals : 0) };
    }
  }
  // bytes/4 is the same rough ratio core's char heuristic uses; it is stated as
  // an estimate in the card, never as a measurement.
  const netTokens = totals.asksWithUsage === 0 ? null
    : Math.round(totals.removedBytes / 4) - totals.inputTokens - totals.outputTokens;
  return { ...totals, askCosts, applyOutcomes, netTokens };
}

/** The card text one report renders to. */
export function formatUsageReport(report: UsageReport): string {
  const lines: string[] = [];
  lines.push(`Cremator spent ${String(report.asks)} ask${report.asks === 1 ? '' : 's'} and freed ${String(report.removedBytes)} bytes.`);
  if (report.asksWithUsage === 0) {
    lines.push('No ask reported a usage reading, so the token cost is unknown.');
  } else {
    lines.push(`Tokens billed: ${String(report.inputTokens)} in, ${String(report.outputTokens)} out.`);
  }
  lines.push(`Passes: ${String(report.passes)} (${String(report.appliedPasses)} applied, ${String(report.removals)} removals).`);
  lines.push(report.netTokens === null
    ? 'Net: unknown (no usage reading).'
    : `Net: ${report.netTokens >= 0 ? '+' : ''}${String(report.netTokens)} tokens (freed bytes / 4 minus tokens billed).`);
  return lines.join('\n');
}
