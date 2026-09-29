import { describe, expect, it } from 'vitest'
import { parseNameStatus } from '../overlap-footprint'

describe('overlap footprint files', () => {
  it('preserves every file after a rename record', () => {
    const files = parseNameStatus('R100\0old.ts\0new.ts\0M\0later.ts\0')
    expect(files.map((file) => file.path)).toEqual(['new.ts', 'later.ts'])
  })
})
