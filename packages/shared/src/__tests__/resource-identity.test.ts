import { describe, expect, it } from 'vitest'
import { resourceIdentity, resourceMatchesIdentity } from '../resource-identity'

describe('resourceIdentity', () => {
  it('preserves the raw ID for producerless legacy items', () => {
    expect(resourceIdentity({ id: 'resource-1' })).toBe('resource-1')
  })

  it('creates unambiguous producer-qualified identities', () => {
    expect(resourceIdentity({ id: 'item:1', producer: 'ext:one' })).toBe('0::7:ext:one:item:1')
  })

  it('matches the producer as part of resource identity', () => {
    const item = { id: 'same-id', producer: 'producer-a' }
    expect(resourceMatchesIdentity(item, 'same-id', 'producer-a')).toBe(true)
    expect(resourceMatchesIdentity(item, 'same-id', 'producer-b')).toBe(false)
  })
})
