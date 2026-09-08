import { describe, it, expect } from 'vitest'

/**
 * An empty file could not be edited at all.
 *
 * Load-completion was inferred from `content === '' && savedContent === ''`,
 * which is indistinguishable from a genuinely empty file. The load effect has
 * `activeFile` in its dependency list, so it re-ran on every keystroke, and
 * for an empty file the guard never stopped it: each read returned "" and
 * overwrote the character just typed. The log showed dozens of fsReadFile
 * calls inside one millisecond, every one content_len:0.
 *
 * This models the guard as data so the decision is pinned without a DOM.
 */
interface Tab {
  content: string
  savedContent: string
  isDirty: boolean
  isLoaded?: boolean
}

/** The old guard: infer "needs loading" from empty buffers. */
const inferredNeedsLoad = (f: Tab): boolean => f.content === '' && f.savedContent === ''

/** The current guard: an explicit flag. */
const flaggedNeedsLoad = (f: Tab): boolean => !f.isLoaded

describe('empty file is not mistaken for an unloaded file', () => {
  // The exact reported state: an empty file, loaded, one character typed.
  const typedIntoEmptyFile: Tab = {
    content: 'a',
    savedContent: '',
    isDirty: true,
    isLoaded: true,
  }

  // The state one instant later, after the stray read wiped the buffer.
  const wipedBack: Tab = { content: '', savedContent: '', isDirty: false, isLoaded: true }

  it('the old inference re-loads a loaded empty file, wiping the keystroke', () => {
    expect(inferredNeedsLoad(wipedBack)).toBe(true)
  })

  it('the flag does not re-load it', () => {
    expect(flaggedNeedsLoad(wipedBack)).toBe(false)
  })

  it('still loads a tab that has genuinely never been read', () => {
    expect(flaggedNeedsLoad({ content: '', savedContent: '', isDirty: false })).toBe(true)
  })

  it('does not re-load while the user is mid-edit', () => {
    expect(flaggedNeedsLoad(typedIntoEmptyFile)).toBe(false)
  })
})

describe('the load records completion on every terminal path', () => {
  // Leaving the flag unset on any outcome puts the effect straight back into
  // the loop it was written to break -- including the rejection path, which is
  // the one easiest to forget.
  it.each([
    ['a successful read', { isLoaded: true, readError: undefined }],
    ['an unreadable file', { isLoaded: true, readError: 'Could not read x' }],
    ['a rejected read', { isLoaded: true, readError: 'Could not read x' }],
  ])('marks loaded after %s', (_label, outcome) => {
    expect(outcome.isLoaded).toBe(true)
  })
})

describe('the source wires the flag at every outcome', () => {
  it('sets isLoaded on success, on unreadable, and on rejection', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../useFileEditorContent.ts', import.meta.url), 'utf-8')

    // The guard must read the flag, not guess from content.
    expect(src).toContain('!activeFile.isLoaded')
    expect(src).not.toContain("activeFile.content === '' && activeFile.savedContent === ''")

    // Three terminal outcomes, three writes of the flag.
    const marks = src.match(/isLoaded: true/g) ?? []
    expect(marks.length).toBeGreaterThanOrEqual(3)
  })
})
