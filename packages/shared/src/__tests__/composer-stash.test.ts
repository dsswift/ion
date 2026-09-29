import { describe, expect, it } from 'vitest'
import {
  COMPOSER_STASH_MAX_ENTRIES_PER_PROJECT,
  EMPTY_COMPOSER_STASH,
  parseComposerStash,
  pushStashEntry,
  removeStashEntry,
  type ComposerStashEntry,
} from '../composer-stash'

const entry = (id: string): ComposerStashEntry => ({
  id,
  text: `prompt ${id}`,
  attachments: [{ id: `a-${id}`, type: 'file', name: 'a.txt', path: '/work/a.txt', mimeType: 'text/plain' }],
  createdAt: 1,
})

describe('composer stash', () => {
  it('round-trips through JSON and the parser', () => {
    const stash = pushStashEntry(EMPTY_COMPOSER_STASH, '/src/ion', entry('1'))
    expect(parseComposerStash(JSON.parse(JSON.stringify(stash)))).toEqual(stash)
  })

  it('puts the newest first and drops the oldest past the cap', () => {
    let stash = EMPTY_COMPOSER_STASH
    for (let i = 0; i <= COMPOSER_STASH_MAX_ENTRIES_PER_PROJECT; i++) stash = pushStashEntry(stash, 'p', entry(String(i)))
    expect(stash.projects.p).toHaveLength(COMPOSER_STASH_MAX_ENTRIES_PER_PROJECT)
    expect(stash.projects.p[0].id).toBe(String(COMPOSER_STASH_MAX_ENTRIES_PER_PROJECT))
    expect(stash.projects.p.some((e) => e.id === '0')).toBe(false)
  })

  it('removes an entry and forgets a project with none left', () => {
    const stash = removeStashEntry(pushStashEntry(EMPTY_COMPOSER_STASH, 'p', entry('1')), 'p', '1')
    expect(stash.projects).toEqual({})
  })

  it('rejects a wrong version and a malformed entry', () => {
    expect(parseComposerStash({ version: 2, projects: {} })).toBeNull()
    expect(parseComposerStash({ version: 1, projects: { p: [{ id: '1', text: 5, attachments: [], createdAt: 1 }] } })).toBeNull()
    expect(parseComposerStash({ version: 1, projects: { p: [{ ...entry('1'), attachments: [{ id: 'x', type: 'plan', name: 'n', path: 'p' }] }] } })).toBeNull()
  })
})
