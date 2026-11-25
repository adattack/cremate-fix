# CREMATOR · 记忆焚化工

Compaction Reinvented, Erase Meaningless Agent Token Overhead Reversibly.

> **This repository is a fork.** It is not the upstream project.
>
> - Original project: **[zman406986/Agent-Memory-CREMATOR](https://github.com/zman406986/Agent-Memory-CREMATOR)**
> - This fork: [adattack/cremate-fix](https://github.com/adattack/cremate-fix)
>
> It carries the upstream source at v0.1.2 plus a set of fixes and additions
> (listed under [Changes in this fork](#changes-in-this-fork) below). The
> upstream packages on npm are unmodified: installing `cremator-dsh` from npm
> gets the upstream release, not this fork. Everything below the changelog is
> the upstream documentation, kept as it was.

Early stage. The packages are on npm. Install the adapter you use. The `examples/core-offline/` example runs end to end without dsh. The core and the dsh adapter have
been run against real dsh. The OpenCode adapter passes functional tests against a fake host only;
its live-run evidence is withdrawn (see [its README](packages/adapters/opencode/README.md)). This
library does not establish any effect on answer quality.

CREMATOR is a TypeScript library for coding agents. It removes tool output that is provably dead, or
that the agent marks as forgotten, soon after it lands. It works by subtraction: it removes what is
dead or marked forgotten and leaves a short record — a negative fact for a failed search — rather
than rewriting history into summaries.

[English](README.md) · [中文](README.zh-CN.md)

## Changes in this fork

Against upstream v0.1.2 (`c8f1136`). Each item names what was wrong and how it
is verified; nothing outside this list was changed.

**Fixes**

- **A re-published slot keeps the ordinal of the place it occupies.**
  dsh re-publishes the system prompt every turn via
  `surfaceOp: {op:'replace', …}`, and that event carries its own
  `(turn, step)` while it still sits in the transcript's first slot. The fold
  read the event's own pair first, so the walk went backwards (`2:2` then
  `1:1`) and core refused every plan built on that snapshot with
  `adjacency-changed` — surfacing as `Cremation failed: prune apply rejected:
  adjacency-changed`. Now the slot decides and the event's own pair is the
  fallback. Verified against two real failing sessions (3,617 and 7,870
  events): ordinal walk monotone, core transcript check clean.
- **The ledger file stands alone after `close()`.**
  `SqliteLedger.close()` now runs `PRAGMA wal_checkpoint(TRUNCATE)` before
  `db.close()` (and `VACUUM` after). Without it the main file is a 4 KiB shell
  whose schema and rows live in `-wal`, so a backup that copies
  `ledger.sqlite` alone reads "no such table" and every recall id silently
  fails. A checkpoint failure never fails the close. `checkpoint()` is public,
  for a caller about to export or copy.
- **The dependency floor matches the build.**
  `cremator-dsh@0.1.2` imported `isTwoVerdictGrammar` from `@cremator/core`
  while declaring `"^0.1.0"`; a fresh install resolved 0.1.1, which has no such
  export, and the plugin died at ESM link time on load. The floor is now
  `^0.1.2`, and a startup test builds both packages and imports them through
  their published entry points so this cannot ship again.
- **The host is probed, not assumed.** `peerDependencies` says
  `>=0.2.1-rc.2 <0.3.0` instead of the open `>=0.0.0-0`, and `apply()` /
  each step boundary check the `session` and `surfaceOp` shapes, refusing to
  mount with an error naming the field. A shape mismatch used to stay invisible
  until a pass failed with a verdict about the plan.

**Configuration**

- The shipped bundle no longer pins `contextWindowTokens: 400000`. The depth
  trigger's skip line is 75% of that number, so a fixed value is wrong for
  every routed model but the one it was measured on — 400,000 on a 1M-token
  model retires the trigger at 300,000 and leaves 700,000 unused. Left unset,
  the mount resolves the routed model's own window through the host's
  `llm.resolveModelInfo` seam.

**Performance**

- `surfaceTranscript` folds only the log tail. It carries `ordinalAt`,
  `stepAt`, the call facts, the running ordinals and the finished item per
  surface position, so a boundary re-reads only new log positions and reuses
  the items it already built. On a 9,600-event / 4,000-node session: 3.35 ms
  cold → 0.54 ms for a one-result tail (6.2x). A `beforeSeq` cut bypasses the
  carry; a log that shrank restarts the walk.
- `port.setTranscript` adopts the projection instead of deep-cloning all of it
  (4.98 ms → 0.001 ms at 1,707 items).
- One redundant `syncPass` per step boundary was dropped.

**New operator lanes**

- `/cremate gc` — keep the `gcRetainSessions` most recently active sessions and
  remove the rest. A session a live mount holds is always kept. Storage
  otherwise never expires: archived bytes live until the directory is deleted.
- `/cremate export <sessionId>` — write that session's archive
  (core's own `LedgerArchive.bytes`, the same bytes `hydrate` reads) to
  `<crematorStorageRoot>/<sessionId>.archive.json`.
- `/cremate stats` — total what the journal already recorded: asks sent, tokens
  billed, bytes freed, and the net. An ask that reported no usage counts as an
  ask with an unknown cost, never a free one.

**Documentation**

- The shipped READMEs no longer carry development-machine paths or internal
  ticket numbers.

## Why

A coding agent's context fills with tool output that may no longer matter. The agent can use a
result without reading it again, so the host cannot tell from the transcript which results are
still needed. Many harnesses leave that material in place until the window is nearly full, then
shrink it: they ask the agent to summarize
its own context, or truncate the oldest messages without asking. Compaction is lossy and fires
mid-task, and the bytes it removes leave no recall id, so the agent must fetch the fact again.

CREMATOR favors removal over summarization. Deterministic proofs establish that some content is dead;
for the rest, the agent decides.

Terms used below: the **mount** is the adapter instantiated by the harness; a **fork** is a copy of
the conversation's wire state that the table ask appends to; the **token bar** is
`pruneThresholdTokens`; the **byte threshold** is `barBytes`; the **entry ask** is an older
per-result ask, off in the sample config.

## How it works

- **Only tool results are candidates.** No rule, verdict or ask can name user messages or the
  agent's own output as candidates, or list them in the ask table. That is a scope choice, not a
  safety guarantee. Outside a removal, the mount modifies only its own entry-ask turns; seal records
  are pure appends.
- **Deterministic proofs remove; the seal appends one negative fact for a failed search.** Bulk
  candidates use the byte threshold `barBytes` (512 bytes by default), the entry ask uses its own
  `floorBytes`, and a manual forget resolves to exactly one non-write result that hit the named
  path, whatever its size; more than one match is refused as ambiguous. Deterministic code never
  judges usefulness. It proves a stale read or a
  superseded re-read and removes the result outright, without asking. A closed failed-search
  episode is sealed: one negative-fact record is appended, nothing is removed; a later prune removes
  the sealed miss bodies whole and also removes byte-identical duplicates and exact re-reads. What
  no proof removes goes to the agent in a table, one row per result, and only the agent's
  keep-or-forget answer decides there.
- **Automatic duplicate removal never leaves a byte-identical class with no live copy.** Of a pair,
  only the kept copy reaches the table; the duplicate is removed automatically. If the agent forgets
  the kept copy, the survivor gate cancels that automatic removal (reason `survivor-removed`) and
  the forget itself applies. The gate covers whole-result prune removals, including a table
  `forgetall`, but its content-survival rule does not apply to closed-episode or call-echo removals
  (a call-echo result only restates its own call's arguments). Partial-line keeps, manual forgets
  and entry-ask answers are outside the gate; the guard validates their shape.
- **Each table ask appends two turns to a fork: the ask and its reply.** The token bar fires a pass
  when usage reaches `pruneThresholdTokens` and one of these holds: usage was below it since the
  last pass ended (applied, refused or failed), no pass has run yet, or usage has grown one token
  bar past the last pass's pre-pass baseline. A native host compaction clears the fired state, so
  the next observation at or above the bar fires. The mount sends the table ask over the fork,
  seeded from the latest request the main conversation dispatched. The main transcript and its
  cache are untouched by table asks; the entry ask appends its exchange to main and rewinds it after
  a keep-all or a forget. One request, one table: one row per result still undecided (a settled
  entry keep is not re-listed), with its path, total line count and a few line anchors. The mount
  keeps sending tables until every row is settled or the loop cannot continue: no text, a refused
  fork append, or a refused send. A stop still lets the pass apply its deterministic removals, and
  the unanswered rows are deferred. A refused row is re-asked once in the next table; rows still
  refused then get one correction turn. A row whose answer is outside the allowed forms is never
  re-asked. The table never repeats result bodies.
- **Application is rewind plus append, never an edit.** A forget rewinds the transcript to the
  forgotten units, keeps every node it does not name, and appends one receipt per forgotten result,
  each receipt described below. A prune keeplines partial keep re-emits the kept byte ranges before
  the receipt; the entry ask's shaped turn instead places one marker in each dropped gap. The ledger
  also banks the whole result body, so recall restores it. The guard approves the whole application;
  the adapter applies it. The plan is chosen before the first append: one
  whole-span replacement is tried first; when the span starts at a tool result and shadows more than
  one node, the fallback is one single-node replacement per forgotten node. Nothing inside a shared
  prefix is rewritten, so the prefix is unchanged and can still be served from cache.
- **Every content removal is reversible.** Removed bytes go to an append-only trash ledger under a
  recall id. With the durable ledger the mounts use, a recall restores them byte-exact after a
  restart, within the session that minted the id. A whole-result drop leaves one receipt line: the
  path, the dropped line ranges when there are any, a short label when the drop has one, and the
  recall id that `necromancy`, the restore tool, uses.

Two illustrative ask-table rows; below them, the receipt that `examples/core-offline/` prints. That
forget drops a whole result, so the receipt names no line ranges:

```text
1. [Read] src/needle.ts (call #1) — line 1 of 3 ends with "first line" · line 3 of 3 ends with "third line" [3 lines]
2. [Read] config.ts (call #1) — line 60 of 201 ends with "retries: 3" · line 140 of 201 ends with "exit 1" [201 lines]

[not retained] src/needle.ts — about: auth retry path · necromancy recall:sha256:…
```

## Harness requirements

CREMATOR needs four seams: result interception, history rewrite or programmatic revert, additive
tool registration, and an at-rest hook (a hook that runs between model calls). A harness missing any
of them is unsupported. There is no mode that leaves the transcript completely untouched; even
`record-only` needs all four seams. The adapter for dsh, the coding-agent harness this repo is
developed against, has an `enforcement: record-only` mode: it records the table ask's answers and
forget requests instead of applying them. The at-rest stale-read and superseded-read proofs, the
seal's negative-fact records, and (when the entry ask is enabled) its answers still apply.

## Install

Node `>=22.13.0 <23.0.0 || >=23.4.0`: `node:sqlite` is flagless from 22.13.0, and Node
23.0.0–23.3.x are excluded.

```sh
npm install cremator-dsh
# or
npm install cremator-opencode
```

`@cremator/core` installs automatically. For a source checkout, run `npm install`
and `npm run build` in the cloned repository.

The only example that runs today without dsh is
`examples/core-offline/`, which drives the core alone:

```sh
node --experimental-strip-types examples/core-offline/offline.ts
```

It prints, among other lines, `recalled 34 bytes byte-exact: true`.

Mount the adapter with a `dsh --patch` file containing one insert row that points at the built
entry:

```yaml
- insert:
    - id: cremator-mount
      name: 'file:///path/to/Agent-Memory-CREMATOR/packages/adapters/dsh/dist/plugin.js'
      config:
        barBytes: 512
        enforcement: apply
        contextWindowTokens: 400000
        pruneThresholdTokens: 60000
        entryAskTrigger: { mode: 'off' }
        nativeCompactionBackstop: true
```

Replace `path/to/Agent-Memory-CREMATOR` inside the `file:///` URL; keep the prefix (on Windows,
`file:///C:/...`). Every `config` key is optional (`pruneThresholdTokens` needs
`contextWindowTokens`; omit the bar and the deprecated half-window fallback runs; omit both and the
automatic trigger is disabled). The sample row sets the entry ask off; if you omit the key, the
code default runs the per-result cadence. The entry ask uses `floorBytes`; absent, a per-model table
decides, with 512 as the fallback.
`examples/dsh-mount/` shows the row shape. Mount details (config keys, storage layout, degradation
behavior) are in [packages/adapters/dsh/README.md](packages/adapters/dsh/README.md). The default
storage root is `<DSH_HOME>/storages/cremator` (`DSH_HOME` defaults to `~/.dsh`). For OpenCode, see
[packages/adapters/opencode/README.md](packages/adapters/opencode/README.md).

The dsh adapter also installs as a dsh bundle. Point the profile at the local package directory:

```sh
dsh plugin --profile <name> add link:<path to packages/adapters/dsh>
```

The host's Plugins page then lists CREMATOR, and the slash menu shows `/cremate`. A typed `/cremate`
message still triggers the same pass.

## Packages

| Package | What it carries |
| --- | --- |
| [`@cremator/core`](packages/core/README.md) | Meter, episodes, rules, prune families, guard, ledger, revert planner, engine; the core never imports harness code. |
| [`cremator-dsh`](packages/adapters/dsh/README.md) | dsh adapter: seam mapping, the mount entry, the `forget` and `necromancy` tools (`necromancy` restores forgotten bytes by recall id). |
| [`cremator-opencode`](packages/adapters/opencode/README.md) | OpenCode adapter: a thin seam mapping over OpenCode 2.4.0's context hooks and menu parts; functional tests only, live evidence withdrawn. |

Install with `npm install cremator-dsh` or `npm install cremator-opencode`;
`@cremator/core` installs as a dependency.

## Publishing

Publish in dependency order: `@cremator/core@0.1.2` first, then `cremator-dsh@0.1.2` and
`cremator-opencode@0.1.2`. Both adapters declare `"@cremator/core": "^0.1.2"`, so the core release
must exist on the registry before either adapter tarball can install.

## License

Apache-2.0. See [LICENSE](LICENSE).
