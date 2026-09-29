import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { localPipeName, resolveLocalStudioTarget } from './local-studio-socket'

const SID = 'S-1-5-21-1696802954-1770460993-270566097-1000'

describe('resolveLocalStudioTarget', () => {
  it('names the win32 pipe by the current user SID, never by a stored id', () => {
    const target = resolveLocalStudioTarget('/data', 'win32', () => SID)
    expect(target).toEqual({ kind: 'pipe', path: `\\\\.\\pipe\\ion-studio-${SID}` })
    expect(target.path).toBe(localPipeName(SID))
  })

  it('refuses to guess a pipe name when the SID cannot be read', () => {
    expect(() => resolveLocalStudioTarget('/data', 'win32', () => null)).toThrow(/no Windows SID/)
  })

  it('uses studio.sock in the data dir everywhere else', () => {
    expect(resolveLocalStudioTarget('/data', 'darwin', () => SID)).toEqual({ kind: 'unix', path: join('/data', 'studio.sock') })
    expect(resolveLocalStudioTarget('/data', 'linux', () => null)).toEqual({ kind: 'unix', path: join('/data', 'studio.sock') })
  })
})
