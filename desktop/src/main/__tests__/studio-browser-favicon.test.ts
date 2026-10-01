import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ debug: vi.fn() }))

import { MAX_FAVICON_BYTES, pickFaviconCandidate, resolveFaviconDataUrl } from '../studio-browser-favicon'

function sessionReturning(body: Buffer, init: { status?: number; contentType?: string } = {}) {
  const fetch = vi.fn(async () => new Response(new Uint8Array(body), {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'image/png' },
  }))
  return { fetch }
}

describe('studio browser favicon', () => {
  it('picks the first fetchable candidate', () => {
    expect(pickFaviconCandidate(['chrome://x', 'https://example.org/a.ico', 'data:image/png;base64,AA'])).toBe('https://example.org/a.ico')
    expect(pickFaviconCandidate(['chrome://x'])).toBe('')
  })

  it('turns a network icon into a data URL fetched through the guest session', async () => {
    const session = sessionReturning(Buffer.from([1, 2, 3]), { contentType: 'image/x-icon' })
    const result = await resolveFaviconDataUrl(session, 'https://example.org/favicon.ico')

    expect(session.fetch).toHaveBeenCalledWith('https://example.org/favicon.ico', expect.anything())
    expect(result).toBe(`data:image/x-icon;base64,${Buffer.from([1, 2, 3]).toString('base64')}`)
  })

  it('passes a data icon through without fetching', async () => {
    const session = sessionReturning(Buffer.alloc(0))
    expect(await resolveFaviconDataUrl(session, 'data:image/png;base64,AA')).toBe('data:image/png;base64,AA')
    expect(session.fetch).not.toHaveBeenCalled()
  })

  it('returns empty for a failed, non-image, or oversized response', async () => {
    const url = 'https://example.org/favicon.ico'
    expect(await resolveFaviconDataUrl(sessionReturning(Buffer.from([1]), { status: 404 }), url)).toBe('')
    expect(await resolveFaviconDataUrl(sessionReturning(Buffer.from('<html>'), { contentType: 'text/html' }), url)).toBe('')
    expect(await resolveFaviconDataUrl(sessionReturning(Buffer.alloc(MAX_FAVICON_BYTES + 1)), url)).toBe('')
    expect(await resolveFaviconDataUrl({ fetch: vi.fn(async () => { throw new Error('offline') }) }, url)).toBe('')
  })
})
