import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readPlanContentCached, readPlanRangeCached, readPlanPreviewCached, __planCacheSize, __clearPlanCache } from '../plan-content-cache'

// Clean up temp files and cache state between tests.
const tempFiles: string[] = []

function makeTempFile(content: string): string {
  const filePath = path.join(os.tmpdir(), `plan-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}.md`)
  fs.writeFileSync(filePath, content, 'utf-8')
  tempFiles.push(filePath)
  return filePath
}

afterEach(() => {
  __clearPlanCache()
  for (const f of tempFiles) {
    try { fs.unlinkSync(f) } catch {}
  }
  tempFiles.length = 0
})

describe('readPlanContentCached', () => {
  it('cache hit avoids re-read: same content returned for unchanged mtime', () => {
    const content = 'This is the plan content.'
    const filePath = makeTempFile(content)

    const first = readPlanContentCached(filePath)
    const second = readPlanContentCached(filePath)

    expect(first).toBe(content)
    expect(second).toBe(content)
    // Both calls return the same object reference — cache served the second read.
    expect(first === second).toBe(true)
  })

  it('mtime bump invalidates the cache and returns new content', () => {
    const original = 'Original plan content'
    const updated = 'Updated plan content — different'
    const filePath = makeTempFile(original)

    // Prime the cache.
    expect(readPlanContentCached(filePath)).toBe(original)

    // Overwrite with new content and explicitly advance mtime by 1 second
    // to defeat OS timer resolution that may leave mtime unchanged.
    fs.writeFileSync(filePath, updated, 'utf-8')
    const future = new Date(Date.now() + 2000)
    fs.utimesSync(filePath, future, future)

    // Cache must be invalidated; new content returned.
    expect(readPlanContentCached(filePath)).toBe(updated)
  })

  it('size cap: large file is truncated with marker; small file is returned verbatim', () => {
    const CAP_BYTES = 256 * 1024

    // Large file: 300 KB of ASCII 'x' characters.
    const largeContent = 'x'.repeat(300 * 1024)
    const largePath = makeTempFile(largeContent)

    const result = readPlanContentCached(largePath)

    // Returned string must be bounded (truncated content + marker is within a generous overhead).
    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(CAP_BYTES + 200)

    // Must end with the truncation marker.
    expect(result).toMatch(/\u2026\[plan truncated: \d+ KB over 256 KB cap\]$/)

    // Small file: returned verbatim, no marker.
    const smallContent = 'Small plan — fits comfortably under the cap.'
    const smallPath = makeTempFile(smallContent)

    const smallResult = readPlanContentCached(smallPath)
    expect(smallResult).toBe(smallContent)
    expect(smallResult).not.toContain('truncated')
  })

  it('bounded eviction: cache stays at or below 8 entries after >8 distinct paths', () => {
    // Insert 12 distinct paths; cache must not exceed 8.
    for (let i = 0; i < 12; i++) {
      const filePath = makeTempFile(`plan content for file ${i}`)
      readPlanContentCached(filePath)
    }

    expect(__planCacheSize()).toBeLessThanOrEqual(8)
  })
})

describe('readPlanRangeCached', () => {
  it('returns correct byte window from offset 0', () => {
    const content = 'ABCDEFGHIJKLMNOP'
    const filePath = makeTempFile(content)
    const { window, totalBytes } = readPlanRangeCached(filePath, 0, 8)
    expect(window.toString('utf-8')).toBe('ABCDEFGH')
    expect(totalBytes).toBe(Buffer.byteLength(content, 'utf-8'))
  })

  it('returns correct byte window from mid-file offset', () => {
    const content = 'ABCDEFGHIJKLMNOP'
    const filePath = makeTempFile(content)
    const { window, totalBytes } = readPlanRangeCached(filePath, 4, 4)
    expect(window.toString('utf-8')).toBe('EFGH')
    expect(totalBytes).toBe(Buffer.byteLength(content, 'utf-8'))
  })

  it('last page: window is partial when offset+length exceeds totalBytes', () => {
    const content = 'Hello'
    const filePath = makeTempFile(content)
    const { window, totalBytes } = readPlanRangeCached(filePath, 3, 100)
    expect(window.toString('utf-8')).toBe('lo')
    expect(totalBytes).toBe(5)
  })

  it('successive windows reconstruct the full content', () => {
    const content = 'ABCDEFGHIJKLMNOP'
    const filePath = makeTempFile(content)
    const PAGE = 8
    const { window: w1, totalBytes } = readPlanRangeCached(filePath, 0, PAGE)
    const { window: w2 } = readPlanRangeCached(filePath, PAGE, PAGE)
    const reconstructed = Buffer.concat([w1, w2]).toString('utf-8')
    expect(reconstructed).toBe(content)
    expect(totalBytes).toBe(Buffer.byteLength(content, 'utf-8'))
  })

  it('shares cache with readPlanContentCached — same mtime entry reused', () => {
    const content = 'Shared cache test content'
    const filePath = makeTempFile(content)
    // Prime via readPlanContentCached
    readPlanContentCached(filePath)
    expect(__planCacheSize()).toBe(1)
    // readPlanRangeCached should reuse the same entry (cache stays at 1)
    readPlanRangeCached(filePath, 0, 10)
    expect(__planCacheSize()).toBe(1)
  })
})

describe('readPlanPreviewCached', () => {
  it('small file: preview = full content, truncated = false', () => {
    const content = 'Short plan content'
    const filePath = makeTempFile(content)
    const { preview, totalBytes, truncated } = readPlanPreviewCached(filePath, 4096)
    expect(preview).toBe(content)
    expect(totalBytes).toBe(Buffer.byteLength(content, 'utf-8'))
    expect(truncated).toBe(false)
  })

  it('large file: preview bounded to previewBytes, truncated = true', () => {
    // File larger than the 4KB preview
    const content = 'X'.repeat(10 * 1024)
    const filePath = makeTempFile(content)
    const PREVIEW = 4096
    const { preview, totalBytes, truncated } = readPlanPreviewCached(filePath, PREVIEW)
    expect(preview.length).toBeLessThanOrEqual(PREVIEW)
    expect(totalBytes).toBe(Buffer.byteLength(content, 'utf-8'))
    expect(truncated).toBe(true)
  })

  it('unbounded plan: 2MB file keeps snapshot payload bounded', () => {
    // Regression guard for perf #2: a multi-MB plan must not embed full body.
    const twoMB = 'A'.repeat(2 * 1024 * 1024)
    const filePath = makeTempFile(twoMB)
    const PREVIEW = 4096
    const { preview, totalBytes, truncated } = readPlanPreviewCached(filePath, PREVIEW)
    // Preview is small — snapshot stays bounded regardless of plan size
    expect(Buffer.byteLength(preview, 'utf-8')).toBeLessThanOrEqual(PREVIEW)
    expect(totalBytes).toBe(2 * 1024 * 1024)
    expect(truncated).toBe(true)
  })
})

