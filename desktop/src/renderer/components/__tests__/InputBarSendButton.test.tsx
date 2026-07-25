// @vitest-environment jsdom
/**
 * Pins the SendButton interactive-state contract (desktop style guide):
 *
 * - disabled → `sendDisabled` background at 0.45 opacity, cursor default,
 *   and a fully inert click (onClick never fires).
 * - enabled hover → `sendHover` background; click fires onClick.
 * - enabled pressed → `accentPressed` background + scale(0.97).
 * - the button carries `.ion-focusable` for the keyboard focus ring.
 *
 * The component takes `colors` as a prop, so no theme wiring is needed —
 * distinct sentinel color keywords identify which token drove the style.
 * framer-motion is stubbed to plain pass-through elements so the render is
 * synchronous under act (matching StatusBarEngineState.test.tsx's approach
 * of stubbing everything that isn't the behavior under test).
 */

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  },
}))

import { SendButton } from '../InputBarSendButton'

// Sentinel keywords (valid CSS colors so jsdom's CSSOM keeps them verbatim).
const COLORS = {
  sendBg: 'blue',
  sendHover: 'green',
  sendDisabled: 'gray',
  accentPressed: 'purple',
  textOnAccent: 'white',
} as any

function render(props: { disabled?: boolean; onClick: () => void }) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <SendButton visible isBusy={false} colors={COLORS} disabled={props.disabled} onClick={props.onClick} />,
    )
  })
  const button = container.querySelector('button')!
  expect(button).toBeTruthy()
  return {
    button,
    cleanup: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

function fire(el: Element, type: string) {
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true }))
  })
}

describe('SendButton interactive states', () => {
  it('disabled: sendDisabled bg, 0.45 opacity, cursor default, click inert', () => {
    const onClick = vi.fn()
    const { button, cleanup } = render({ disabled: true, onClick })
    try {
      expect(button.disabled).toBe(true)
      expect(button.style.background).toBe('gray')
      expect(button.style.opacity).toBe('0.45')
      expect(button.style.cursor).toBe('default')
      fire(button, 'click')
      expect(onClick).not.toHaveBeenCalled()
      // Hover handlers are inert too: no sendHover swap while disabled.
      fire(button, 'mouseover')
      expect(button.style.background).toBe('gray')
    } finally {
      cleanup()
    }
  })

  it('enabled: hover applies sendHover and click fires', () => {
    const onClick = vi.fn()
    const { button, cleanup } = render({ onClick })
    try {
      expect(button.style.background).toBe('blue')
      expect(button.style.opacity).toBe('1')
      fire(button, 'mouseover')
      expect(button.style.background).toBe('green')
      fire(button, 'click')
      expect(onClick).toHaveBeenCalledTimes(1)
    } finally {
      cleanup()
    }
  })

  it('enabled: pressed applies accentPressed + scale(0.97), released on mouseup', () => {
    const onClick = vi.fn()
    const { button, cleanup } = render({ onClick })
    try {
      fire(button, 'mousedown')
      expect(button.style.background).toBe('purple')
      expect(button.style.transform).toBe('scale(0.97)')
      fire(button, 'mouseup')
      expect(button.style.background).toBe('blue')
      expect(button.style.transform).toBe('scale(1)')
    } finally {
      cleanup()
    }
  })

  it('carries the .ion-focusable keyboard-focus class', () => {
    const { button, cleanup } = render({ onClick: vi.fn() })
    try {
      expect(button.className).toContain('ion-focusable')
    } finally {
      cleanup()
    }
  })
})
