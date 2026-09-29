/** fs-browse lists directories only, honours hidden, marks git checkouts, resolves `~`, and refuses a file. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { browseDirectory, expandHome } from '../fs-browse'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-fs-browse-'))
  mkdirSync(join(root, 'src', 'repo', '.git'), { recursive: true })
  mkdirSync(join(root, 'src', 'plain'))
  mkdirSync(join(root, 'src', '.hidden'))
  writeFileSync(join(root, 'src', 'file.txt'), 'x')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('browseDirectory', () => {
  it('lists directories with git markers, hides dotfolders unless asked, and reports the parent', () => {
    const listing = browseDirectory(join(root, 'src'), false, root)
    expect(listing.entries.map((e) => [e.name, e.isGitRepo])).toEqual([['plain', false], ['repo', true]])
    expect(listing.parentPath).toBe(root)
    expect(listing.pathIsGitRepo).toBe(false)
    expect(browseDirectory(join(root, 'src', 'repo'), false, root).pathIsGitRepo).toBe(true)
    expect(browseDirectory(join(root, 'src'), true, root).entries.map((e) => e.name)).toEqual(['.hidden', 'plain', 'repo'])
  })
  it('resolves ~ against the given home and refuses a non-directory', () => {
    expect(expandHome('~/src', root)).toBe(join(root, 'src'))
    expect(browseDirectory('~', false, root).path).toBe(root)
    expect(() => browseDirectory(join(root, 'src', 'file.txt'), false, root)).toThrow(/not a directory/)
  })
})
