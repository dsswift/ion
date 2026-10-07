/**
 * The renderer's build-time replacement for `server/src/tracing/op-span.ts`
 * must export every name the renderer bundle can reach.
 *
 * The swap is a Vite `resolveId` plugin (`renderer-server-stubs.ts`), so
 * TypeScript never compares the two files: an export the real module gains
 * type-checks clean and then fails `electron-vite build` with "is not
 * exported". This test catches it without a bundle build.
 */
import { describe, expect, it } from 'vitest'

import * as stub from '../server-op-span-browser-stub'
import * as real from '@ion/server/tracing/op-span'

describe('browser op-span stub: export parity', () => {
  it('exports every name the real module exports', () => {
    const missing = Object.keys(real).filter((k) => !(k in stub))
    expect(missing, `stub is missing: ${missing.join(', ')}`).toEqual([])
  })

  it('exports nothing the real module does not', () => {
    const extra = Object.keys(stub).filter((k) => !(k in real))
    expect(extra, `stub exports unknown names: ${extra.join(', ')}`).toEqual([])
  })

  it('answers "no trace" and writes nothing', () => {
    expect(stub.currentEventTrace()).toBeUndefined()
    expect(stub.currentTraceparent()).toBeUndefined()
    expect(stub.withSpan('x', {}, (span) => typeof span.traceparent)).toBe('string')
  })
})
