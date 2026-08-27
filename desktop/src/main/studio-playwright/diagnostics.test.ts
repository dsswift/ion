import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import {
  compileFilter,
  consoleLevelOf,
  filterNetwork,
  formatConsole,
  formatNetworkList,
  includesLevel,
  redactHeaders,
  redactUrl,
  type NetworkEntry,
} from './diagnostics'

function entry(overrides: Partial<NetworkEntry>): NetworkEntry {
  return {
    index: 1,
    epoch: 0,
    method: 'GET',
    url: 'https://example.test/api',
    resourceType: 'fetch',
    status: 200,
    statusText: 'OK',
    failure: null,
    durationMs: 12,
    request: {} as NetworkEntry['request'],
    ...overrides,
  }
}

describe('console levels', () => {
  it('maps playwright console types onto the four levels', () => {
    expect(consoleLevelOf('error')).toBe('error')
    expect(consoleLevelOf('assert')).toBe('error')
    expect(consoleLevelOf('warning')).toBe('warning')
    expect(consoleLevelOf('trace')).toBe('debug')
    expect(consoleLevelOf('log')).toBe('info')
  })

  it('includes more severe levels at each threshold', () => {
    // "Show me warnings" must include errors; an agent asking for warnings and
    // being shown none while the page is throwing would be actively misleading.
    expect(includesLevel('warning', 'error')).toBe(true)
    expect(includesLevel('warning', 'warning')).toBe(true)
    expect(includesLevel('warning', 'info')).toBe(false)
    expect(includesLevel('debug', 'info')).toBe(true)
  })

  it('summarises totals and says when the view is filtered', () => {
    const output = formatConsole({
      entries: [{ level: 'error', text: 'boom', url: 'https://example.test/a.js', line: 4, column: 9 }],
      total: 5,
      errors: 1,
      warnings: 2,
    }, 'error')
    expect(output).toContain('Total 5 console message(s): 1 error(s), 2 warning(s).')
    expect(output).toContain('Returning 1 message(s) at level "error"')
    expect(output).toContain('[error] boom @ https://example.test/a.js:4:9')
  })
})

describe('network filtering', () => {
  it('hides only successful static assets by default', () => {
    const entries = [
      entry({ index: 1, resourceType: 'stylesheet' }),
      entry({ index: 2, resourceType: 'fetch' }),
      // A broken image is exactly what someone is looking for, so a failing
      // static asset stays visible even when static assets are hidden.
      entry({ index: 3, resourceType: 'image', status: 404, statusText: 'Not Found' }),
    ]
    expect(filterNetwork(entries, false, null).map((item) => item.index)).toEqual([2, 3])
    expect(filterNetwork(entries, true, null).map((item) => item.index)).toEqual([1, 2, 3])
  })

  it('keeps indices stable through filtering', () => {
    const entries = [entry({ index: 7, url: 'https://example.test/a' }), entry({ index: 8, url: 'https://other.test/b' })]
    const filtered = filterNetwork(entries, true, /other/)
    // The index an agent reads in the list must be the index that resolves in
    // browser_network_request, even when the list was filtered.
    expect(filtered.map((item) => item.index)).toEqual([8])
  })

  it('rejects an invalid regular expression with a clear reason', () => {
    expect(compileFilter('[unclosed').error).toContain('not a valid regular expression')
    expect(compileFilter('ok').pattern).toBeInstanceOf(RegExp)
    expect(compileFilter(undefined).pattern).toBeNull()
    expect(compileFilter('').pattern).toBeNull()
  })

  it('redacts credential query parameters in the list view', () => {
    // The list is what an agent reads first and most often, so a token left in
    // a URL here leaks even when the detail view is clean.
    const shown = [entry({ index: 1, url: 'https://example.test/cb?code=keep&access_token=SUPERSECRET' })]
    const output = formatNetworkList(shown, 1, true)
    expect(output).not.toContain('SUPERSECRET')
    expect(output).toContain('code=keep')
  })

  it('filters on the real URL, not the redacted one', () => {
    // Redaction happens at render time; a filter must still match what the
    // page actually requested.
    const entries = [entry({ index: 1, url: 'https://example.test/a?access_token=SECRET' })]
    expect(filterNetwork(entries, true, /access_token=SECRET/)).toHaveLength(1)
  })

  it('formats successes, failures, and the hidden-static note', () => {
    const shown = [
      entry({ index: 1, method: 'POST', url: 'https://example.test/login', status: 302, statusText: 'Found' }),
      entry({ index: 2, status: null, statusText: '', failure: 'net::ERR_CONNECTION_REFUSED' }),
    ]
    const output = formatNetworkList(shown, 5, false)
    expect(output).toContain('1. [POST] https://example.test/login => [302] Found')
    expect(output).toContain('2. [GET] https://example.test/api => [FAILED] net::ERR_CONNECTION_REFUSED')
    expect(output).toContain('3 successful static resource request(s) hidden')
  })
})

describe('redaction', () => {
  it('redacts credential headers but keeps the rest readable', () => {
    const lines = redactHeaders({
      authorization: 'Bearer secret-token',
      cookie: 'session=abc',
      'content-type': 'application/json',
    })
    expect(lines).toContain('authorization: [redacted]')
    expect(lines).toContain('cookie: [redacted]')
    expect(lines).toContain('content-type: application/json')
  })

  it('redacts token-bearing query parameters', () => {
    const redacted = redactUrl('https://example.test/cb?code=keep&access_token=secret')
    expect(redacted).toContain('code=keep')
    expect(redacted).toContain('access_token=%5Bredacted%5D')
    expect(redacted).not.toContain('secret')
  })

  it('leaves a malformed URL untouched rather than throwing', () => {
    expect(redactUrl('not a url')).toBe('not a url')
  })
})
