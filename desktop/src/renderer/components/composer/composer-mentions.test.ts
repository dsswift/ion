import { describe, expect, it, vi } from 'vitest'

vi.mock('../../rendererLogger', () => ({ rWarn: vi.fn() }))

import { detectActiveMention, mentionInsertion, mentionedPaths, resolveMentionAttachments } from './composer-mentions'

describe('detectActiveMention', () => {
  it('finds the mention under the cursor with its range', () => {
    expect(detectActiveMention('see @src/al', 11)).toEqual({ from: 4, to: 11, query: 'src/al' })
    expect(detectActiveMention('@', 1)).toEqual({ from: 0, to: 1, query: '' })
  })
  it('ignores an @ inside a word, and a cursor that has left the mention', () => {
    expect(detectActiveMention('mail me@exa', 11)).toBeNull()
    expect(detectActiveMention('see @src/al more', 16)).toBeNull()
  })
  it('inserts a pick with a trailing space so the token ends', () => {
    expect(mentionInsertion('src/a.ts')).toBe('@src/a.ts ')
  })
})

describe('resolveMentionAttachments', () => {
  const describeFile = vi.fn(async (path: string) => (path.endsWith('gone.ts') ? null : { id: path, type: 'file' as const, name: 'x', path }))

  it('lists each mentioned path once', () => {
    expect(mentionedPaths('@a/b.ts and @a/b.ts and @c.md')).toEqual(['a/b.ts', 'c.md'])
  })

  it('attaches files that exist, skips ones already attached, reports the rest', async () => {
    const already = [{ id: '1', type: 'file' as const, name: 'c.md', path: '/work/c.md' }]
    const result = await resolveMentionAttachments('@a/b.ts @c.md @gone.ts', '/work', already, describeFile)
    expect(result.attachments.map((a) => a.path)).toEqual(['/work/a/b.ts'])
    expect(result.unresolved).toEqual(['gone.ts'])
    expect(describeFile).not.toHaveBeenCalledWith('/work/c.md')
  })
})
