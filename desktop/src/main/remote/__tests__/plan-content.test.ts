/**
 * Tests for handleRequestPlanContent.
 *
 * Uses the disk-fallback path by setting state.mainWindow to null so the
 * renderer executeJavaScript path is skipped. This lets us test the file
 * I/O logic in isolation without an Electron environment.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Hoist the mock before any module imports so the state module is intercepted.
vi.mock('../../state', () => ({
  state: { mainWindow: null, remoteTransport: null },
}))

// After mocking state, import the handler and state.
import { handleRequestPlanContent } from '../handlers/plan-content'
import { state } from '../../state'
import { __clearPlanCache } from '../plan-content-cache'

const tempFiles: string[] = []

function makeTempFile(content: string | Buffer, ext = '.md'): string {
  const filePath = path.join(
    os.tmpdir(),
    `plan-content-test-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
  )
  if (Buffer.isBuffer(content)) {
    fs.writeFileSync(filePath, content)
  } else {
    fs.writeFileSync(filePath, content, 'utf-8')
  }
  tempFiles.push(filePath)
  return filePath
}

function captureResponses(): { sent: any[] } {
  const sent: any[] = []
  ;(state as any).remoteTransport = {
    sendToDevice: (_deviceId: string, event: any) => { sent.push(event) },
  }
  return { sent }
}

afterEach(() => {
  __clearPlanCache()
  ;(state as any).remoteTransport = null
  for (const f of tempFiles) {
    try { fs.unlinkSync(f) } catch {}
  }
  tempFiles.length = 0
})

describe('handleRequestPlanContent — paged fetch (disk fallback)', () => {
  it('returns first page with correct window and hasMore=true for multi-page file', async () => {
    // 128 KB file, page size 64 KB → hasMore=true on first page
    const content = 'A'.repeat(128 * 1024)
    const filePath = makeTempFile(content)
    const { sent } = captureResponses()

    await handleRequestPlanContent(
      { type: 'desktop_request_plan_content', tabId: 'tab1', questionId: 'q1', planFilePath: filePath, offset: 0, length: 64 * 1024 },
      'device1',
    )

    expect(sent).toHaveLength(1)
    const resp = sent[0]
    expect(resp.type).toBe('desktop_plan_content')
    expect(resp.questionId).toBe('q1')
    expect(resp.planFilePath).toBe(filePath)
    expect(resp.offset).toBe(0)
    expect(resp.totalBytes).toBe(128 * 1024)
    expect(resp.hasMore).toBe(true)
    expect(resp.content.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(resp.content, 'utf-8')).toBeLessThanOrEqual(64 * 1024)
  })

  it('returns last page with hasMore=false', async () => {
    const content = 'B'.repeat(100 * 1024)
    const filePath = makeTempFile(content)
    const { sent } = captureResponses()

    // Request page 2 starting at 64KB — only 36KB remain
    await handleRequestPlanContent(
      { type: 'desktop_request_plan_content', tabId: 'tab1', questionId: 'q2', planFilePath: filePath, offset: 64 * 1024, length: 64 * 1024 },
      'device1',
    )

    expect(sent).toHaveLength(1)
    const resp = sent[0]
    expect(resp.hasMore).toBe(false)
    expect(resp.totalBytes).toBe(100 * 1024)
    // Window is the remaining 36KB
    expect(Buffer.byteLength(resp.content, 'utf-8')).toBe(36 * 1024)
  })

  it('two pages reconstruct the full content exactly', async () => {
    const content = 'Hello world! '.repeat(5000)  // ~65 KB
    const filePath = makeTempFile(content)
    const PAGE = 64 * 1024
    const { sent } = captureResponses()

    await handleRequestPlanContent(
      { type: 'desktop_request_plan_content', tabId: 't', questionId: 'q', planFilePath: filePath, offset: 0, length: PAGE },
      'dev',
    )
    const totalBytes = sent[0].totalBytes
    const part1 = sent[0].content

    sent.length = 0
    await handleRequestPlanContent(
      { type: 'desktop_request_plan_content', tabId: 't', questionId: 'q', planFilePath: filePath, offset: PAGE, length: PAGE },
      'dev',
    )
    const part2 = sent[0].content

    // Concatenating both parts gives back the original UTF-8 content
    const reconstructed = part1 + part2
    expect(reconstructed).toBe(content)
    expect(Buffer.byteLength(content, 'utf-8')).toBe(totalBytes)
  })

  it('file not found: sends empty response with hasMore=false', async () => {
    const { sent } = captureResponses()

    await handleRequestPlanContent(
      { type: 'desktop_request_plan_content', tabId: 't', questionId: 'q3', planFilePath: '/nonexistent/plan.md', offset: 0, length: 0 },
      'dev',
    )

    expect(sent).toHaveLength(1)
    expect(sent[0].content).toBe('')
    expect(sent[0].totalBytes).toBe(0)
    expect(sent[0].hasMore).toBe(false)
  })

  it('unbounded plan (2 MB): single page stays bounded at 64 KB', async () => {
    // Regression test for perf #2: a multi-MB plan must not create a giant wire payload.
    const twoMB = 'Z'.repeat(2 * 1024 * 1024)
    const filePath = makeTempFile(twoMB)
    const { sent } = captureResponses()

    await handleRequestPlanContent(
      { type: 'desktop_request_plan_content', tabId: 't', questionId: 'q4', planFilePath: filePath, offset: 0, length: 0 },
      'dev',
    )

    expect(sent).toHaveLength(1)
    const resp = sent[0]
    // Single page capped at DEFAULT_PAGE_BYTES (64 KB)
    expect(Buffer.byteLength(resp.content, 'utf-8')).toBeLessThanOrEqual(64 * 1024)
    expect(resp.totalBytes).toBe(2 * 1024 * 1024)
    expect(resp.hasMore).toBe(true)
  })

  it('length=0 defaults to 64 KB page', async () => {
    const content = 'C'.repeat(128 * 1024)
    const filePath = makeTempFile(content)
    const { sent } = captureResponses()

    await handleRequestPlanContent(
      { type: 'desktop_request_plan_content', tabId: 't', questionId: 'q5', planFilePath: filePath, offset: 0, length: 0 },
      'dev',
    )

    expect(sent[0].hasMore).toBe(true)
    // Window is at most 64 KB
    expect(Buffer.byteLength(sent[0].content, 'utf-8')).toBeLessThanOrEqual(64 * 1024)
  })
})
