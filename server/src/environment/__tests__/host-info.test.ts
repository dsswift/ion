import { describe, expect, it } from 'vitest'
import { isBundledTool } from '../host-info'

describe('isBundledTool', () => {
  // The bundle's node is the server's runtime, not a developer tool the host
  // has: a setup that runs `npm` on the login shell finds nothing there.
  it('treats a path inside the studio bundle as not a host tool', () => {
    const root = '/Users/someone/.ion/studio-server'
    expect(isBundledTool(`${root}/current/node/bin/node`, root)).toBe(true)
    expect(isBundledTool('/opt/homebrew/bin/node', root)).toBe(false)
    expect(isBundledTool(`${root}-other/bin/node`, root)).toBe(false)
  })

  it('counts every path as a host tool when this server was not installed from a bundle', () => {
    expect(isBundledTool('/anything/node', null)).toBe(false)
  })
})
