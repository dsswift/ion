import { describe, expect, it } from 'vitest'
import { parseColor, scaleAlpha, withAlpha } from './color-alpha'

describe('parseColor', () => {
  it('parses every palette form', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseColor('#1a2b3c')).toEqual({ r: 26, g: 43, b: 60, a: 1 })
    expect(parseColor('#1a2b3c80')).toEqual({ r: 26, g: 43, b: 60, a: 128 / 255 })
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 })
    expect(parseColor('rgba(255, 255, 255, 0.16)')).toEqual({ r: 255, g: 255, b: 255, a: 0.16 })
  })

  it('returns null for an unknown form', () => {
    expect(parseColor('hsl(10, 20%, 30%)')).toBeNull()
    expect(parseColor('transparent')).toBeNull()
  })
})

describe('withAlpha', () => {
  it('replaces the alpha and keeps the channels', () => {
    expect(withAlpha('#ff0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)')
    expect(withAlpha('rgba(255, 255, 255, 0.16)', 1)).toBe('rgba(255, 255, 255, 1)')
  })

  it('clamps out-of-range alpha and treats NaN as opaque', () => {
    expect(withAlpha('#000', 2)).toBe('rgba(0, 0, 0, 1)')
    expect(withAlpha('#000', -1)).toBe('rgba(0, 0, 0, 0)')
    expect(withAlpha('#000', Number.NaN)).toBe('rgba(0, 0, 0, 1)')
  })

  it('leaves an unknown form untouched', () => {
    expect(withAlpha('hsl(10, 20%, 30%)', 0.5)).toBe('hsl(10, 20%, 30%)')
  })
})

describe('scaleAlpha', () => {
  it('multiplies the existing alpha rather than replacing it', () => {
    expect(scaleAlpha('rgba(255, 255, 255, 0.5)', 0.5)).toBe('rgba(255, 255, 255, 0.25)')
    expect(scaleAlpha('#ffffff', 0.25)).toBe('rgba(255, 255, 255, 0.25)')
  })
})
