// Ad-hoc verification: replay the two real dsh sessions that failed with
// `adjacency-changed` through the fixed surface fold, and re-run core's own
// transcript check on the result. Kept under dev/ because it reads a developer's
// ~/.dsh session store; it is not part of the shipped package or its suite.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const DIST = new URL('../packages/adapters/dsh/dist/', import.meta.url).href;
const CORE_DIST = new URL('../packages/core/dist/', import.meta.url).href;
const plug = await import(DIST + 'plugin.js');
const env = await import(DIST + 'envelope.js');
const checks = await import(CORE_DIST + 'guard/checks-sources.js');

const BASE = join(homedir(), '.dsh', 'sessions',
  '--C-Users-24210-Documents-deepseek-harness-default-workspace--');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function loadLog(id) {
  const buf = readFileSync(join(BASE, id, 'session.v4.jsonl.zstd'));
  const frames = [];
  for (let at = 0; ;) {
    const found = buf.indexOf(MAGIC, at);
    if (found < 0) break;
    frames.push(found);
    at = found + 4;
  }
  const parts = [];
  for (let index = 0; index < frames.length; index += 1) {
    const slice = buf.subarray(frames[index], index + 1 < frames.length ? frames[index + 1] : buf.length);
    try { parts.push(zstdDecompressSync(slice).toString('utf8')); } catch { /* partial frame */ }
  }
  return parts.join('').split('\n').filter(Boolean).slice(1)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(record => record !== null);
}

for (const id of [
  'session-9e9d497d-c75d-4a93-afc2-6bf526a95100',
  'session-c0630605-7b0d-45ad-8d3f-9cd769339042',
]) {
  const log = loadLog(id);
  const nodes = [];
  for (const event of log) {
    if (event.surfaceOp === 'append') { nodes.push(event.seq); continue; }
    if (event.surfaceOp && event.surfaceOp.op === 'replace') {
      const at = nodes.indexOf(event.surfaceOp.startSeq);
      if (at >= 0) nodes.splice(at, 1, event.seq);
      else nodes.push(event.seq);
    }
  }
  const projected = plug.surfaceTranscript(
    { id, seq: log.length, surface: { nodes }, eventAt: seq => log[seq] }, { sessionId: id });
  let previousTurn = -1;
  let previousStep = -1;
  let broke = null;
  for (const item of projected.items) {
    if (item.turnOrdinal < previousTurn || item.stepOrdinal < previousStep) {
      broke = { seq: item.id.split(':').pop(), turn: item.turnOrdinal,
        step: item.stepOrdinal, previous: [previousTurn, previousStep] };
      break;
    }
    previousTurn = item.turnOrdinal;
    previousStep = item.stepOrdinal;
  }
  const envelopes = env.toCoreTranscript(projected.items);
  const issues = [];
  const context = {
    value: {
      snapshot: { sessionId: id, nodes: envelopes.map(envelope => envelope.node),
        currentTurnOrdinal: projected.currentTurnOrdinal,
        currentStepOrdinal: projected.currentStepOrdinal,
        completedThroughTurnOrdinal: projected.completedThroughTurnOrdinal,
        cache: { kind: 'unknown' }, retentionEvidence: [] },
      input: { kind: 'at-rest' }, plans: [],
    },
    nodes: new Map(), episodes: new Map(), freshStart: 0, issues,
  };
  context.nodes = new Map(context.value.snapshot.nodes.map(node => [node.id, node]));
  checks.checkTranscript(context);
  console.log('===', id);
  console.log('  events', log.length, '| surface nodes', nodes.length, '| items', projected.items.length);
  console.log('  ordinals monotone:', broke === null ? 'YES' : 'NO ' + JSON.stringify(broke));
  console.log('  core checkTranscript:',
    issues.length === 0 ? 'CLEAN' : JSON.stringify([...new Set(issues.map(issue => issue.code))]));
}
