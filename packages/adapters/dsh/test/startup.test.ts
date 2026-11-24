/**
 * The startup check: the package must LOAD the way a user loads it.
 *
 * The failure this exists for is not subtle once it happens, but it is
 * invisible until then: cremator-dsh published a build whose dist imported a
 * symbol the declared dependency range did not provide (isTwoVerdictGrammar,
 * present in @cremator/core 0.1.2 but not 0.1.1), while its manifest still said
 * "@cremator/core": "^0.1.0". A fresh install resolved 0.1.1, and the plugin
 * then failed at ESM link time — before apply, before any configuration, with
 * nothing the mount could report:
 *
 *   SyntaxError: The requested module '@cremator/core' does not provide an
 *   export named 'isTwoVerdictGrammar'
 *
 * Type-checking does not catch it (the workspace resolves types from source),
 * and no unit test imports the packaged entry. So this case imports the BUILT
 * artefacts through the published entry points — the same specifiers a host
 * uses — and additionally proves the manifest's dependency floor actually
 * carries every symbol the build imports from it.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const DSH_DIR = resolve(HERE, '..');
const CORE_DIR = resolve(HERE, '../../../core');
// The workspace hoists devDependencies, so TypeScript lives at the repo root
// rather than inside each package.
const TSC = resolve(HERE, '../../../../node_modules/typescript/bin/tsc');

/** The built entry point, exactly as package.json names it. */
function builtEntry(packageDir: string, subpath: string): string {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    exports?: Record<string, { default?: string }>;
  };
  const exported = subpath === '.' ? manifest.exports?.['.']?.default
    : manifest.exports?.[subpath]?.default;
  assert.ok(exported, `the manifest declares no default export for ${subpath}`);
  return join(packageDir, exported);
}

/** Build one package with its own TypeScript, the same invocation prepack runs. */
function build(packageDir: string): void {
  execFileSync(process.execPath, [TSC, '-p', join(packageDir, 'tsconfig.build.json')],
    { stdio: 'pipe' });
}

describe('the packaged entry loads', () => {
  it('both packages build, so there is something to load', () => {
    // A build is the precondition of this whole check; running it here keeps the
    // case honest when someone edits src and forgets to rebuild.
    build(CORE_DIR);
    build(DSH_DIR);
    assert.ok(existsSync(builtEntry(CORE_DIR, '.')), 'core emits its entry');
    assert.ok(existsSync(builtEntry(DSH_DIR, './plugin')), 'the adapter emits its mount entry');
  });

  it('@cremator/core imports through its published entry', async () => {
    const module = await import(pathToFileURL(builtEntry(CORE_DIR, '.')).href) as Record<string, unknown>;
    // The symbols every layer is built on, so an empty or partial build fails
    // here rather than at the first pass.
    for (const name of ['RacoonsEngine', 'SqliteLedger', 'Guard']) {
      assert.ok(name in module, `core does not export ${name}`);
    }
  });

  it('cremator-dsh/plugin imports through its published entry', async () => {
    const module = await import(pathToFileURL(builtEntry(DSH_DIR, './plugin')).href) as Record<string, unknown>;
    assert.equal(module['CREMATOR_PLUGIN_NAME'], 'cremator');
    assert.deepEqual(module['CREMATOR_PLUGIN_INJECT'], ['llm', 'sessions', 'commands']);
    assert.equal(typeof module['createRacoonsPlugin'], 'function');
    const plugin = (module['createRacoonsPlugin'] as () => Record<string, unknown>)();
    assert.equal(plugin['name'], 'cremator');
    assert.equal(typeof plugin['apply'], 'function');
  });

  it('every symbol the adapter imports from core exists in the built core', async () => {
    // The bug this pins: the build used a symbol the manifest range could not
    // guarantee. Reading the imports out of the BUILT file is what makes this a
    // real check — a hand-written list would drift from the build.
    const built = readFileSync(builtEntry(DSH_DIR, './plugin'), 'utf8');
    const coreImport = /import\s*\{([^}]+)\}\s*from\s*'@cremator\/core'/gu;
    const needed = new Set<string>();
    for (const match of built.matchAll(coreImport)) {
      for (const part of match[1]!.split(',')) {
        const name = part.trim().split(/\s+as\s+/u)[0]?.trim();
        if (name !== undefined && name.length > 0) needed.add(name);
      }
    }
    assert.ok(needed.size > 0, 'the entry imports something from core');
    const core = await import(pathToFileURL(builtEntry(CORE_DIR, '.')).href) as Record<string, unknown>;
    const missing = [...needed].filter(name => !(name in core)).sort();
    assert.deepEqual(missing, [],
      `the adapter imports symbols this core build does not export: ${missing.join(', ')}`);
  });

  it('the manifest floor names a core version this build was made against', () => {
    const manifest = JSON.parse(readFileSync(join(DSH_DIR, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const range = manifest.dependencies?.['@cremator/core'];
    assert.ok(range, 'the adapter declares its core dependency');
    // The range must be able to resolve the core version in THIS workspace: a
    // lower floor is exactly how the published 0.1.2 shipped an unloadable pair.
    const coreVersion = (JSON.parse(readFileSync(join(CORE_DIR, 'package.json'), 'utf8')) as {
      version: string;
    }).version;
    // The floor is the LOWEST version the range may resolve to, and that version
    // is what a fresh install gets. A caret allows any higher patch, so the floor
    // — not the workspace core — is what the build must work against. A floor of
    // "^0.1.0" therefore permits 0.1.1, which is exactly how the published 0.1.2
    // shipped an unloadable pair: the build used a 0.1.2 symbol while the range
    // promised only 0.1.0.
    const floor = /^(\^|~)?(\d+)\.(\d+)\.(\d+)/u.exec(String(range));
    assert.ok(floor, `unparseable core range ${String(range)}`);
    const minimum = [Number(floor[2]), Number(floor[3]), Number(floor[4])];
    const built = coreVersion.split('.').map(Number);
    const compare = (a: readonly number[], b: readonly number[]): number => {
      for (let index = 0; index < 3; index += 1) {
        const left = a[index] ?? 0;
        const right = b[index] ?? 0;
        if (left !== right) return left < right ? -1 : 1;
      }
      return 0;
    };
    assert.ok(compare(minimum, built) >= 0,
      `the adapter floor ${String(range)} resolves below the core it is built against `
      + `(${coreVersion}): a fresh install would get an older core than the build imports from`);
  });
});
