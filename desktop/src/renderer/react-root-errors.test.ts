import { describe, expect, it, vi } from 'vitest'

const { error, warn, debug } = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('./rendererLogger', () => ({
  rError: error,
  rWarn: warn,
  rDebug: debug,
}))

import { rootErrorOptions } from './react-root-errors'

describe('rootErrorOptions', () => {
  it('logs root surface and compact component stack for uncaught scheduler errors', () => {
    const options = rootErrorOptions('studio')

    options.onUncaughtError(new Error('Maximum update depth exceeded'), {
      componentStack: '\n    at StudioShell\n    at PopoverLayerProvider',
    })

    expect(error).toHaveBeenCalledWith('react-root', 'uncaught react error', {
      surface: 'studio',
      error: 'Maximum update depth exceeded',
      component_stack: 'StudioShell < PopoverLayerProvider',
    })
  })

  it('keeps caught and recoverable errors distinct from uncaught failures', () => {
    const options = rootErrorOptions('overlay')

    options.onCaughtError(new Error('boundary failure'), { componentStack: '' })
    options.onRecoverableError(new Error('recoverable failure'), { componentStack: '' })

    expect(warn).toHaveBeenCalledWith('react-root', 'boundary-caught react error', expect.objectContaining({ surface: 'overlay' }))
    expect(debug).toHaveBeenCalledWith('react-root', 'recoverable react error', expect.objectContaining({ surface: 'overlay' }))
  })
})
