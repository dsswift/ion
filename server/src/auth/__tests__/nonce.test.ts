import { afterEach, describe, expect, it } from 'vitest'
import { currentNonce, candidateNonces, _resetNonceForTest, _setNonceTtlForTest } from '../nonce'

afterEach(() => {
  _resetNonceForTest()
})

describe('nonce rotation', () => {
  it('returns the same value across calls within the TTL', () => {
    const a = currentNonce()
    const b = currentNonce()
    expect(a).toBe(b)
  })

  it('rotates to a new current nonce once the TTL elapses, keeping the old one as previous for one more rotation', async () => {
    _setNonceTtlForTest(20)
    const first = currentNonce()
    await new Promise((resolve) => setTimeout(resolve, 30))

    const second = currentNonce()
    expect(second).not.toBe(first)
    expect(candidateNonces()).toEqual([second, first])

    // A second rotation drops `first` from the candidate set entirely.
    await new Promise((resolve) => setTimeout(resolve, 30))
    const third = currentNonce()
    expect(candidateNonces()).toEqual([third, second])
    expect(candidateNonces()).not.toContain(first)
  })
})
