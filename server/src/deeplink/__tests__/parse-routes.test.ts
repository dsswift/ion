/**
 * The navigation and extension routes, and the link builders a client copies
 * from. Every builder must produce a URL this parser accepts and decodes back
 * to the same values; a copied link that the server refuses is a dead link.
 */
import { describe, it, expect } from 'vitest'
import { conversationLink, extLink, fileLink, httpsLink, ionUrlFromOpenPath, promptLink, settingsLink } from '@ion/shared/deeplink-url'
import { parseDeepLink, LIMITS } from '../parse'

function payloadOf(url: string): unknown {
  const r = parseDeepLink(url)
  if (r.kind !== 'ok') throw new Error(`refused ${url}: ${r.kind === 'error' ? r.reason : r.kind}`)
  return r.request.payload
}

describe('builders round-trip through the parser', () => {
  it('conversation', () => {
    expect(payloadOf(conversationLink('1791-abc_def.1'))).toEqual({ action: 'conversation', id: '1791-abc_def.1' })
  })
  it('settings', () => {
    expect(payloadOf(settingsLink('git-access'))).toEqual({ action: 'settings', panel: 'git-access' })
  })
  it('file, with spaces and a relative path', () => {
    expect(payloadOf(fileLink('/repo dir', 'src/a b.ts'))).toEqual({ action: 'file', dir: '/repo dir', path: 'src/a b.ts' })
  })
  it('prompt, with submit=false', () => {
    expect(payloadOf(promptLink('/repo', 'hi & bye', false))).toEqual({ action: 'prompt', dir: '/repo', text: 'hi & bye', submit: false })
  })
  it('ext, with every option', () => {
    expect(payloadOf(extLink('triage', { args: '42 --fast', conversationId: 'c1', dir: '/repo' }))).toEqual({
      action: 'ext', routeId: 'triage', args: '42 --fast', conversation: 'c1', dir: '/repo',
    })
  })
  it('the https form maps back to the same ion:// url', () => {
    const ion = extLink('triage', { args: 'x' })
    const https = httpsLink(ion, 'https://studio.example.org/')!
    expect(https).toBe('https://studio.example.org/open/ext/triage?args=x')
    const u = new URL(https)
    expect(ionUrlFromOpenPath(u.pathname, u.search)).toBe(ion)
    expect(ionUrlFromOpenPath('/settings', '')).toBeNull()
  })
})

describe('route refusals', () => {
  it('refuses a conversation id that could leave the conversations dir', () => {
    expect(parseDeepLink('ion://conversation?id=../etc/passwd').kind).toBe('error')
  })
  it('refuses an empty conversation id', () => {
    expect(parseDeepLink('ion://conversation').kind).toBe('error')
  })
  it('refuses a settings panel with path characters', () => {
    expect(parseDeepLink('ion://settings?panel=a/b').kind).toBe('error')
  })
  it('refuses a file link without a dir', () => {
    expect(parseDeepLink('ion://file?path=a.ts').kind).toBe('error')
  })
  it('refuses an ext route id outside the pattern', () => {
    expect(parseDeepLink('ion://ext/bad%20id').kind).toBe('error')
    expect(parseDeepLink('ion://ext/').kind).toBe('error')
  })
  it('refuses over-long ext args', () => {
    expect(parseDeepLink(`ion://ext/x?args=${'a'.repeat(LIMITS.args + 1)}`).kind).toBe('error')
  })
  it('accepts the triple-slash ext form some openers produce', () => {
    expect(payloadOf('ion:///ext/triage?args=1')).toEqual({ action: 'ext', routeId: 'triage', args: '1', conversation: '', dir: '' })
  })
})
