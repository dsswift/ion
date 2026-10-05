import { describe, it, expect } from 'vitest'
import { fileLinkForPath } from '../deeplink-url'

describe('fileLinkForPath', () => {
  it('uses the working directory as dir when the file is inside it', () => {
    expect(fileLinkForPath('/repo/src/a.ts', '/repo/')).toBe('ion://file?dir=%2Frepo&path=%2Frepo%2Fsrc%2Fa.ts')
  })
  it('falls back to the file’s own directory', () => {
    expect(fileLinkForPath('/other/b.md', '/repo')).toBe('ion://file?dir=%2Fother&path=%2Fother%2Fb.md')
    expect(fileLinkForPath('/c.md', null)).toBe('ion://file?dir=%2F&path=%2Fc.md')
  })
  it('does not treat a sibling prefix as inside', () => {
    expect(fileLinkForPath('/repo2/x.ts', '/repo')).toBe('ion://file?dir=%2Frepo2&path=%2Frepo2%2Fx.ts')
  })
})
