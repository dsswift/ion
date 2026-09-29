/**
 * The renderer's build-time replacement for
 * `server/src/persistence/effective-settings.ts` must export everything the
 * real module does.
 *
 * The swap is a Vite `resolveId` plugin (`renderer-server-stubs.ts`), so
 * TypeScript never compares the two files: a stub missing an export the real
 * module gained type-checks clean and then throws
 * `X is not a function` in the renderer at runtime. This test is the only
 * thing that compares them.
 *
 * The stub is reachable from every renderer file that imports the session
 * store, because `persistence/preferences.ts` resolves its personal
 * preferences through the real module — which reads real `fs` and calls
 * `os.userInfo()`, neither of which a browser bundle can do.
 */
import { describe, expect, it } from 'vitest'

import * as stub from '../server-effective-settings-browser-stub'
import * as real from '@ion/server/persistence/effective-settings'

describe('browser effective-settings stub: export parity', () => {
  it('exports every name the real module exports', () => {
    const missing = Object.keys(real).filter((k) => !(k in stub))
    expect(missing, `stub is missing: ${missing.join(', ')}`).toEqual([])
  })

  it('exports nothing the real module does not', () => {
    // An extra export is dead weight in the bundle and a sign the two files
    // have drifted apart in opposite directions.
    const extra = Object.keys(stub).filter((k) => !(k in real))
    expect(extra, `stub exports unknown names: ${extra.join(', ')}`).toEqual([])
  })
})

describe('browser effective-settings stub: values', () => {
  it('reads empty rather than pretending to know the settings document', () => {
    expect(stub.readEffectiveSettings()).toEqual({})
  })

  it('throws on a write instead of silently dropping it', () => {
    // Preference persistence is server-owned. A renderer-side write is a
    // wiring mistake and must fail loudly, not look like it saved.
    expect(() => stub.writeEffectiveSettings({ defaultThinkingEffort: 'low' })).toThrow(/server-owned/)
  })
})
