import { afterEach, describe, expect, it, vi } from 'vitest'
import { darkColors } from '../../theme/palette-dark'

// Mock shiki so the highlighter is deterministic and spy-able. The mock
// tokenizes each line into one colored token so cache behavior is visible.
const codeToTokensBase = vi.fn((code: string) =>
  code.split('\n').map((line) => [{ content: line, color: '#AAAAAA' }]))
const loadLanguage = vi.fn(() => Promise.resolve())
const loadTheme = vi.fn(() => Promise.resolve())

vi.mock('shiki', () => ({
  createHighlighter: () => Promise.resolve({ codeToTokensBase, loadLanguage, loadTheme }),
}))

// Import after the mock so the module under test binds the mocked shiki.
import {
  __resetForTests, getCachedHighlight, highlightToTokens, langFromFence, plaintextTokens,
} from './codeHighlight'

afterEach(() => {
  __resetForTests()
  codeToTokensBase.mockClear()
  loadLanguage.mockClear()
  loadTheme.mockClear()
})

describe('langFromFence', () => {
  it('resolves extension tokens, full names, and aliases', () => {
    expect(langFromFence('ts')).toBe('typescript')
    expect(langFromFence('typescript')).toBe('typescript')
    expect(langFromFence('golang')).toBe('go')
    expect(langFromFence('zsh')).toBe('shell')
  })

  it('returns null for unknown or empty tokens', () => {
    expect(langFromFence('')).toBeNull()
    expect(langFromFence(undefined)).toBeNull()
    expect(langFromFence('notalanguage')).toBeNull()
  })
})

describe('highlightToTokens', () => {
  it('tokenizes identical (code, lang, palette) exactly once', async () => {
    const code = 'const x = 1\nconst y = 2'
    const first = await highlightToTokens(code, 'typescript', darkColors, 'dark')
    const second = await highlightToTokens(code, 'typescript', darkColors, 'dark')
    expect(codeToTokensBase).toHaveBeenCalledTimes(1)
    expect(second).toBe(first) // same cached array identity
  })

  it('exposes cache hits synchronously via getCachedHighlight', async () => {
    const code = 'let a = 1'
    expect(getCachedHighlight(code, 'typescript', darkColors)).toBeUndefined()
    const rows = await highlightToTokens(code, 'typescript', darkColors, 'dark')
    expect(getCachedHighlight(code, 'typescript', darkColors)).toBe(rows)
  })

  it('returns plaintext rows for a null language without touching shiki', async () => {
    const rows = await highlightToTokens('plain text', null, darkColors, 'dark')
    expect(rows).toEqual([[{ content: 'plain text' }]])
    expect(codeToTokensBase).not.toHaveBeenCalled()
  })

  it('never throws — a tokenizer failure degrades to plaintext', async () => {
    codeToTokensBase.mockImplementationOnce(() => { throw new Error('boom') })
    const rows = await highlightToTokens('x', 'typescript', darkColors, 'dark')
    expect(rows).toEqual([[{ content: 'x' }]])
  })

  it('registers the palette theme once across calls', async () => {
    await highlightToTokens('a', 'typescript', darkColors, 'dark')
    await highlightToTokens('b', 'typescript', darkColors, 'dark')
    expect(loadTheme).toHaveBeenCalledTimes(1)
  })
})

describe('plaintextTokens', () => {
  it('produces one single-token row per line', () => {
    expect(plaintextTokens('a\nb')).toEqual([[{ content: 'a' }], [{ content: 'b' }]])
  })
})
