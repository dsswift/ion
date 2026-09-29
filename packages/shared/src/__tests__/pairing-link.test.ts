import { describe, expect, it } from 'vitest'
import { parsePairingLink, normalizeServerHttpBase } from '../pairing-link'

const CODE = '740d9128241659d5730b7aea7ed983de'

describe('parsePairingLink', () => {
  it('parses a server-minted link into code, url, and label', () => {
    const result = parsePairingLink(`ion-studio://pair?code=${CODE}&url=http%3A%2F%2Fgrover.local%3A7331&env=grover`)
    expect(result).toEqual({ ok: true, link: { code: CODE, url: 'http://grover.local:7331', label: 'grover' } })
  })

  it('tolerates surrounding whitespace and a trailing slash on the url', () => {
    const result = parsePairingLink(`  ion-studio://pair?code=${CODE}&url=https://lab.example.org/  `)
    expect(result).toEqual({ ok: true, link: { code: CODE, url: 'https://lab.example.org', label: '' } })
  })

  // The Nearby door builds its link around the short code a person read off
  // the other screen. Parsing it as a link is the step that once refused every
  // such pairing before the network was touched.
  it('accepts a short discovery code, dashed or not, in any case', () => {
    const base = 'url=http%3A%2F%2Fmac.local%3A7331&env=work'
    expect(parsePairingLink(`ion-studio://pair?code=FSSE-2S5J&${base}`)).toEqual({ ok: true, link: { code: 'FSSE2S5J', url: 'http://mac.local:7331', label: 'work' } })
    expect(parsePairingLink(`ion-studio://pair?code=fsse2s5j&${base}`)).toMatchObject({ ok: true, link: { code: 'FSSE2S5J' } })
  })

  it('still refuses a short code with a look-alike character or the wrong length', () => {
    const base = 'url=http%3A%2F%2Fmac.local%3A7331'
    expect(parsePairingLink(`ion-studio://pair?code=FSSE-2S5I&${base}`)).toMatchObject({ ok: false, reason: 'bad_code' })
    expect(parsePairingLink(`ion-studio://pair?code=FSSE-2S5&${base}`)).toMatchObject({ ok: false, reason: 'bad_code' })
  })

  it('names each failure', () => {
    expect(parsePairingLink('')).toMatchObject({ ok: false, reason: 'not_a_link' })
    expect(parsePairingLink('hello there')).toMatchObject({ ok: false, reason: 'not_a_link' })
    expect(parsePairingLink(`ion://pair?code=${CODE}&url=http://x`)).toMatchObject({ ok: false, reason: 'wrong_scheme' })
    expect(parsePairingLink('ion-studio://pair?url=http://x')).toMatchObject({ ok: false, reason: 'missing_code' })
    expect(parsePairingLink('ion-studio://pair?code=nope&url=http://x')).toMatchObject({ ok: false, reason: 'bad_code' })
    expect(parsePairingLink(`ion-studio://pair?code=${CODE}`)).toMatchObject({ ok: false, reason: 'missing_url' })
    expect(parsePairingLink(`ion-studio://pair?code=${CODE}&url=ws://x:1`)).toMatchObject({ ok: false, reason: 'bad_url' })
  })
})

describe('normalizeServerHttpBase', () => {
  it('accepts http and https, strips query, hash, and trailing slash', () => {
    expect(normalizeServerHttpBase('http://grover.local:7331/')).toBe('http://grover.local:7331')
    expect(normalizeServerHttpBase('https://ion.example.com/?x=1#f')).toBe('https://ion.example.com')
  })
  it('refuses non-http schemes and garbage', () => {
    expect(normalizeServerHttpBase('ws://x')).toBeNull()
    expect(normalizeServerHttpBase('not a url')).toBeNull()
  })
})
