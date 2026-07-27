/**
 * Guard: worktree and bench state paths must resolve LAZILY.
 *
 * ── The defect this pins ────────────────────────────────────────────────────
 * `bench-store.ts` and `inventory.ts` originally captured their paths in
 * module-level `const`s:
 *
 *     const ION_DIR = join(homedir(), '.ion')
 *     export const WORKSPACES_FILE = join(ION_DIR, 'integration-workspaces.json')
 *
 * A `const` computed at import time freezes whatever HOME was when the module
 * first loaded. That made the paths unobservable: a test that redirected HOME
 * still wrote to the developer's REAL `~/.ion`, because the module had already
 * resolved its path before the redirect existed. It happened — a test run left
 * 222 junk workspace records and a bench worktree in a real home directory.
 *
 * It is also wrong in production: the main process can legitimately resolve its
 * data directory after module load.
 *
 * So this asserts the shape directly against the source. A behavioural test
 * cannot catch it — by the time a test runs, the damage is already a path
 * baked into a loaded module.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const MAIN = join(__dirname, '..')

function source(rel: string): string {
  return readFileSync(join(MAIN, rel), 'utf-8')
}

/** Strip comments so prose describing the fix does not trip the guard. */
function code(rel: string): string {
  return source(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

const STATE_MODULES = [
  'integration/bench-store.ts',
  'worktree/inventory.ts',
]

describe('state paths resolve lazily', () => {
  it.each(STATE_MODULES)('%s does not capture homedir() in a module-level const', (rel) => {
    const src = code(rel)
    // A top-level `const X = join(homedir(), ...)` is the exact defect: it is
    // evaluated once at import and can never reflect a later HOME.
    const offenders = src
      .split('\n')
      .filter((line) => /^\s*(export\s+)?const\s+\w+\s*=.*homedir\(\)/.test(line))

    expect(offenders).toEqual([])
  })

  it.each(STATE_MODULES)('%s resolves its paths through functions', (rel) => {
    // homedir() must be called from inside a function body, so every call site
    // re-resolves. Presence of `function` + homedir() together is the shape.
    const src = code(rel)
    expect(src).toMatch(/function \w+\(\)(: string)? \{[^}]*homedir\(\)/)
  })
})

describe('bench-store exposes resolvers, not frozen constants', () => {
  it('exports path functions rather than path constants', async () => {
    const mod = await import('../integration/bench-store')

    expect(typeof mod.workspacesFile).toBe('function')
    expect(typeof mod.integrationRoot).toBe('function')
    expect(typeof mod.ionDir).toBe('function')
    // The old frozen constants must be gone, not merely unused: a re-export
    // would let a caller reintroduce the bug.
    expect('WORKSPACES_FILE' in mod).toBe(false)
    expect('INTEGRATION_ROOT' in mod).toBe(false)
    expect('ION_DIR' in mod).toBe(false)
  })

  it('re-resolves when HOME changes', async () => {
    const mod = await import('../integration/bench-store')
    const before = mod.workspacesFile()

    const original = process.env.HOME
    try {
      process.env.HOME = '/tmp/ion-lazy-path-probe'
      // A frozen const would return the same string here; a resolver reflects
      // the change. This is the property that keeps tests off the real ~/.ion.
      expect(mod.workspacesFile()).not.toBe(before)
      expect(mod.workspacesFile()).toContain('/tmp/ion-lazy-path-probe')
    } finally {
      if (original === undefined) delete process.env.HOME
      else process.env.HOME = original
    }
  })
})

describe('inventory exposes a resolver', () => {
  it('exports worktreeRegistryFile as a function', async () => {
    const mod = await import('../worktree/inventory')

    expect(typeof mod.worktreeRegistryFile).toBe('function')
    expect('WORKTREE_REGISTRY_FILE' in mod).toBe(false)
  })
})
