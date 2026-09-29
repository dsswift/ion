import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { createRequire } from 'module'
import { decodeFrame, encodeFrame } from '@ion/shared/studio-wire/codec'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

/**
 * The server's own codec-fixture round-trip test (manifest contract C3
 * Acceptance Criteria: "Codec tests in all three packages load every
 * fixture and round-trip byte-for-byte"). Resolves the fixtures directory
 * through `@ion/shared`'s package location rather than a relative `../../..`
 * climb, so it stays correct regardless of the server package's depth in
 * the workspace.
 */
function fixturesDir(): string {
  const require = createRequire(import.meta.url)
  // `@ion/shared`'s exports map (`"./*": "./src/*.ts"`) has no `./package.json`
  // entry, so resolve an actual exported module instead and walk to its
  // directory -- `studio-wire/version` resolves to
  // `packages/shared/src/studio-wire/version.ts`, whose directory holds `__fixtures__`.
  const versionModule = require.resolve('@ion/shared/studio-wire/version')
  return join(dirname(versionModule), '__fixtures__', 'v1')
}

describe('server: studio-wire codec fixtures', () => {
  const dir = fixturesDir()
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))

  it('finds at least one fixture per known frame type', () => {
    expect(files.length).toBeGreaterThanOrEqual(14)
  })

  for (const file of files) {
    it(`round-trips ${file}`, () => {
      const original = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as StudioFrame
      const decoded = decodeFrame(JSON.stringify(original))
      expect(decoded).toEqual(original)
      const reDecoded = decodeFrame(encodeFrame(decoded))
      expect(reDecoded).toEqual(original)
    })
  }
})
