/**
 * Tests for remarkPreserveUserWhitespace — the AST half of "a user message
 * renders exactly as typed".
 *
 * These run the plugin through the same pipeline react-markdown uses
 * (remark-parse + remark-gfm) and assert on the resulting mdast, because that is
 * where the whitespace either survives or does not. The paired rendering
 * assertions (pre-wrap scoping, no phantom blank lines) live in
 * MessageBubble.test.tsx.
 *
 * The cases that matter most are the NEGATIVE ones: a blockquote's `> ` marker
 * and a list item's `- ` marker must never leak into restored text, and a fenced
 * block must stay a code block. Those are what a naive "re-read the source line"
 * implementation gets wrong.
 */
import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Root, Paragraph, Code, Text as MdastText, Blockquote, List } from 'mdast'
import { remarkPreserveUserWhitespace, VERBATIM_DATA_ATTR } from './remarkPreserveUserWhitespace'

function parse(source: string): Root {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkPreserveUserWhitespace)
  const tree = processor.parse(source)
  return processor.runSync(tree, { value: source } as never) as Root
}

/** The first paragraph's single text value. */
function firstText(tree: Root): string {
  const paragraph = tree.children.find((c) => c.type === 'paragraph') as Paragraph | undefined
  const text = paragraph?.children.find((c) => c.type === 'text') as MdastText | undefined
  return text?.value ?? ''
}

function isMarked(node: { data?: unknown } | undefined): boolean {
  const data = node?.data as { hProperties?: Record<string, unknown> } | undefined
  return data?.hProperties?.[VERBATIM_DATA_ATTR] === 'true'
}

describe('remarkPreserveUserWhitespace — newlines', () => {
  it('keeps the newline of a soft break', () => {
    expect(firstText(parse('line one\nline two'))).toBe('line one\nline two')
  })

  it('marks a multi-line paragraph so the renderer can scope pre-wrap to it', () => {
    const tree = parse('line one\nline two')
    expect(isMarked(tree.children[0])).toBe(true)
  })

  it('does not mark a single-line paragraph', () => {
    const tree = parse('just one line')
    expect(isMarked(tree.children[0])).toBe(false)
  })
})

describe('remarkPreserveUserWhitespace — blank lines between blocks', () => {
  it('reconstructs every blank source line discarded by CommonMark', () => {
    const tree = parse('alpha\n\n\nbeta\n\n\n\ngamma')
    expect(tree.children.map((child) => child.type)).toEqual([
      'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph',
    ])
    const gaps = [tree.children[1], tree.children[3]].map((node) => {
      const data = node.data as { hProperties?: Record<string, unknown> } | undefined
      return data?.hProperties?.['data-ion-blank-lines']
    })
    expect(gaps).toEqual([2, 3])
  })

  it('adds no synthetic gap for adjacent source lines in one paragraph', () => {
    const tree = parse('alpha\nbeta')
    expect(tree.children).toHaveLength(1)
  })

  it('adds one gap unit for one blank source line', () => {
    const tree = parse('alpha\n\nbeta')
    const data = tree.children[1].data as { hProperties?: Record<string, unknown> }
    expect(data.hProperties?.['data-ion-blank-lines']).toBe(1)
  })
})

describe('remarkPreserveUserWhitespace — indentation', () => {
  it('restores a two-space continuation indent the block parser stripped', () => {
    // Without the plugin the value is "line one\nline two\nindented" — the two
    // spaces are gone from the AST entirely.
    const value = firstText(parse('line one\nline two\n  indented continuation'))
    expect(value).toBe('line one\nline two\n  indented continuation')
  })

  it('restores deep indentation (a pasted log line)', () => {
    const value = firstText(parse('trace:\n      at frame one\n      at frame two'))
    expect(value).toBe('trace:\n      at frame one\n      at frame two')
  })

  it('preserves a mid-line run of spaces', () => {
    expect(firstText(parse('col a    col b'))).toBe('col a    col b')
  })

  it('leaves the first line un-indented (block indentation is not content)', () => {
    const value = firstText(parse('  leading block indent\n  second line'))
    // The first line's own indent is the block's; only continuations are restored.
    expect(value.startsWith('leading')).toBe(true)
  })
})

describe('remarkPreserveUserWhitespace — container markers never leak', () => {
  it('does not inject a blockquote marker into a continuation line', () => {
    const tree = parse('> quoted one\n>   quoted two')
    const quote = tree.children[0] as Blockquote
    const paragraph = quote.children[0] as Paragraph
    const value = (paragraph.children[0] as MdastText).value
    expect(value).not.toContain('>')
    expect(value.split('\n')[0]).toBe('quoted one')
  })

  it('does not inject a list marker into a continuation line', () => {
    const tree = parse('- item text\n  continuation')
    const list = tree.children[0] as List
    const paragraph = list.children[0].children[0] as Paragraph
    const value = (paragraph.children[0] as MdastText).value
    expect(value).not.toContain('-')
    expect(value.split('\n')[0]).toBe('item text')
  })

  it('marks the inner paragraph of a blockquote, never the blockquote itself', () => {
    const tree = parse('> quoted one\n> quoted two')
    const quote = tree.children[0] as Blockquote
    expect(isMarked(quote)).toBe(false)
    expect(isMarked(quote.children[0])).toBe(true)
  })
})

describe('remarkPreserveUserWhitespace — code blocks', () => {
  it('converts an indented run to a verbatim paragraph, spaces intact', () => {
    const tree = parse('prose line\n\n    four space indented\n    second line\n')
    // Not a code node any more — an indented run in a paste is accidental
    // alignment, not an intentional code block.
    expect(tree.children.some((c) => c.type === 'code')).toBe(false)
    const converted = tree.children.find((child) => {
      if (child.type !== 'paragraph') return false
      const data = child.data as { hProperties?: Record<string, unknown> } | undefined
      return data?.hProperties?.['data-ion-blank-lines'] === undefined &&
        (child.children[0] as MdastText | undefined)?.value.startsWith('    four')
    }) as Paragraph | undefined
    expect(converted).toBeDefined()
    const value = (converted!.children[0] as MdastText).value
    expect(value).toBe('    four space indented\n    second line')
    expect(isMarked(converted)).toBe(true)
  })

  it('leaves a fenced block as a code node with its language and inner indent', () => {
    const tree = parse('```sh\n  keep me\n```\n')
    const code = tree.children[0] as Code
    expect(code.type).toBe('code')
    expect(code.lang).toBe('sh')
    expect(code.value).toBe('  keep me')
  })

  it('leaves a tilde-fenced block as a code node', () => {
    const tree = parse('~~~\nplain fence\n~~~\n')
    expect((tree.children[0] as Code).type).toBe('code')
  })
})

describe('remarkPreserveUserWhitespace — the reported paste', () => {
  // The console transcript from the bug report: hard-wrapped lines with blank
  // lines between paragraphs. Every newline must survive.
  const TRANSCRIPT = [
    'λ ssh josh@192.168.86.166',
    'Linux hass-debian 6.1.0-51-amd64 #1 SMP PREEMPT_DYNAMIC Debian 6.1.177-1',
    '',
    'The programs included with the Debian GNU/Linux system are free software;',
    'the exact distribution terms for each program are described in the',
    'individual files in /usr/share/doc/*/copyright.',
  ].join('\n')

  it('keeps every hard-wrapped newline in the pasted transcript', () => {
    const tree = parse(TRANSCRIPT)
    const paragraphs = tree.children.filter((child) => {
      if (child.type !== 'paragraph') return false
      const data = child.data as { hProperties?: Record<string, unknown> } | undefined
      return data?.hProperties?.['data-ion-blank-lines'] === undefined
    }) as Paragraph[]
    // Two paragraphs (the blank line is a real paragraph break), and the second
    // keeps both of its internal newlines rather than reflowing to one line.
    expect(paragraphs).toHaveLength(2)
    const second = (paragraphs[1].children[0] as MdastText).value
    expect(second.split('\n')).toHaveLength(3)
    expect(paragraphs.every((p) => isMarked(p))).toBe(true)
  })
})
