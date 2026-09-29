import { describe, expect, it } from 'vitest'
import { qrSvgDataUrl } from '../pairing-qr'

const LINK = 'ion-studio://pair?code=0123456789abcdef0123456789abcdef&url=http%3A%2F%2Fstudio.local%3A7421&env=Studio'

function svgOf(dataUrl: string): string {
  return decodeURIComponent(dataUrl.replace('data:image/svg+xml;utf8,', ''))
}

describe('qrSvgDataUrl', () => {
  it('draws the text as a scalable SVG data URL', () => {
    const url = qrSvgDataUrl(LINK)
    expect(url.startsWith('data:image/svg+xml;utf8,')).toBe(true)
    const svg = svgOf(url)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('viewBox')
  })

  it('is a function of the text: the same link draws the same code, another link draws another', () => {
    expect(qrSvgDataUrl(LINK)).toBe(qrSvgDataUrl(LINK))
    expect(qrSvgDataUrl(LINK)).not.toBe(qrSvgDataUrl(LINK.replace('0123', '9999')))
  })

  it('holds a full pairing link with a relay channel and key', () => {
    const long = `${LINK}&relay=${encodeURIComponent('wss://relay.example.org/v1')}&channel=${'ab'.repeat(32)}&relayKey=${'k'.repeat(64)}`
    expect(() => qrSvgDataUrl(long)).not.toThrow()
  })
})
