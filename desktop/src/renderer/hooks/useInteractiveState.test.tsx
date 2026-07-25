// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useInteractiveState, interactiveBg, type InteractiveState } from './useInteractiveState'

let container: HTMLDivElement
let root: Root
let latest: InteractiveState

function Probe(): React.ReactElement {
  latest = useInteractiveState()
  return <button {...latest.handlers} />
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<Probe />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useInteractiveState', () => {
  it('starts idle', () => {
    expect(latest.hover).toBe(false)
    expect(latest.pressed).toBe(false)
  })

  it('tracks hover across enter/leave', () => {
    act(() => latest.handlers.onMouseEnter())
    expect(latest.hover).toBe(true)
    act(() => latest.handlers.onMouseLeave())
    expect(latest.hover).toBe(false)
  })

  it('tracks pressed across down/up', () => {
    act(() => latest.handlers.onMouseDown())
    expect(latest.pressed).toBe(true)
    act(() => latest.handlers.onMouseUp())
    expect(latest.pressed).toBe(false)
  })

  it('mouse-leave clears pressed (drag off the element and release)', () => {
    act(() => {
      latest.handlers.onMouseEnter()
      latest.handlers.onMouseDown()
    })
    expect(latest.pressed).toBe(true)
    act(() => latest.handlers.onMouseLeave())
    expect(latest.pressed).toBe(false)
    expect(latest.hover).toBe(false)
  })

  it('blur clears pressed', () => {
    act(() => latest.handlers.onMouseDown())
    act(() => latest.handlers.onBlur())
    expect(latest.pressed).toBe(false)
  })

  it('handlers identity is stable across re-renders', () => {
    const first = latest.handlers
    act(() => latest.handlers.onMouseEnter())
    expect(latest.handlers).toBe(first)
  })
})

describe('interactiveBg', () => {
  const tokens = {
    surfaceHover: 'hover-token',
    surfacePressed: 'pressed-token',
    surfaceSelected: 'selected-token',
  }

  it('cascades pressed > hover > selected > base', () => {
    expect(interactiveBg(tokens, { pressed: true, hover: true, selected: true })).toBe('pressed-token')
    expect(interactiveBg(tokens, { hover: true, selected: true })).toBe('hover-token')
    expect(interactiveBg(tokens, { selected: true })).toBe('selected-token')
    expect(interactiveBg(tokens, {})).toBe('transparent')
  })

  it('respects a custom base', () => {
    expect(interactiveBg(tokens, {}, 'base-token')).toBe('base-token')
  })
})
