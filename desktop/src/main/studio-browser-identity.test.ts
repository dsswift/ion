import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { userAgentFallback: '' }, session: { fromPartition: () => ({ setUserAgent: () => undefined }) } }))
vi.mock('./logger', () => ({ log: vi.fn() }))

import { chromeUserAgent } from './studio-browser-identity'

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

describe('chromeUserAgent', () => {
  it('drops the app and Electron tags Electron appends', () => {
    expect(chromeUserAgent(`${CHROME} Ion/1.82.0 Electron/35.7.5`)).toBe(CHROME)
    expect(chromeUserAgent(`${CHROME} ion-desktop/1.82.0-beta.1 Electron/35.7.5`)).toBe(CHROME)
  })

  it('keeps a plain Chrome agent as it is', () => {
    expect(chromeUserAgent(CHROME)).toBe(CHROME)
  })

  it('leaves an agent it does not recognise alone', () => {
    const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0'
    expect(chromeUserAgent(windows)).toBe(windows.slice(0, windows.indexOf(' Edg/')))
    expect(chromeUserAgent('Custom/1.0')).toBe('Custom/1.0')
    expect(chromeUserAgent(`${CHROME} something custom here`)).toBe(`${CHROME} something custom here`)
  })
})
