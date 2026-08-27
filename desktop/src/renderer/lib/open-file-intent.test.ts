import { describe, expect, it } from 'vitest'
import { fileOpenIntent, isFileNavigationClick, isRenderableHtml } from './open-file-intent'

describe('file navigation gesture', () => {
  it('requires cmd or ctrl', () => {
    // A plain click must stay a plain click: text selection and ordinary
    // interaction cannot start opening files.
    expect(isFileNavigationClick({})).toBe(false)
    expect(isFileNavigationClick(null)).toBe(false)
    expect(isFileNavigationClick({ shiftKey: true })).toBe(false)
    expect(isFileNavigationClick({ metaKey: true })).toBe(true)
    expect(isFileNavigationClick({ ctrlKey: true })).toBe(true)
  })
})

describe('open intent', () => {
  it('defaults to viewing', () => {
    expect(fileOpenIntent({ metaKey: true })).toBe('view')
  })

  it('reads source with shift', () => {
    // ⇧⌘ is the ONLY way to see HTML markup once ⌘ renders it, which is why
    // it gets a gesture rather than being an accidental default.
    expect(fileOpenIntent({ metaKey: true, shiftKey: true })).toBe('source')
  })

  it('goes native with alt', () => {
    // Matches ⌥⌘ on a web link: "not in Ion, in my own application."
    expect(fileOpenIntent({ metaKey: true, altKey: true })).toBe('native')
  })

  it('prefers native when shift and alt are both held', () => {
    // A chord meaning two opposite things is a coin flip otherwise. "Leave
    // Ion" is the stronger claim, and stating it here beats letting whichever
    // branch runs first decide.
    expect(fileOpenIntent({ metaKey: true, shiftKey: true, altKey: true })).toBe('native')
  })
})

describe('renderable html', () => {
  it('matches both html extensions, case-insensitively', () => {
    expect(isRenderableHtml('/tmp/a.html')).toBe(true)
    expect(isRenderableHtml('/tmp/a.htm')).toBe(true)
    expect(isRenderableHtml('/tmp/A.HTML')).toBe(true)
  })

  it('rejects everything else', () => {
    // .md and .txt render nowhere; they belong in the editor.
    expect(isRenderableHtml('/tmp/a.md')).toBe(false)
    expect(isRenderableHtml('/tmp/a.txt')).toBe(false)
    expect(isRenderableHtml('/tmp/htmlfile')).toBe(false)
    // A path merely CONTAINING .html is not an html file.
    expect(isRenderableHtml('/tmp/a.html.bak')).toBe(false)
  })
})
