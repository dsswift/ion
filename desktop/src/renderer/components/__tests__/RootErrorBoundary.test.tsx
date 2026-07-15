// @vitest-environment jsdom
/**
 * RootErrorBoundary — catches render errors at the root level and shows a
 * reload prompt instead of propagating the uncaught throw.
 *
 * Tests:
 *   (a) A child that throws during render triggers the error fallback UI, not
 *       the child's own content.
 *   (b) rError is called with the error message so the event lands in
 *       desktop.jsonl as a structured ERROR line.
 *   (c) The fallback contains a "Reload" button (not "Retry") — re-rendering
 *       into an infinite loop would throw again; only reload recovers.
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Mock rendererLogger so rError is observable and never hits the missing
// contextBridge in the test environment.
const mockRError = vi.fn()
vi.mock('../../rendererLogger', () => ({
  rError: (...args: unknown[]) => mockRError(...args),
  rInfo: vi.fn(),
  rWarn: vi.fn(),
  rDebug: vi.fn(),
  rTrace: vi.fn(),
}))

import { RootErrorBoundary } from '../RootErrorBoundary'

// Suppress React's "An update to RootErrorBoundary inside a test was not
// wrapped in act(...)" noise and the intentional error boundary console.error
// that React emits during getDerivedStateFromError / componentDidCatch.
const originalError = globalThis.console.error
beforeEach(() => {
  globalThis.console.error = () => {}
  mockRError.mockClear()
})
afterEach(() => {
  globalThis.console.error = originalError
})

function BrokenChild(): React.JSX.Element {
  throw new Error('test render error')
}

describe('RootErrorBoundary', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    document.body.removeChild(container)
  })

  it('(a) renders fallback UI when a child throws, not the child content', async () => {
    await act(async () => {
      root.render(
        React.createElement(RootErrorBoundary, null,
          React.createElement(BrokenChild),
        ),
      )
    })

    // The child's own output never appears.
    expect(container.textContent).not.toContain('BrokenChild')
    // The fallback is rendered.
    expect(container.textContent).toContain('Something went wrong')
  })

  it('(b) calls rError with the error message so it lands in desktop.jsonl', async () => {
    await act(async () => {
      root.render(
        React.createElement(RootErrorBoundary, null,
          React.createElement(BrokenChild),
        ),
      )
    })

    expect(mockRError).toHaveBeenCalledWith(
      'root-error-boundary',
      'uncaught root render error',
      expect.objectContaining({ error: 'test render error' }),
    )
  })

  it('(c) fallback shows a Reload button, not Retry', async () => {
    await act(async () => {
      root.render(
        React.createElement(RootErrorBoundary, null,
          React.createElement(BrokenChild),
        ),
      )
    })

    const buttons = container.querySelectorAll('button')
    expect(buttons.length).toBe(1)
    expect(buttons[0].textContent).toBe('Reload')
    // Sanity: no "Retry" button exists.
    const retryButton = Array.from(buttons).find((b) => b.textContent === 'Retry')
    expect(retryButton).toBeUndefined()
  })
})
