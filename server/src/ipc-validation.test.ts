import { describe, expect, it } from 'vitest'
import { sanitizeDialogFilters } from './ipc-validation'

describe('sanitizeDialogFilters', () => {
  it('passes an absent value through and copies a well-formed list', () => {
    expect(sanitizeDialogFilters(undefined)).toBeUndefined()
    const input = [{ name: 'Zip Archive', extensions: ['zip'] }, { name: 'Text', extensions: ['txt', 'md'] }]
    const out = sanitizeDialogFilters(input)
    expect(out).toEqual(input)
    expect(out).not.toBe(input)
  })

  it('refuses every malformed shape rather than handing Electron a guess', () => {
    for (const bad of [
      null, 'zip', [], [null], [{ name: '', extensions: ['zip'] }], [{ name: 'x'.repeat(65), extensions: ['zip'] }],
      [{ name: 'Zip', extensions: [] }], [{ name: 'Zip', extensions: ['*.zip'] }], [{ name: 'Zip', extensions: ['.zip'] }],
      [{ name: 'Zip', extensions: ['a/b'] }], [{ name: 'Zip', extensions: [1] }], [{ name: 'a\nb', extensions: ['zip'] }],
    ]) {
      expect(sanitizeDialogFilters(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})
