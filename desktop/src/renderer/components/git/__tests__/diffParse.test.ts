import { describe, it, expect } from 'vitest'
import { parseDiffWithHunks, buildHunkPatch, buildPartialLinePatch } from '../diffParse'

const SAMPLE = `diff --git a/foo.ts b/foo.ts
index 1111..2222 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,4 +1,5 @@
 line one
-line two
+line two changed
+line three
 line four
@@ -10,3 +11,2 @@
 ten
-eleven
 twelve
`

describe('parseDiffWithHunks', () => {
  it('extracts file header + hunks', () => {
    const p = parseDiffWithHunks(SAMPLE)
    expect(p.fileHeader.length).toBe(4)
    expect(p.hunks.length).toBe(2)
    expect(p.hunks[0].oldStart).toBe(1)
    expect(p.hunks[0].newStart).toBe(1)
    expect(p.lines.filter((l) => l.type === 'add').length).toBe(2)
    expect(p.lines.filter((l) => l.type === 'remove').length).toBe(2)
  })
})

describe('buildHunkPatch', () => {
  it('emits the file header + only the requested hunk + a trailing newline', () => {
    const p = parseDiffWithHunks(SAMPLE)
    const patch = buildHunkPatch(p, 0)!
    expect(patch).toContain('diff --git a/foo.ts b/foo.ts')
    expect(patch).toMatch(/@@ -1,\d+ \+1,\d+ @@/)
    expect(patch).not.toContain('-eleven')
    expect(patch.endsWith('\n')).toBe(true)
  })
})

describe('buildPartialLinePatch', () => {
  it('drops unselected add lines and demotes unselected removes to context', () => {
    const p = parseDiffWithHunks(SAMPLE)
    const addLine = p.lines.find((l) => l.type === 'add' && l.content === 'line three')!
    const patch = buildPartialLinePatch(p, 0, new Set([addLine.rawIndex]))!
    expect(patch).toContain('+line three')
    expect(patch).not.toContain('+line two changed')
    expect(patch).toContain(' line two')
  })
})
