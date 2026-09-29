/**
 * The desktop main process never reaches the engine bridge, the session
 * plane or the session store -- not directly (check-server-parity.sh Check 7
 * greps for that) and not through a server module it imports for something
 * else. The Studio server is the engine's one client (ADR-033); a second
 * bridge constructed in this process connects, logs "Connected to engine
 * server" under the desktop's pid, and answers nothing anyone reads.
 *
 * This walks the value-import graph from the main entry, through
 * `@ion/server/*` and relative imports, the way the bundler does. It was
 * `oauth/entra-flow` -> `state` that gave the packaged desktop its second
 * bridge after the grep-based check passed.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const SERVER_SRC = join(ROOT, 'server', 'src')
const ENTRY = join(ROOT, 'desktop', 'src', 'main', 'index.ts')

/** Reaching any of these means this process would own an engine bridge or a store. */
const FORBIDDEN = ['state.ts', 'engine/engine-bridge.ts', 'engine/engine-control-plane.ts', 'store/sessionStore.ts', 'engine/event-wiring.ts'].map((p) => join(SERVER_SRC, p))

const IMPORT = /^\s*(?:import|export)\b[^'"]*?\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm
const TYPE_ONLY = /^\s*(?:import|export)\s+type\b/

function resolveModule(base: string): string | null {
  for (const c of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), base]) {
    if (existsSync(c) && statSync(c).isFile() && /\.tsx?$/.test(c)) return c
  }
  return null
}

function valueImports(file: string): string[] {
  const src = readFileSync(file, 'utf-8')
  const out: string[] = []
  for (const m of src.matchAll(IMPORT)) {
    if (TYPE_ONLY.test(m[0])) continue
    const spec = m[1] ?? m[2] ?? m[3]
    const target = spec.startsWith('@ion/server/')
      ? resolveModule(join(SERVER_SRC, spec.slice('@ion/server/'.length)))
      : spec.startsWith('.') ? resolveModule(join(dirname(file), spec)) : null
    if (target) out.push(target)
  }
  return out
}

describe('desktop main never reaches the engine or the store', () => {
  it('has no value-import path from index.ts to the server state, bridge, plane, store or event wiring', () => {
    const parent = new Map<string, string | null>([[ENTRY, null]])
    const queue = [ENTRY]
    while (queue.length > 0) {
      const file = queue.shift()!
      for (const dep of valueImports(file)) {
        if (parent.has(dep)) continue
        parent.set(dep, file)
        queue.push(dep)
      }
    }
    const reached = FORBIDDEN.filter((f) => parent.has(f))
    const chains = reached.map((f) => {
      const chain: string[] = []
      for (let n: string | null | undefined = f; n; n = parent.get(n)) chain.push(n.slice(ROOT.length + 1))
      return chain.reverse().join(' -> ')
    })
    expect(chains, 'import chains from desktop main into the server\'s engine/store').toEqual([])
  })
})
