import { describe, it, expect } from 'vitest'
import { runAsPrincipal, currentPrincipal, currentClaims } from '../request-principal'

describe('request-principal', () => {
  it('returns undefined outside any runAsPrincipal wrap', () => {
    expect(currentPrincipal()).toBeUndefined()
    expect(currentClaims()).toBeUndefined()
  })

  it('exposes the wrapped principal inside runAsPrincipal', () => {
    runAsPrincipal({ principal: { subject: 'alice', displayName: 'Alice' } }, () => {
      expect(currentPrincipal()).toEqual({ subject: 'alice', displayName: 'Alice' })
    })
    expect(currentPrincipal()).toBeUndefined()
  })

  it('carries claims separately from the wire-safe principal', () => {
    runAsPrincipal({ principal: { subject: 'alice', displayName: 'Alice' }, claims: { roles: ['admin'] } }, () => {
      expect(currentClaims()).toEqual({ roles: ['admin'] })
    })
  })

  it('follows the async call graph across an await', async () => {
    await runAsPrincipal({ principal: { subject: 'bob', displayName: 'Bob' } }, async () => {
      await Promise.resolve()
      expect(currentPrincipal()?.subject).toBe('bob')
    })
  })

  it('isolates two concurrent request chains from each other', async () => {
    const seenA: (string | undefined)[] = []
    const seenB: (string | undefined)[] = []

    const runA = runAsPrincipal({ principal: { subject: 'a', displayName: 'A' } }, async () => {
      seenA.push(currentPrincipal()?.subject)
      await new Promise((r) => setTimeout(r, 5))
      seenA.push(currentPrincipal()?.subject)
    })
    const runB = runAsPrincipal({ principal: { subject: 'b', displayName: 'B' } }, async () => {
      seenB.push(currentPrincipal()?.subject)
      await new Promise((r) => setTimeout(r, 1))
      seenB.push(currentPrincipal()?.subject)
    })

    await Promise.all([runA, runB])
    expect(seenA).toEqual(['a', 'a'])
    expect(seenB).toEqual(['b', 'b'])
  })
})
