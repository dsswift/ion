/**
 * webview-policy scheme allowlist + preview-partition unlock rules (D6).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  session: { fromPartition: vi.fn(() => ({ webRequest: { onBeforeRequest: vi.fn() } })) },
}))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { _schemeAllowed, allowPreviewNetwork, _resetPreviewUnlocks } from '../webview-policy'

beforeEach(() => {
  _resetPreviewUnlocks()
})

describe('webview scheme allowlist', () => {
  it('permits https, http, file, and about:blank', () => {
    expect(_schemeAllowed('https://example.org')).toBe(true)
    expect(_schemeAllowed('http://localhost:3000')).toBe(true)
    expect(_schemeAllowed('file:///repo/page.html')).toBe(true)
    expect(_schemeAllowed('about:blank')).toBe(true)
  })

  it('refuses everything else', () => {
    expect(_schemeAllowed('javascript:alert(1)')).toBe(false)
    expect(_schemeAllowed('data:text/html,<script>1</script>')).toBe(false)
    expect(_schemeAllowed('chrome://settings')).toBe(false)
    expect(_schemeAllowed('about:config')).toBe(false)
    expect(_schemeAllowed('ion://terminal')).toBe(false)
  })

  it('empty src attaches blank (navigation gates later)', () => {
    expect(_schemeAllowed('')).toBe(true)
  })
})

describe('preview partition unlock', () => {
  it('accepts only studio-preview partitions', () => {
    expect(allowPreviewNetwork('studio-preview-abc')).toBe(true)
    expect(allowPreviewNetwork('persist:studio-browser')).toBe(false)
    expect(allowPreviewNetwork('persist:studio-preview-abc')).toBe(false)
    expect(allowPreviewNetwork('')).toBe(false)
  })
})
