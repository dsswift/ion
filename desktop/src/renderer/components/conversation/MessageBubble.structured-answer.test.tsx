// @vitest-environment jsdom
/**
 * MessageBubble — Guided Questions submission labelling.
 *
 * A submitted answer set is REAL operator input: they read the questions,
 * chose the options, typed the free text, attached the images. So it renders
 * in full. But they did not compose the rendered form as prose at the prompt,
 * and an unmarked bubble would misrepresent it as something they typed.
 *
 * The tag resolves that: the content is theirs and visible, while its origin
 * is stated. Same shape as the existing steer tag, which marks a mid-turn
 * steer without hiding it.
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

// InlineMessageImages lazily fetches image bytes through the bridge. The
// attachment test only asserts GROUPING, so a stub that never resolves is
// enough — and it keeps the assertion about layout rather than image loading.
// Assign the PROPERTY; replacing `window` wholesale breaks jsdom's document.
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

function userMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    role: 'user',
    content: 'My answers to "Scope":\n\n**Storage backend?**\n- Postgres',
    timestamp: Date.now(),
    ...overrides,
  } as Message
}

describe('MessageBubble — structured answer', () => {
  it('renders the submitted content AND the "Questions answered" label', () => {
    const el = render(<MessageBubble message={userMessage({ injectionKind: 'structured_answer' })} skipMotion />)

    // The operator's own answers stay visible — hiding them dropped work they
    // actually did.
    expect(el.textContent).toContain('Postgres')
    // ...and the turn is marked as arriving from the questions surface.
    expect(el.textContent).toContain('Questions answered')
  })

  it('hides legacy model-facing wrapper text from the card', () => {
    const content = [
      'My answers to "Scope":',
      '',
      '**Storage backend?**',
      '- Postgres',
      '',
      'I want more questions on this topic. Call AskUserQuestions again with workflowId "workflow-1" and a deeper page on the same theme. Do not move on until I submit a page without asking for more.',
    ].join('\n')
    const el = render(<MessageBubble message={userMessage({ content, injectionKind: 'structured_answer' })} skipMotion />)

    expect(el.textContent).toContain('Storage backend?')
    expect(el.textContent).toContain('Postgres')
    expect(el.textContent).not.toContain('My answers to')
    expect(el.textContent).not.toContain('Call AskUserQuestions again')
    expect(el.textContent).not.toContain('Do not move on')
  })

  it('wraps the turn in chrome that spans the transcript', () => {
    // A corner tag alone was not enough: at a glance the bubble still read as
    // an ordinary message. The row is marked and stretches, so the submission
    // is a distinct REGION rather than a right-aligned bubble.
    const el = render(<MessageBubble message={userMessage({ injectionKind: 'structured_answer' })} skipMotion />)

    const row = el.querySelector('[data-structured-answer="true"]')
    expect(row).not.toBeNull()
    expect(row?.className).not.toContain('justify-end')
  })

  it('the panel hugs its content instead of filling the row', () => {
    // A short answer in a full-width tinted box reads as a layout bug rather
    // than as grouping. The rules carry the boundary across the transcript;
    // the panel only owns the content, capped at the same 85% an ordinary
    // bubble uses so long answers wrap identically.
    const el = render(<MessageBubble message={userMessage({ injectionKind: 'structured_answer' })} skipMotion />)

    const panel = el.querySelector('[data-structured-answer="true"] .max-w-\\[85\\%\\]')
    expect(panel).not.toBeNull()
    expect(panel?.className).not.toContain('w-full')
  })

  it('drops the hover actions clear of the closing rule', () => {
    // The frame adds a rule beneath the bubble, and the default offset landed
    // the hover actions on top of it. They sit lower inside a frame, and the
    // row reserves the band they drop into so they never crowd the next turn.
    const el = render(<MessageBubble message={userMessage({ injectionKind: 'structured_answer' })} skipMotion />)

    const actions = el.querySelector('[data-structured-answer="true"] .absolute.right-0')
    expect(actions?.className).toContain('-bottom-8')
    expect(actions?.className).not.toContain('-bottom-5')
  })

  it('groups attachments inside the same frame as the answers', () => {
    // The images the operator attached belong to the submission; they must sit
    // inside the frame, not float above it as a separate turn.
    const el = render(
      <MessageBubble
        message={userMessage({
          injectionKind: 'structured_answer',
          attachments: [{ id: '/tmp/a.png', type: 'image', name: 'a.png', path: '/tmp/a.png' }],
        })}
        skipMotion
      />,
    )

    const row = el.querySelector('[data-structured-answer="true"]')
    expect(row?.textContent).toContain('Questions answered')
    expect(row?.textContent).toContain('Postgres')
  })

  it('an ordinary typed turn carries no chrome', () => {
    // The guard against over-labelling: only a structured submission is
    // framed, so the chrome stays meaningful. An ordinary turn keeps its
    // right-aligned bubble.
    const el = render(<MessageBubble message={userMessage()} skipMotion />)

    expect(el.textContent).toContain('Postgres')
    expect(el.textContent).not.toContain('Questions answered')
    expect(el.querySelector('[data-structured-answer="true"]')).toBeNull()
    expect(el.querySelector('.justify-end')).not.toBeNull()
    // An ordinary bubble keeps the tighter default offset.
    expect(el.querySelector('.absolute.right-0')?.className).toContain('-bottom-5')
  })

  it('does not label an unrelated injection kind', () => {
    const el = render(<MessageBubble message={userMessage({ injectionKind: 'revive' })} skipMotion />)

    expect(el.textContent).not.toContain('Questions answered')
  })
})
