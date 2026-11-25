# cremator-dsh

> **Fork notice.** This package's source in this repository is a fork of
> [zman406986/Agent-Memory-CREMATOR](https://github.com/zman406986/Agent-Memory-CREMATOR);
> see the [repository README](../../README.md) for the full change list. The
> version published to npm is the upstream release, not this fork.

CREMATOR adapter for the dsh harness. Thin seam mapping, no policy: it translates dsh session
events into the public seams of `@cremator/core` and applies what the core guard approved. Every
removal is recorded in the trash ledger under a recall id. Project:
https://github.com/zman406986/Agent-Memory-CREMATOR.

## Install

```sh
npm install cremator-dsh
```

`@cremator/core` installs as a dependency. Requires Node
`>=22.13.0 <23.0.0 || >=23.4.0`.

Host: `@deepseek-ai/dsh`, declared as an optional peer with the range
`>=0.2.1-rc.2 <0.3.0` — the versions this adapter was tested against. An older
or newer host still installs (the peer is optional), but the mount no longer
assumes it is readable: it probes the session and `surfaceOp` shapes at
`apply` and at every step boundary, and refuses to mount with an error naming
the field when they do not match. A shape mismatch used to surface minutes
later as a failed pass rather than as an incompatible host, which named the
wrong component.

### Install as a dsh bundle

The package declares `dsh.bundle.patch` (`cordis.patch.yml`). Add it to a profile:

```sh
dsh plugin --profile <name> add cremator-dsh
```

The host's Plugins page then lists `cremator-dsh`, and the profile records the
bundle in `dsh.profile.bundles`. The bundle patch inserts the mount with the
example config; a profile patch after it can override any key. Do not also
insert the row by hand: two rows with one id make the settings form
unaddressable.

For a local checkout, run `npm install && npm run build`, then use
`dsh plugin --profile <name> add link:<absolute package directory>`.

## Use

The mount entry is the subpath export; the package's default entry has no host dependency.

`dsh --patch` row:

```yaml
- insert:
 - id: cremator
 name: 'cremator-dsh/plugin'
 config:
 barBytes: 512
 enforcement: apply
 pruneThresholdTokens: 60000
 entryAskTrigger: { mode: 'off' }
 entryAskGrammar: jsonl-20
 nativeCompactionBackstop: true
```

The entry is a Cordis plugin (`name`, `inject`, `apply`) and also exports a default instance, so a
`file:///` specifier or a bare package specifier both work. Config keys are the mount's flat knobs:
`barBytes`, `floorBytes`, `episodeNoNewPathSteps`, `sealMaxLatencyTurns`, `minCutFreedBytes`,
`enforcement`, `recordName`, `anchors`, `judgeTimeoutMs`, `crematorStorageRoot`,
`contextWindowTokens`, `pruneThresholdTokens`, `nativeCompactionBackstop`, `entryAskTrigger`,
`entryAskGrammar`, `pruneAskGrammar`, `entryAskBatchSize`, `dedupeSupersededByReread`,
`dedupeCallEcho`, `gcRetainSessions`.

`contextWindowTokens` is deliberately absent above. The depth trigger's skip
line is 75% of that number, so a fixed value is wrong for every routed model but
the one it was measured on: too small retires the trigger early (400,000 on a
1M-token model stops at 300,000), too large retires it never. Left unset, the
mount resolves the **routed model's** own window through the host's
`llm.resolveModelInfo` seam and re-resolves on a model switch. Set it only when
you want to pin a number regardless of the route.

### The `/cremate` command

When the host exposes its command registry (`commands`), the mount registers `cremate`; the slash
menu lists `/cremate`. The command card reports the pass directly: the handler registers the
request for a CREMATOR marker message, opens that marker turn through `agent.followup`, and awaits
the pass the turn's `agent/pre-step` runs inside the open turn. The marker step is then rejected,
so the model sees no `/cremate` message and the turn sends no request; the marker carries the
command's id as `source.commandId`. The pass must run inside a turn because the host's session log
accepts a tool-result surface replacement only with an open turn; running it from the handler
corrupts the stored session. A typed `/cremate` message keeps its queued path: it marks
the session and the next `agent/pre-step` runs the pass.

Defaults that matter: `barBytes` 512, `enforcement` `apply`, `entryAskGrammar` `jsonl-20`, `pruneAskGrammar` `nokeepall`, and
`nativeCompactionBackstop` `true`. `contextWindowTokens` is the host window the apply leg plans
against; `pruneThresholdTokens` is the absolute depth bar (the example uses 60,000); it requires a
window, configured or resolved from the host.
`entryAskTrigger` defaults to `{ mode: "off" }`: the per-result entry ask is retired, and
the entry seam stays for compatibility. An explicit `{ mode: "count" }` selects the retired
per-result cadence; `entryAskBatchSize` applies only on that path.

`capBytes` and `capHeadBytes` are accepted and ignored: the entry-time cap was
scrapped, so an old config file still mounts and neither value is read. Remove them from new
rows. `minCutFreedBytes` is also accepted and ignored: the cut is the earliest forgotten node.

## Durable storage

Storage is durable per session: session `N`'s trash ledger is
`<crematorStorageRoot>/sessions/N/ledger.sqlite` with its blobs in the sibling `blobs/`
directory. Removals survive a restart via the durable ledger; a host-confirmed
conflict blocks and journals.

Only the storage root is configurable; a per-session path pair (`databasePath` + `blobRoot`) is
refused with `explicit-storage-paths`, because one shared ledger would break the per-session rule.

`crematorStorageRoot` is the config key. It must be absolute. Absent, it resolves to
`<DSH_HOME>/storages/cremator`, where `DSH_HOME` defaults to `~/.dsh` — so on a typical install
that is `~/.dsh/storages/cremator`, holding one `sessions/<sessionId>/` directory per session.
`storages` is dsh's own storage root and `cremator` is a subdirectory of it, so no dsh file is
ever shared: CREMATOR stamps its own `application_id` and `user_version`, and a shared file would
be unreadable by both sides.

A host that owns durable storage may pass its own `openLedger` instead:

```ts
import { createRacoonsPlugin } from 'cremator-dsh';

const plugin = createRacoonsPlugin({
 config: { enforcement: 'apply', barBytes: 512,
 crematorStorageRoot: '/home/me/.dsh/storages/cremator' },
 journal: (record) => console.error(record.kind),
});
// mount: await plugin.apply(ctx)
```

The mount journals one `mounted` record carrying `ledgerSource`
(`'durable' | 'host' | 'memory'`), `node` (`process.version`) and, for the durable source,
`storageRoot`.

### Operator commands

`/cremate` alone runs a pass. Three subcommands answer without opening a turn,
because none of them writes the surface:

| Command | What it does |
| --- | --- |
| `/cremate` | Run one cremation pass now. |
| `/cremate stats` | Total what the journal recorded: asks sent, tokens billed, bytes freed, and the net. |
| `/cremate gc` | Keep the `gcRetainSessions` most recently used sessions and remove the rest. A session a live mount holds is always kept; `0` (the default) removes nothing. |
| `/cremate export <sessionId>` | Write that session's archive to `<crematorStorageRoot>/<sessionId>.archive.json`, ready for `hydrate` on another device. |

Storage never expires on its own — archived bytes live until the session
directory is deleted — so `/cremate gc` is the only thing that bounds an
install's footprint. `/cremate stats` reads the same two journal records a sink
already receives (`prune-ask` for cost, `prune-apply` for freed bytes): an ask
that reported no usage is counted as an ask with an UNKNOWN cost, never as a
free one, and a pass that did not apply freed nothing.

`':memory:'` is for tests only, through the programmatic `storage` option; no config value
selects it.

### Degradation

- **The ledger cannot open** (the path is unreadable, occupied, or otherwise failing): the mount retries
 the open once at the next step boundary, warning and journaling `storage-retry` for the first
 failure. If the retry also fails, it installs a refusing ledger and journals `storage-unavailable`
 once with the code, path and runtime; every removal is then refused with a typed `storage` error.
 The session degrades to `recovery-pending`, the transcript is never touched, and recall of ids this
 process never minted fails as `not-found`. A retry that succeeds journals `storage-recovered` and
 the mount is fully live.
- **A restart keeps removals live.** The durable ledger's `applied` receipts are the record of
 record: a fresh port answers `unknown` for an intent it never saw, and the removal
 still counts as applied. A host that positively answers `not-applied` contradicts the ledger:
 the pass blocks and journals a `receipt-conflict`. Recall is a read of the durable ledger and
 keeps working either way.
- **Retention.** Archived bytes live until the user deletes the session directory. There is no
 automatic deletion and no expiry in v1.
- **Scope.** A recall id resolves within the session that minted it, including after a restart or
 resume of that session. Cross-session recall is out of scope.

The `necromancy` model-facing tool returns the projected output (`recallId`, `text`, `byteLength`,
`parts`), never the ledger record's `Uint8Array` parts: dsh requires every tool value to be
lossless JSON. The `forget` tool answers from the session's live snapshot and the mount applies an
admitted request at its next step or turn-end boundary, as one revert plus one receipt.

## Status

Append-mode Seal is enforced; the entry-time cap is scrapped. Verdict
enforcement defaults to `apply`; `record-only` is the explicit opt-out. The
stale-read and superseded-read proof rules ship and run in the mount's at-rest pass. Per-call usage reconciliation from the host's `assistant/message` row is wired. The per-path coverage meter's rows ride `SessionSnapshot.pathCoverage`, and the recall
source-fallback reader is wired (`recallReader`, `recallFromSource`).

## License

Apache-2.0.
