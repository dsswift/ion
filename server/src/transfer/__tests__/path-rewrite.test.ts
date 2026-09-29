/**
 * The path rewrite changes exactly the mapped paths and nothing else.
 */
import { describe, expect, it } from 'vitest'
import { mapPath, rewriteJsonText, rewriteJsonValue, type PathMap } from '../path-rewrite'

const map: PathMap = {
  files: new Map([['/src/plans/calm-fox.md', '/dst/conversations/c1/plans/calm-fox.md'], ['C:\\src\\x.md', 'D:\\dst\\x.md']]),
  dirs: new Map([['/src/conversations/', '/dst/conversations/'], ['/src/', '/elsewhere/']]),
}

describe('path rewrite', () => {
  it('rewrites a file path only at a name boundary', () => {
    const text = JSON.stringify({ a: '/src/plans/calm-fox.md', b: '/src/plans/calm-fox.md.bak' })
    const out = JSON.parse(rewriteJsonText(text, map).text)
    expect(out.a).toBe('/dst/conversations/c1/plans/calm-fox.md')
    // Not a match for the file; the shorter directory prefix still applies.
    expect(out.b).toBe('/elsewhere/plans/calm-fox.md.bak')
  })

  it('prefers the longest match and never rewrites a replacement', () => {
    const text = JSON.stringify({ p: '/src/conversations/c1/plans/a.md' })
    expect(JSON.parse(rewriteJsonText(text, map).text).p).toBe('/dst/conversations/c1/plans/a.md')
  })

  it('matches a Windows path in its escaped form', () => {
    const text = JSON.stringify({ w: 'C:\\src\\x.md' })
    expect(JSON.parse(rewriteJsonText(text, map).text).w).toBe('D:\\dst\\x.md')
  })

  it('leaves every other byte as it was', () => {
    const text = '{"meta":true,"id":"c1",  "note":"é — nothing here"}\n'
    const result = rewriteJsonText(text, map)
    expect(result.replaced).toBe(0)
    expect(result.text).toBe(text)
  })

  it('rewrites values and maps single paths', () => {
    expect(rewriteJsonValue({ attachments: [{ path: '/src/plans/calm-fox.md' }] }, map).value.attachments[0].path).toBe('/dst/conversations/c1/plans/calm-fox.md')
    expect(mapPath('/src/conversations/c1.llm.jsonl', map)).toBe('/dst/conversations/c1.llm.jsonl')
    expect(mapPath('/other/file', map)).toBe('/other/file')
  })
})
