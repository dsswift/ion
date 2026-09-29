import { describe, it, expect } from 'vitest'
import { localEnvironmentLabel } from '../types-environments'

describe('localEnvironmentLabel', () => {
  it('names a Mac a Mac and everything else a PC', () => {
    expect(localEnvironmentLabel('darwin')).toBe('This Mac')
    expect(localEnvironmentLabel('win32')).toBe('This PC')
    expect(localEnvironmentLabel('linux')).toBe('This PC')
  })

  it('keeps the historical label when no platform is known', () => {
    expect(localEnvironmentLabel(undefined)).toBe('This Mac')
  })
})
