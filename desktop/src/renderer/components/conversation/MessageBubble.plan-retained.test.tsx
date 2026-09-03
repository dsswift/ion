// @vitest-environment jsdom
/**
 * MessageBubble — `/clear --keep-plan` retained-plan labelling.
 *
 * The retained plan is engine-authored (the operator did not type this exact
 * turn), but the operator's own `--keep-plan` action produced it, and its
 * content is the operator's own plan. So it renders in full rather than being
 * hidden, framed the same way a Guided Questions submission is: the content
 * is real and visible, its origin is stated.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('../../rendererLogger', () => ({
  rTrace: vi.fn(), rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(),
}))

import { MessageBubble } from './MessageBubble'
import type { Message } from '../../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

;(window as unknown as { ion: unknown }).ion = {
  readImageDataUrl: () => new Promise(() => {}),
}

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

function planRetainedMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    role: 'user',
    content:
      'The conversation history was cleared to start fresh, but this plan was kept so the work continues from it. Plan: fix-widget.\n\n# Plan\n\nDo the first thing.',
    injectionKind: 'plan_retained',
    timestamp: Date.now(),
    ...overrides,
  } as Message
}

describe('MessageBubble — plan retained', () => {
  it('renders the retained plan markdown AND the "Plan retained" label', () => {
    const el = render(<MessageBubble message={planRetainedMessage()} skipMotion />)

    // The retained plan text stays visible — hiding it left the divider as
    // the only evidence the retention happened.
    expect(el.textContent).toContain('Do the first thing')
    expect(el.textContent).toContain('Plan retained')
  })

  it('wraps the turn in chrome that spans the transcript', () => {
    const el = render(<MessageBubble message={planRetainedMessage()} skipMotion />)

    const row = el.querySelector('[data-plan-retained="true"]')
    expect(row).not.toBeNull()
    expect(row?.className).not.toContain('justify-end')
  })

  it('does not also carry the structured-answer marker', () => {
    const el = render(<MessageBubble message={planRetainedMessage()} skipMotion />)

    expect(el.querySelector('[data-structured-answer="true"]')).toBeNull()
  })

  it('an ordinary typed turn carries no plan-retained chrome', () => {
    const el = render(
      <MessageBubble message={planRetainedMessage({ injectionKind: undefined })} skipMotion />,
    )

    expect(el.textContent).not.toContain('Plan retained')
    expect(el.querySelector('[data-plan-retained="true"]')).toBeNull()
  })
})
