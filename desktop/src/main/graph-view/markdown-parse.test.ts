/**
 * Tests for markdown-parse.ts (child 02, see specs/02-corpus-index.tests.md
 * TC-001..TC-006). Pure — no filesystem.
 */
import { describe, expect, it } from 'vitest'
import {
  extractMarkdownLinks,
  extractSections,
  extractWikiLinks,
  maskCode,
  parseFrontMatter,
  parseMarkdownDocument,
  splitFrontMatter,
} from './markdown-parse'

const STAT = { size: 100, mtimeMs: 1000 }

describe('TC-001: front matter recognition', () => {
  it('parses a simple front matter block', () => {
    const doc = parseMarkdownDocument('---\ntitle: A\n---\nbody', '/a.md', '/', STAT)
    expect(doc.frontMatter).toEqual({ title: 'A' })
    expect(doc.parseError).toBeUndefined()
  })

  it('a leading UTF-8 BOM before the opening --- still parses', () => {
    const doc = parseMarkdownDocument('\uFEFF---\ntitle: A\n---\nbody', '/a.md', '/', STAT)
    expect(doc.frontMatter).toEqual({ title: 'A' })
  })

  it('an empty block yields {} with no parseError', () => {
    const doc = parseMarkdownDocument('---\n---\n', '/a.md', '/', STAT)
    expect(doc.frontMatter).toEqual({})
    expect(doc.parseError).toBeUndefined()
  })

  it('a ... terminator works', () => {
    const doc = parseMarkdownDocument('---\ntitle: A\n...\nbody', '/a.md', '/', STAT)
    expect(doc.frontMatter).toEqual({ title: 'A' })
  })

  it('an unterminated fence yields {} with no parseError, whole text as body', () => {
    const { yaml, body } = splitFrontMatter('---\ntitle: A\nbody with no close')
    expect(yaml).toBeNull()
    expect(body).toBe('---\ntitle: A\nbody with no close')
  })

  it('a file whose first line is not --- yields {} with no parseError', () => {
    const doc = parseMarkdownDocument('# Title\nbody', '/a.md', '/', STAT)
    expect(doc.frontMatter).toEqual({})
    expect(doc.parseError).toBeUndefined()
  })

  it('front matter appearing after line 1 is ignored', () => {
    const { yaml } = splitFrontMatter('intro\n---\ntitle: A\n---\n')
    expect(yaml).toBeNull()
  })
})

describe('TC-002: front matter failure tolerance', () => {
  it('malformed YAML returns {} and a parseError, document still returned', () => {
    const doc = parseMarkdownDocument('---\na: [1, 2\n---\n', '/a.md', '/', STAT)
    expect(doc.frontMatter).toEqual({})
    expect(doc.parseError).toBeTruthy()
    expect(doc.path).toBe('/a.md')
    expect(doc.sizeBytes).toBe(100)
    expect(doc.modifiedMs).toBe(1000)
  })

  it('a sequence yields "front matter is not a mapping"', () => {
    const { bag, parseError } = parseFrontMatter('- a\n- b')
    expect(bag).toEqual({})
    expect(parseError).toBe('front matter is not a mapping')
  })

  it('a scalar yields the same parseError', () => {
    const { parseError } = parseFrontMatter('just a string')
    expect(parseError).toBe('front matter is not a mapping')
  })

  it('a duplicate key throws inside yaml, document still returned with parseError', () => {
    const doc = parseMarkdownDocument('---\na: 1\na: 2\n---\n', '/a.md', '/', STAT)
    expect(doc.parseError).toBeTruthy()
    expect(doc.path).toBe('/a.md')
  })
})

describe('TC-003: wikilink extraction', () => {
  it('[[alpha]] yields [alpha]', () => {
    expect(extractWikiLinks('[[alpha]]')).toEqual(['alpha'])
  })
  it('[[alpha|Display Name]] yields [alpha]', () => {
    expect(extractWikiLinks('[[alpha|Display Name]]')).toEqual(['alpha'])
  })
  it('[[alpha#Section Two]] yields verbatim target with suffix', () => {
    expect(extractWikiLinks('[[alpha#Section Two]]')).toEqual(['alpha#Section Two'])
  })
  it('[[ alpha ]] trims', () => {
    expect(extractWikiLinks('[[ alpha ]]')).toEqual(['alpha'])
  })
  it('preserves order and duplicates', () => {
    expect(extractWikiLinks('[[a]] [[b]] [[a]]')).toEqual(['a', 'b', 'a'])
  })
  it('[[]] and [[ | x ]] yield nothing', () => {
    expect(extractWikiLinks('[[]] [[ | x ]]')).toEqual([])
  })
  it('a wikilink split across two lines is not matched', () => {
    expect(extractWikiLinks('[[alpha\n]]')).toEqual([])
  })
})

describe('TC-004: markdown link extraction', () => {
  it('[x](./a.md) yields [./a.md]', () => {
    expect(extractMarkdownLinks('[x](./a.md)')).toEqual(['./a.md'])
  })
  it('[x](a.md#top) strips the anchor', () => {
    expect(extractMarkdownLinks('[x](a.md#top)')).toEqual(['a.md'])
  })
  it('a titled link strips the title', () => {
    expect(extractMarkdownLinks('[x](../notes/b.md "Title")')).toEqual(['../notes/b.md'])
  })
  it('a URL-scheme target is excluded', () => {
    expect(extractMarkdownLinks('[x](https://e.example/a.md)')).toEqual([])
  })
  it('a mailto target is excluded', () => {
    expect(extractMarkdownLinks('[x](mailto:user@example.org)')).toEqual([])
  })
  it('non-.md targets are excluded', () => {
    expect(extractMarkdownLinks('[x](./a.txt) [x](./dir/)')).toEqual([])
  })
  it('an image reference to a .md file IS extracted (pinned behavior)', () => {
    expect(extractMarkdownLinks('![alt](a.md)')).toEqual(['a.md'])
  })
})

describe('TC-005: code masking', () => {
  it('a wikilink inside a ``` fence is not extracted', () => {
    const masked = maskCode('```\n[[a]]\n```')
    expect(extractWikiLinks(masked)).toEqual([])
  })
  it('a wikilink inside a ~~~ fence is not extracted', () => {
    const masked = maskCode('~~~\n[[a]]\n~~~')
    expect(extractWikiLinks(masked)).toEqual([])
  })
  it('a fence opened with four backticks is only closed by four or more', () => {
    const masked = maskCode('````\n```\n[[a]]\n```\n````')
    expect(extractWikiLinks(masked)).toEqual([])
  })
  it('a wikilink inside an inline span is not extracted', () => {
    const masked = maskCode('`[[a]]`')
    expect(extractWikiLinks(masked)).toEqual([])
  })
  it('a markdown link inside a fence is not extracted', () => {
    const masked = maskCode('```\n[x](a.md)\n```')
    expect(extractMarkdownLinks(masked)).toEqual([])
  })
  it('a heading inside a fence does not become a section', () => {
    const masked = maskCode('```\n## Not A Section\n```')
    expect(extractSections(masked)).toEqual([])
  })
  it('text after the closing fence is still scanned', () => {
    const masked = maskCode('```\n[[hidden]]\n```\n[[visible]]')
    expect(extractWikiLinks(masked)).toEqual(['visible'])
  })
})

describe('TC-006: sections and labels', () => {
  it('## and ### are sections', () => {
    expect(extractSections('## Alpha\n### Beta')).toEqual(['Alpha', 'Beta'])
  })
  it('# Title (level 1) is not a section', () => {
    expect(extractSections('# Title')).toEqual([])
  })
  it('a closed ATX heading strips trailing #s', () => {
    expect(extractSections('## Alpha ##')).toEqual(['Alpha'])
  })
  it('fileName strips extension and preserves spaces', () => {
    const doc = parseMarkdownDocument('body', '/a/b/My Note.md', '/a/b', STAT)
    expect(doc.fileName).toBe('My Note')
  })
  it('fileName strip is case-insensitive on extension', () => {
    const doc = parseMarkdownDocument('body', '/a/b/Upper.MD', '/a/b', STAT)
    expect(doc.fileName).toBe('Upper')
  })
})
