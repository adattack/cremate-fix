/**
 * The host seam this adapter reads, checked before it is trusted.
 *
 * `peerDependencies` states the range the adapter was tested against, but a
 * range is a claim about INSTALLS, not about what the object handed to
 * `apply` actually looks like. dsh is pre-1.0 and its session shape moved
 * under this adapter once already (ISSUE-064: a surface REPLACE re-publishes a
 * node at a later seq), and the failure that produced was invisible at load
 * time: the mount started fine and then, minutes later, every apply was
 * refused with `adjacency-changed` — a shape mismatch reported as a plan
 * defect.
 *
 * So the shape is probed. A host that answers the probe is trusted for the
 * fields it answered; a host that does not is REFUSED AT MOUNT with a message
 * naming the field and the reason, because a mount that cannot read the
 * transcript is worse than no mount: it silently stops removing anything and
 * the only symptom is a growing context.
 *
 * Deliberately shape-based, not version-based. A version check would refuse a
 * host that kept the shape and accept one that broke it; the fields below are
 * the actual contract `surfaceTranscript` depends on.
 */

/** One reason the host cannot be read, or `null` when it can. */
export interface HostCompatProblem {
  /** The field that failed, spelled the way the mount reads it. */
  readonly field: string;
  /** What the mount requires, in one sentence. */
  readonly expected: string;
  /** What the host actually answered. */
  readonly actual: string;
}

/** The refusal a failed probe produces. Named so a caller can branch on it. */
export class DshHostIncompatibleError extends Error {
  readonly problems: readonly HostCompatProblem[];
  constructor(problems: readonly HostCompatProblem[]) {
    super('cremator: this dsh host cannot be read by the adapter; refusing to mount.\n'
      + problems.map(problem => `  - ${problem.field}: expected ${problem.expected} (found ${problem.actual})`).join('\n')
      + '\nThe adapter reads the session transcript through these fields. '
      + 'See the cremator-dsh README for the tested host range.');
    this.name = 'DshHostIncompatibleError';
    this.problems = problems;
  }
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * The field the surface fold needs on a session, checked on ONE live session.
 *
 * `seq` is read as a number (absent counts as zero: an empty session reads no
 * events and plans nothing, which is legal), `eventAt` must be a function, and
 * `surface.nodes` must be an array when `surface` is present at all — a
 * `surface` object with a non-array `nodes` is the shape that would make the
 * fold silently produce an empty transcript.
 *
 * `surfaceOp` is checked on the events it returns, not on the session object,
 * because that is where it lives. The check is deliberately about SHAPE only:
 * `append` and `{op:'replace', startSeq}` are the two spellings the fold
 * understands, and `undefined`/absent means the event is not on the surface.
 * A new spelling is refused by name rather than folded wrongly, which is how
 * this adapter failed the first time.
 */
export function probeSession(session: unknown): HostCompatProblem[] {
  const problems: HostCompatProblem[] = [];
  if (session === null || typeof session !== 'object') {
    return [{ field: 'session', expected: 'a dsh session object', actual: describe(session) }];
  }
  const record = session as Record<string, unknown>;
  if (typeof record['id'] !== 'string' || record['id'].length === 0) {
    problems.push({ field: 'session.id', expected: 'a non-empty string', actual: describe(record['id']) });
  }
  if (typeof record['eventAt'] !== 'function') {
    problems.push({ field: 'session.eventAt', expected: 'a function over a log position',
      actual: describe(record['eventAt']) });
  }
  if (record['append'] !== undefined && typeof record['append'] !== 'function') {
    problems.push({ field: 'session.append', expected: 'a function when declared',
      actual: describe(record['append']) });
  }
  if (record['seq'] !== undefined && (typeof record['seq'] !== 'number' || !Number.isSafeInteger(record['seq']))) {
    problems.push({ field: 'session.seq', expected: 'a non-negative safe integer when declared',
      actual: describe(record['seq']) });
  }
  const surface = record['surface'];
  if (surface !== undefined && surface !== null) {
    if (typeof surface !== 'object') {
      problems.push({ field: 'session.surface', expected: 'an object when declared', actual: describe(surface) });
    } else {
      const nodes = (surface as Record<string, unknown>)['nodes'];
      if (nodes !== undefined && !Array.isArray(nodes)) {
        problems.push({ field: 'session.surface.nodes', expected: 'an array of log positions when declared',
          actual: describe(nodes) });
      }
    }
  }
  // The events themselves: one read through the seam the fold uses. An absent
  // log position answers `undefined` legally, so only a THROW here is a problem.
  const eventAt = record['eventAt'];
  if (typeof eventAt === 'function') {
    try {
      const first = (eventAt as (seq: number) => unknown).call(session, 0);
      if (first !== undefined) {
        const eventProblem = probeEvent(first);
        if (eventProblem !== null) problems.push(eventProblem);
      }
    } catch (error) {
      problems.push({ field: 'session.eventAt(0)', expected: 'a readable log position or undefined',
        actual: `it threw: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return problems;
}

/**
 * The shape of ONE event the fold reads: `type`, a numeric `seq`, and a
 * `surfaceOp` in one of the two spellings the fold understands.
 */
export function probeEvent(event: unknown): HostCompatProblem | null {
  if (event === null || typeof event !== 'object') {
    return { field: 'session.eventAt(seq)', expected: 'an event object', actual: describe(event) };
  }
  const record = event as Record<string, unknown>;
  if (typeof record['type'] !== 'string' || record['type'].length === 0) {
    return { field: 'event.type', expected: 'a non-empty string', actual: describe(record['type']) };
  }
  if (typeof record['seq'] !== 'number' || !Number.isSafeInteger(record['seq'])) {
    return { field: 'event.seq', expected: 'a non-negative safe integer', actual: describe(record['seq']) };
  }
  return probeSurfaceOp(record['surfaceOp']);
}

/**
 * The two `surfaceOp` spellings the fold understands, and nothing else.
 *
 * `undefined`/`null` is "this event is not on the surface", `'append'` is a
 * publish, and `{op:'replace', startSeq, endSeq}` takes over an existing slot.
 * Anything else is a host change the fold would mis-read, so it is refused
 * here — at the boundary — instead of surfacing later as a guard verdict about
 * the plan.
 */
export function probeSurfaceOp(op: unknown): HostCompatProblem | null {
  if (op === undefined || op === null || op === 'append') return null;
  if (typeof op !== 'object' || Array.isArray(op)) {
    return { field: 'event.surfaceOp', expected: '\'append\', {op:\'replace\', …} or nothing',
      actual: describe(op) };
  }
  const record = op as Record<string, unknown>;
  if (record['op'] !== 'replace') {
    return { field: 'event.surfaceOp.op', expected: '\'replace\'',
      actual: typeof record['op'] === 'string' ? `'${record['op']}'` : describe(record['op']) };
  }
  for (const key of ['startSeq', 'endSeq'] as const) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      return { field: `event.surfaceOp.${key}`, expected: 'a non-negative safe integer',
        actual: describe(value) };
    }
  }
  return null;
}

/**
 * Every live session the host already knows about, probed. `apply` runs this
 * before the first boundary, so an incompatible host is refused at mount
 * instead of at the first pass.
 *
 * A host that exposes no session list is not refused: the probe then happens
 * at each boundary, which is the same check one step later.
 */
export function probeHost(sessions: readonly unknown[]): HostCompatProblem[] {
  const problems: HostCompatProblem[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    for (const problem of probeSession(session)) {
      // One report per field: ten sessions with the same missing seam is one
      // fact, not ten.
      if (seen.has(problem.field)) continue;
      seen.add(problem.field);
      problems.push(problem);
    }
  }
  return problems;
}
