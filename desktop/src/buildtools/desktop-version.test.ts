import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const versioning = require('../../scripts/desktop-version.js') as {
  nextDevelopmentVersion: (release: string, sha: string, dirty?: boolean) => string
  readReleasedDesktopVersion: () => string
}

describe('desktop development version', () => {
  it('uses the next minor version and identifies the source commit', () => {
    expect(versioning.nextDevelopmentVersion('1.82.0', 'abcdef123456')).toBe('1.83.0-dev.abcdef123456')
    expect(versioning.nextDevelopmentVersion('1.82.0', 'abcdef123456', true)).toBe('1.83.0-dev.abcdef123456.dirty')
  })

  it('reads the released desktop version from the release manifest', () => {
    expect(versioning.readReleasedDesktopVersion()).toBe('1.83.0')
  })
})
