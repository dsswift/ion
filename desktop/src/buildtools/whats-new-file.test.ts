/**
 * desktop/whats-new.json is what the release pipeline writes and every build
 * reads (electron.vite.config.ts). A malformed file costs a build its notes
 * without failing it, so this is where a bad hand edit is caught.
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { whatsNewFor } from '@ion/shared/build-notice'

describe('desktop/whats-new.json', () => {
  it('is an object of version to plain-sentence notes', () => {
    const notes: unknown = JSON.parse(readFileSync(resolve(__dirname, '../../whats-new.json'), 'utf8'))
    expect(whatsNewFor(notes, '0.0.0')).toEqual([])
    for (const items of Object.values(notes as Record<string, string[]>)) {
      for (const item of items) expect(item.trim()).not.toBe('')
    }
  })
})
