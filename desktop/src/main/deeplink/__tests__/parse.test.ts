/**
 * Tests for `ion://` URL parsing and handoff-payload validation.
 *
 * The parser is the first thing an untrusted origin touches, so its refusals
 * are the tests that matter most: an unknown action, an over-long field, a
 * newline smuggled into a command, and above all a handoff id that is not a
 * UUID (that value becomes a filename, so a loose check is a path traversal).
 *
 * The equivalence test is the plan's stated contract for the two transports:
 * inline and handoff must normalize to the same payload, because that is what
 * lets each action be written once instead of once per transport.
 */

import { describe, it, expect } from 'vitest'
import { parseDeepLink, validateHandoffPayload, LIMITS } from '../parse'

describe('parseDeepLink — scheme and action', () => {
  it('parses a terminal request', () => {
    const r = parseDeepLink('ion://terminal?tabId=tab-a&title=api&cmd=npm%20run%20dev&dir=/repo')

    expect(r).toEqual({
      kind: 'ok',
      request: {
        payload: { action: 'terminal', tabId: 'tab-a', title: 'api', cmd: 'npm run dev', dir: '/repo' },
        token: '',
        transport: 'inline',
      },
    })
  })

  it('parses a prompt request, defaulting submit to true', () => {
    const r = parseDeepLink('ion://prompt?dir=/repo&text=hello')

    expect(r.kind).toBe('ok')
    expect(r.kind === 'ok' && r.request.payload).toEqual({
      action: 'prompt', dir: '/repo', text: 'hello', submit: true,
    })
  })

  it('honours submit=false', () => {
    const r = parseDeepLink('ion://prompt?dir=/repo&text=hello&submit=false')

    expect(r.kind === 'ok' && (r.request.payload as { submit: boolean }).submit).toBe(false)
  })

  it('tolerates the authority-less form some openers produce', () => {
    const r = parseDeepLink('ion:///terminal?tabId=tab-a')

    expect(r.kind).toBe('ok')
    expect(r.kind === 'ok' && r.request.payload.action).toBe('terminal')
  })

  it('is case-insensitive on the action', () => {
    expect(parseDeepLink('ion://TERMINAL?tabId=tab-a').kind).toBe('ok')
  })

  it('rejects a non-ion scheme', () => {
    const r = parseDeepLink('https://example.com/terminal?cmd=rm')

    expect(r).toEqual({ kind: 'error', reason: 'unexpected scheme https:' })
  })

  it('rejects an unknown action', () => {
    expect(parseDeepLink('ion://exfiltrate?x=1')).toEqual({
      kind: 'error', reason: 'unknown action exfiltrate',
    })
  })

  it('rejects a malformed url', () => {
    expect(parseDeepLink('not a url at all').kind).toBe('error')
  })

  it('rejects a prompt with no text', () => {
    expect(parseDeepLink('ion://prompt?dir=/repo')).toEqual({
      kind: 'error', reason: 'prompt requires text',
    })
  })

  it('carries a supplied token through without validating it', () => {
    // Validation is token.ts's job; the parser must not silently drop the field.
    const r = parseDeepLink('ion://terminal?tabId=tab-a&token=abc123')

    expect(r.kind === 'ok' && r.request.token).toBe('abc123')
  })
})

describe('parseDeepLink — hostile input', () => {
  it('rejects a field that exceeds its cap instead of truncating it', () => {
    const tooLong = 'x'.repeat(LIMITS.title + 1)
    const r = parseDeepLink(`ion://terminal?tabId=tab-a&title=${tooLong}`)

    expect(r.kind).toBe('error')
  })

  it('rejects an over-long command', () => {
    const r = parseDeepLink(`ion://terminal?tabId=tab-a&cmd=${'a'.repeat(LIMITS.cmd + 1)}`)

    expect(r.kind).toBe('error')
  })

  it('rejects a newline in a command (shell-injection carrier)', () => {
    const r = parseDeepLink('ion://terminal?tabId=tab-a&cmd=' + encodeURIComponent('ls\nrm -rf /'))

    expect(r.kind).toBe('error')
  })

  it('rejects an overlong capability token', () => {
    const r = parseDeepLink(`ion://terminal?tabId=tab-a&token=${'x'.repeat(LIMITS.token + 1)}`)

    expect(r).toEqual({ kind: 'error', reason: 'token rejected (too long or illegal characters)' })
  })

  it('rejects a NUL byte in a field', () => {
    const r = parseDeepLink('ion://terminal?tabId=' + encodeURIComponent('tab\0a'))

    expect(r.kind).toBe('error')
  })
})

describe('parseDeepLink — handoff id', () => {
  it('accepts a well-formed uuid', () => {
    const r = parseDeepLink('ion://prompt?req=123e4567-e89b-12d3-a456-426614174000')

    expect(r).toEqual({ kind: 'handoff', id: '123e4567-e89b-12d3-a456-426614174000' })
  })

  it('rejects a path-traversal id', () => {
    // The id becomes a filename. This is the case a loose check would let
    // escape ~/.ion/deeplink-requests entirely.
    const r = parseDeepLink('ion://prompt?req=' + encodeURIComponent('../../../../etc/passwd'))

    expect(r).toEqual({ kind: 'error', reason: 'handoff id is not a uuid' })
  })

  it('rejects a non-uuid id', () => {
    expect(parseDeepLink('ion://prompt?req=abc').kind).toBe('error')
  })

  it('takes precedence over inline params, so the file is the authority', () => {
    const r = parseDeepLink('ion://prompt?req=123e4567-e89b-12d3-a456-426614174000&text=ignored')

    expect(r.kind).toBe('handoff')
  })
})

describe('validateHandoffPayload', () => {
  it('accepts a terminal payload', () => {
    const r = validateHandoffPayload({ action: 'terminal', tabId: 'tab-a', title: 'api', cmd: 'npm start' })

    expect(r.kind).toBe('ok')
    expect(r.kind === 'ok' && r.payload).toEqual({
      action: 'terminal', tabId: 'tab-a', title: 'api', cmd: 'npm start', dir: '',
    })
  })

  it('normalizes to the SAME payload as the inline transport', () => {
    // The plan's contract: one action implementation serves both transports.
    const inline = parseDeepLink('ion://prompt?dir=/repo&text=hello')
    const handoff = validateHandoffPayload({ action: 'prompt', dir: '/repo', text: 'hello' })

    expect(handoff.kind === 'ok' && handoff.payload)
      .toEqual(inline.kind === 'ok' && inline.request.payload)
  })

  it('allows multi-line prompt text, which is the transport\'s purpose', () => {
    const r = validateHandoffPayload({ action: 'prompt', dir: '/repo', text: 'line one\nline two' })

    expect(r.kind).toBe('ok')
    expect(r.kind === 'ok' && (r.payload as { text: string }).text).toBe('line one\nline two')
  })

  it('still rejects a multi-line command', () => {
    // Multi-line prose is fine; a multi-line shell command is not, on either
    // transport. The file path must not be a way around that.
    const r = validateHandoffPayload({ action: 'terminal', tabId: 'tab-a', cmd: 'ls\nrm -rf /' })

    expect(r).toEqual({ kind: 'error', reason: 'handoff cmd must be single-line' })
  })

  it('enforces the same length caps as the inline transport', () => {
    const r = validateHandoffPayload({ action: 'prompt', dir: '/repo', text: 'x'.repeat(LIMITS.text + 1) })

    expect(r.kind).toBe('error')
  })

  it('rejects a non-string field', () => {
    expect(validateHandoffPayload({ action: 'terminal', tabId: { evil: true } }).kind).toBe('error')
  })

  it('rejects a non-object payload', () => {
    expect(validateHandoffPayload('just a string').kind).toBe('error')
    expect(validateHandoffPayload(null).kind).toBe('error')
  })

  it('rejects an unknown action', () => {
    expect(validateHandoffPayload({ action: 'rm-rf' }).kind).toBe('error')
  })
})
