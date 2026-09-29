import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { createRequire } from 'module'
import { decodeFrame, encodeFrame } from '@ion/shared/studio-wire/codec'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

/**
 * The desktop's own codec-fixture round-trip test (manifest contract C3
 * Acceptance Criteria: "Codec tests in all three packages load every
 * fixture and round-trip byte-for-byte"). See `server/src/protocol/__tests__/codec-fixtures.test.ts`
 * for the server-side twin; both resolve the fixtures directory through
 * `@ion/shared`'s actual module location rather than a relative path climb,
 * since `@ion/shared`'s exports map has no `./package.json` entry to anchor on.
 */
function fixturesDir(): string {
  const require = createRequire(import.meta.url)
  const versionModule = require.resolve('@ion/shared/studio-wire/version')
  return join(dirname(versionModule), '__fixtures__', 'v1')
}

describe('desktop: studio-wire codec fixtures', () => {
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
