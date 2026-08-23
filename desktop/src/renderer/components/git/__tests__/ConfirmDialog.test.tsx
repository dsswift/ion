// @vitest-environment jsdom
//
// ConfirmDialog — the pending state and the single-action shape.
//
// ── Why the primitive is tested rather than the call site ────────────────────
// `busy` and `acknowledge` are properties of the dialog, not of Retire. Its call
// sites share this component; pinning the behaviour here is what stops the next
// one from hand-rolling a local version, which is exactly the drift that
// `useOutsideDismiss` was extracted to kill.
//
// What is pinned:
//   - busy disables EVERY button
//   - a busy backdrop click does not call onCancel
//   - a busy Escape does not call onCancel
//   - busyLabel renders, so a running operation is visible and not inferred
//   - acknowledge renders exactly one button, defaulting to "OK"
//
// Regression direction: drop the `busy` guard from the Escape effect and
// "a busy Escape does not dismiss" goes red; drop `!acknowledge` from the cancel
// button and "acknowledge renders one button" goes red.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Mock } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))

import { ConfirmDialog } from '../ConfirmDialog'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
let onConfirm: Mock<() => void>
let onCancel: Mock<() => void>

function render(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}): void {
  act(() => {
    root.render(
      <ConfirmDialog
        title="Retire this worktree?"
        message="It holds 1 uncommitted file."
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...props}
      />,
    )
  })
}

function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll('button')] as HTMLButtonElement[]
}

function button(label: string): HTMLButtonElement {
  const match = buttons().find((b) => b.textContent?.trim() === label)
  if (!match) throw new Error(`no button labelled "${label}"; saw: ${buttons().map((b) => b.textContent).join(' | ')}`)
  return match
}

beforeEach(() => {
  onConfirm = vi.fn<() => void>()
  onCancel = vi.fn<() => void>()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('ConfirmDialog — busy', () => {
  it('keeps the dialog inside the viewport with scrollable content', () => {
    render({ message: 'A long result '.repeat(100) })

    const backdrop = document.querySelector('[data-testid="confirm-dialog-backdrop"]') as HTMLElement
    const dialog = document.querySelector('[data-ion-ui]') as HTMLElement
    expect(backdrop.style.padding).toBe('16px')
    expect(backdrop.style.boxSizing).toBe('border-box')
    expect(dialog.style.maxWidth).toBe('100%')
    expect(dialog.style.maxHeight).toBe('100%')
    expect(dialog.style.minWidth).toBe('0px')
    expect(dialog.style.overflowY).toBe('auto')
  })

  it('disables every button while busy', () => {
    render({ confirmLabel: 'Retire', cancelLabel: 'Keep it', alternateLabel: 'Settle', onAlternate: vi.fn(), busy: true })

    expect(button('Retire').disabled).toBe(true)
    expect(button('Keep it').disabled).toBe(true)
    expect(button('Settle').disabled).toBe(true)
  })

  it('leaves both buttons live when not busy', () => {
    render({ confirmLabel: 'Retire', cancelLabel: 'Keep it' })

    expect(button('Retire').disabled).toBe(false)
    expect(button('Keep it').disabled).toBe(false)

    act(() => { button('Retire').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('does not dismiss on a backdrop click while busy', () => {
    render({ busy: true })

    const backdrop = document.querySelector('[data-ion-confirm]')!
    act(() => { backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(onCancel).not.toHaveBeenCalled()
  })

  it('still dismisses on a backdrop click when not busy', () => {
    render()

    const backdrop = document.querySelector('[data-ion-confirm]')!
    act(() => { backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('does not dismiss on Escape while busy', () => {
    render({ busy: true })

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(onCancel).not.toHaveBeenCalled()
  })

  it('still dismisses on Escape when not busy', () => {
    render()

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('renders the busy label so the running operation is visible', () => {
    render({ busy: true, busyLabel: 'Retiring the worktree…' })

    expect(document.querySelector('[data-testid="confirm-dialog-busy"]')).not.toBeNull()
    expect(document.body.textContent ?? '').toContain('Retiring the worktree…')
  })

  it('renders no busy row when not busy', () => {
    render({ busyLabel: 'Retiring the worktree…' })

    expect(document.querySelector('[data-testid="confirm-dialog-busy"]')).toBeNull()
    expect(document.body.textContent ?? '').not.toContain('Retiring the worktree…')
  })
})

describe('ConfirmDialog — acknowledge', () => {
  it('renders exactly one button, defaulted to OK', () => {
    render({ title: 'Retire', message: 'Retired. Work preserved to refs/ion/recovery/x.', acknowledge: true })

    expect(buttons()).toHaveLength(1)
    expect(buttons()[0].textContent?.trim()).toBe('OK')
  })

  it('honours an explicit confirmLabel under acknowledge', () => {
    render({ acknowledge: true, confirmLabel: 'Got it' })

    expect(buttons()).toHaveLength(1)
    expect(buttons()[0].textContent?.trim()).toBe('Got it')
  })

  it('can put initial keyboard focus on the safe cancel action', () => {
    render({ confirmLabel: 'Delete', danger: true, initialFocus: 'cancel' })

    expect(document.activeElement).toBe(button('Cancel'))
  })

  it('renders three distinct choices when an alternate action is supplied', () => {
    const onAlternate = vi.fn()
    render({
      confirmLabel: 'Delete Conversation',
      alternateLabel: 'Settle Conversation',
      onAlternate,
    })

    expect(buttons().map((item) => item.textContent?.trim())).toEqual([
      'Cancel', 'Settle Conversation', 'Delete Conversation',
    ])
    const dialog = document.querySelector('[data-ion-ui]') as HTMLElement
    const actionRow = button('Cancel').parentElement as HTMLElement
    expect(dialog.style.width).toBe('400px')
    expect(actionRow.style.flexWrap).toBe('nowrap')
    expect(buttons().every((item) => item.style.whiteSpace === 'nowrap')).toBe(true)
    act(() => { button('Settle Conversation').click() })
    expect(onAlternate).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('renders two buttons without acknowledge', () => {
    render({ confirmLabel: 'Retire', cancelLabel: 'Keep it' })

    expect(buttons()).toHaveLength(2)
  })

  it('keeps Escape wired under acknowledge — dismissing a result is harmless', () => {
    render({ acknowledge: true })

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
