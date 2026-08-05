// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  CollapsibleUserBody, shouldCollapseUserMessage, FADE_MASK,
  MAX_COLLAPSED_USER_MESSAGE_LENGTH, MAX_COLLAPSED_USER_MESSAGE_LINES,
} from './CollapsibleUserBody'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

function render(el: React.ReactElement): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(el) })
  return container
}

afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  container?.remove()
  container = null
})

const LONG_TEXT = 'x'.repeat(MAX_COLLAPSED_USER_MESSAGE_LENGTH + 1)
const MANY_LINES = Array.from({ length: MAX_COLLAPSED_USER_MESSAGE_LINES + 1 }, (_, i) => `line ${i}`).join('\n')

describe('shouldCollapseUserMessage', () => {
  it('collapses past the char threshold or the line threshold', () => {
    expect(shouldCollapseUserMessage(LONG_TEXT)).toBe(true)
    expect(shouldCollapseUserMessage(MANY_LINES)).toBe(true)
  })

  it('leaves short messages alone (including whitespace-only)', () => {
    expect(shouldCollapseUserMessage('short message')).toBe(false)
    expect(shouldCollapseUserMessage('   \n  ')).toBe(false)
  })
})

describe('CollapsibleUserBody', () => {
  it('renders a short message unwrapped — no toggle, no mask', () => {
    const el = render(
      <CollapsibleUserBody text="short"><span>short</span></CollapsibleUserBody>,
    )
    expect(el.querySelector('button')).toBeNull()
    expect(el.querySelector('[data-user-message-collapsed]')).toBeNull()
  })

  it('renders a long message collapsed by default with the fade mask', () => {
    const el = render(
      <CollapsibleUserBody text={LONG_TEXT}><span>{LONG_TEXT}</span></CollapsibleUserBody>,
    )
    const body = el.querySelector('[data-user-message-collapsed="true"]') as HTMLElement
    expect(body).not.toBeNull()
    expect(body.style.maxHeight).toBe('11rem')
    expect(body.style.overflow).toBe('hidden')
    // jsdom's CSSOM drops mask-image, so the fade contract is pinned two
    // ways: the data attribute proving the collapsed branch applies it, and
    // the exported constant carrying the actual gradient.
    expect(body.getAttribute('data-user-message-fade')).toBe('true')
    expect(FADE_MASK).toContain('linear-gradient(to bottom')
    const toggle = el.querySelector('button')!
    expect(toggle.textContent).toBe('Show full message')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('toggle expands (mask removed) and collapses again', () => {
    const el = render(
      <CollapsibleUserBody text={MANY_LINES}><span>{MANY_LINES}</span></CollapsibleUserBody>,
    )
    const toggle = el.querySelector('button')!
    act(() => { toggle.click() })
    const body = el.querySelector('[data-user-message-collapsed="false"]') as HTMLElement
    expect(body).not.toBeNull()
    expect(body.style.maxHeight).toBe('')
    expect(toggle.textContent).toBe('Show less')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    act(() => { toggle.click() })
    expect(el.querySelector('[data-user-message-collapsed="true"]')).not.toBeNull()
  })

  it('keeps the full children in the DOM while collapsed (copy still yields full text)', () => {
    const el = render(
      <CollapsibleUserBody text={MANY_LINES}><span>{MANY_LINES}</span></CollapsibleUserBody>,
    )
    expect(el.querySelector('[data-user-message-collapsed="true"]')!.textContent).toBe(MANY_LINES)
  })
})
