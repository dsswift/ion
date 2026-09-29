/**
 * Structural guard against the silent-no-op class.
 *
 * `window.ion?.foo()` is an optional chain. In the Electron renderer
 * `window.ion` always exists, so it reads as harmless defensive style. In a
 * browser Studio client it does not exist, so the whole call evaluates to
 * `undefined`: no throw, no refusal, no capability check, and nothing in any
 * log. The feature simply does not happen.
 *
 * That is strictly worse than the refusal proxy on `host.shell`, which at
 * least tells you it refused. It is how a browser client silently forgot
 * every preference on reload -- `saveSettings` was one of these, and the
 * write vanished with no trace for anyone to find.
 *
 * Every remaining site is listed below with why it is still acceptable. The
 * list may SHRINK freely. Adding to it means adding a new invisible failure,
 * so a new entry has to be a deliberate, justified edit rather than
 * something that slips in behind a `?.`.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/** Anchored to this file, not the process cwd: vitest workers do not all share one. */
const RENDERER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Known optional-chain call sites, by method name.
 *
 * Every one of these is Electron-only by nature (native pairing, OS fonts,
 * the tray, extension file pickers) or is read through a path that already
 * has a browser answer elsewhere. None of them is a feature a browser client
 * is expected to reach.
 */
const ALLOWED = new Set([
  // Native OS surfaces.
  'listFonts', 'selectExtensionFiles', 'listCustomThemes', 'studioBrowserPopoverRects',
  // Enterprise identity, resolved server-side for a browser client.
  'entraIdentity', 'entraSignIn', 'getEnterprisePolicy', 'getEnterprisePolicyFull',
  // Resource read-state and catalog, delivered to a browser over the wire.
  'getReadResourceIds', 'markResourceRead', 'publishResourceDelete', 'onResourceCatalogChanged',
  // Not calls: a property read and the generic event helpers.
  'platform', 'on', 'off',
])

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { sourceFiles(p, acc); continue }
    if (!/\.tsx?$/.test(p)) continue
    if (/__tests__|\.test\./.test(p)) continue
    acc.push(p)
  }
  return acc
}

describe('silent host-call scan', () => {
  it('adds no new window.ion?. site that would vanish in a browser', () => {
    const found = new Map<string, string[]>()
    for (const file of sourceFiles(RENDERER_ROOT)) {
      const src = readFileSync(file, 'utf-8')
      for (const m of src.matchAll(/window\.ion\?\.([a-zA-Z]+)/g)) {
        // Skip matches inside the explanatory comments that describe the
        // pattern itself rather than performing it.
        const lineStart = src.lastIndexOf('\n', m.index) + 1
        const line = src.slice(lineStart, src.indexOf('\n', m.index))
        if (/^\s*(\*|\/\/)/.test(line)) continue
        if (!found.has(m[1])) found.set(m[1], [])
        found.get(m[1])!.push(file)
      }
    }
    const unexpected = [...found.keys()].filter((name) => !ALLOWED.has(name)).sort()
    expect(unexpected, `new silent window.ion?. call site(s): ${unexpected.join(', ')}`).toEqual([])
  })

  it('never chains off an optional host call, which short-circuits to undefined', () => {
    // The escalation of the silent class into a hard crash.
    //
    // `?.` short-circuits the WHOLE chain, so with no preload
    // `window.ion?.listFonts().then(...)` evaluates to `undefined` rather
    // than to a promise. That is fine at the call itself -- and fatal at the
    // next use: the Appearance settings page once stored the result in a module
    // constant and later did `fontPromise.then(...)`, which threw
    // "Cannot read properties of undefined (reading 'then')" out of a render
    // and took the whole Appearance settings tab down through the root error
    // boundary in a browser client.
    //
    // A call whose value is USED must produce a real value on both hosts.
    // Either guard the host explicitly (`window.ion ? ... : fallback`) or
    // route it through the host seam, which refuses loudly instead.
    const offenders: string[] = []
    for (const file of sourceFiles(RENDERER_ROOT)) {
      const src = readFileSync(file, 'utf-8')
      for (const m of src.matchAll(/window\.ion\?\.[a-zA-Z]+\(/g)) {
        const lineStart = src.lastIndexOf('\n', m.index) + 1
        if (/^\s*(\*|\/\/)/.test(src.slice(lineStart, src.indexOf('\n', m.index)))) continue
        // Walk to the matching close paren so an argument list containing
        // its own parens or a nested call does not end the scan early.
        let depth = 1
        let i = m.index + m[0].length
        for (; i < src.length && depth > 0; i++) {
          if (src[i] === '(') depth++
          else if (src[i] === ')') depth--
        }
        if (depth !== 0) continue
        if (/^\s*[.?[]/.test(src.slice(i, i + 8))) {
          offenders.push(`${file.slice(RENDERER_ROOT.length + 1)}: ${src.slice(m.index, i + 12).replace(/\s+/g, ' ')}`)
        }
      }
    }
    expect(offenders, `optional host call whose result is consumed: ${offenders.join(' | ')}`).toEqual([])
  })

  it('the preference funnel is not one of them', () => {
    // The regression this whole file exists for. The funnel must reach the
    // host seam, so a browser client's writes land in its server-side
    // overlay instead of evaporating.
    const src = readFileSync(join(RENDERER_ROOT, 'preferences-persist.ts'), 'utf-8')
    const calls = [...src.matchAll(/window\.ion\?\.([a-zA-Z]+)\(/g)]
      .filter((m) => {
        const lineStart = src.lastIndexOf('\n', m.index) + 1
        const line = src.slice(lineStart, src.indexOf('\n', m.index))
        return !/^\s*(\*|\/\/)/.test(line)
      })
      .map((m) => m[1])
    expect(calls).toEqual([])
    // The funnel resolves its transport through `settingsTransport()`, which
    // prefers the preload and falls back to the host seam -- so a browser
    // client's writes reach its server-side overlay instead of evaporating.
    expect(src).toContain('function settingsTransport')
    expect(src).toContain('host as { shell?')
  })
})
