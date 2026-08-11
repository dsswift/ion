// @vitest-environment jsdom
/**
 * Regression test for the right-aligned user bubble overflowing past the
 * conversation pane's LEFT edge.
 *
 * Root cause (the bug this pins): `MessageBubble` renders the bubble column as
 * a flex item (`inline-flex … max-w-[85%]`) inside a `flex justify-end` row.
 * A flex item defaults to `min-width: auto`, so a long unbreakable token makes
 * the item's intrinsic min-width exceed the 85% cap; `justify-end` then anchors
 * the right edge and pushes the overflow off the LEFT of the pane. The fix is
 * flex-shrink containment:
 *
 *   1. `min-w-0` on the bubble-column wrapper so `max-w-[85%]` is honored.
 *   2. `min-w-0 overflow-hidden` on the inner `.prose-cloud` div so the markdown
 *      wraps inside the bubble (the `.prose-cloud` CSS already sets
 *      `overflow-wrap: break-word; word-break: break-word`, which only takes
 *      effect once the container is allowed to shrink).
 *
 * This test renders a user message with a long unbreakable token and asserts
 * BOTH containment seams are present. Reverting either class change drops the
 * asserted class and turns this test red — that is the regression guard.
 *
 * The assertions read the produced className strings (the stable layout
 * contract), not computed geometry: jsdom does not lay out flexbox, so a
 * pixel-position assertion would be meaningless here. The class contract is the
 * right seam — it is exactly what the fix changes.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MessageBubble } from '../MessageBubble'
import type { Message } from '../../../../shared/types'

// React requires this flag set before any act() call so it knows the test
// environment is an act-aware one. Without it React logs a warning on every
// render even though the render itself succeeds.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Stub window.ion so useImageDataUrl (InlineMessageImages) doesn't crash when
// content contains [Attached image: ...] markers — those trigger a readImageDataUrl
// IPC call that doesn't exist in the test environment.
beforeAll(() => {
  ;(globalThis as any).window = globalThis
  ;(globalThis as any).window.ion = {
    readImageDataUrl: () => Promise.resolve({ dataUrl: null }),
    openExternal: () => {},
    getFavicon: () => Promise.resolve(null),
  }
  // TableScrollWrapper (shared with AssistantMessage) observes its scroller to
  // decide the fade mask. jsdom ships no ResizeObserver, so a markdown table in
  // a user bubble would throw on mount without this.
  ;(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

const LONG_UNBREAKABLE =
  'https://example.com/' + 'a'.repeat(400) + '/path/that/never/wraps?q=' + 'z'.repeat(200)

function userMessage(content: string, fields: Partial<Message> = {}): Message {
  return { id: 'm1', role: 'user', content, timestamp: 0, ...fields }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderBubble(message: Message): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(React.createElement(MessageBubble, { message, skipMotion: true }))
  })
  return container
}

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  container?.remove()
  container = null
})

// ─── Attachment marker stripping ───

describe('MessageBubble — attachment marker stripping', () => {
  it('strips [Attached image: path] markers from display content', () => {
    const el = renderBubble(userMessage('[Attached image: /some/path/photo.png]\n\nhello world'))
    // The marker must not appear in any text node; only the user text should be visible.
    expect(el.textContent).not.toContain('[Attached image:')
    expect(el.textContent).toContain('hello world')
  })

  it('strips [Attached file: path] markers from display content', () => {
    const el = renderBubble(userMessage('[Attached file: /some/path/doc.pdf]\n\nhello world'))
    expect(el.textContent).not.toContain('[Attached file:')
    expect(el.textContent).toContain('hello world')
  })

  it('strips [Attachment: name (content attached)] markers from display content (post-encode form)', () => {
    // This is the form encodeAttachments writes into the engine-persisted prompt.
    // On reload the stored content contains this marker; it must not appear in the bubble.
    const el = renderBubble(userMessage('[Attachment: ion-paste-123456.png (content attached)]\n\nhello world'))
    expect(el.textContent).not.toContain('[Attachment:')
    expect(el.textContent).not.toContain('content attached')
    expect(el.textContent).toContain('hello world')
  })

  it('strips multiple attachment markers (one of each kind)', () => {
    const content = [
      '[Attached image: /path/a.png]',
      '[Attachment: b.jpeg (content attached)]',
      '',
      'the actual message',
    ].join('\n')
    const el = renderBubble(userMessage(content))
    expect(el.textContent).not.toContain('[Attached image:')
    expect(el.textContent).not.toContain('[Attachment:')
    expect(el.textContent).toContain('the actual message')
  })

  it('renders nothing when content is only an attachment marker', () => {
    const el = renderBubble(userMessage('[Attachment: photo.png (content attached)]'))
    // displayContent trims to empty string → bubble does not render the text div.
    const prose = el.querySelector('.prose-cloud')
    expect(prose).toBeNull()
  })
})

describe('MessageBubble — slash model provenance', () => {
  it('renders configured slash model as a separate attachment-style pill', () => {
    const el = renderBubble(userMessage('/align review changes', {
      slashCommand: '/align',
      slashArgs: 'review changes',
      slashModelAlias: 'standard',
      slashModelEffective: 'dci-marketing/gpt-5.6-terra',
    }))

    const modelPill = el.querySelector('[data-slash-model-pill]')
    expect(modelPill).not.toBeNull()
    expect(modelPill?.textContent).toBe('Standard · GPT 5.6 Terra')
    expect(modelPill?.querySelector('svg')).not.toBeNull()
    expect((modelPill as HTMLElement).style.borderRadius).toBe('10px')
    expect(modelPill?.parentElement?.firstElementChild).not.toBe(modelPill)
  })

  it('renders model pill when live event stamps provenance before slash metadata', () => {
    const el = renderBubble(userMessage('/align', {
      slashModelAlias: 'standard',
      slashModelEffective: 'gpt-5.6-terra',
    }))

    const modelPill = el.querySelector('[data-slash-model-pill]')
    expect(modelPill).not.toBeNull()
    expect(modelPill?.textContent).toBe('Standard · GPT 5.6 Terra')
  })

  it('omits model pill when slash command has no model provenance', () => {
    const el = renderBubble(userMessage('/clear', {
      slashCommand: '/clear',
      slashArgs: '',
    }))

    expect(el.querySelector('[data-slash-model-pill]')).toBeNull()
  })
})

// ─── Layout containment ───

// A user message whose collapsible wrapper engages (>600 chars) AND carries a
// wide fenced code block. This is the regression shape: the CodeBlock <pre>
// renders white-space:pre + overflow-x:auto, which only scrolls when every
// flex link above it clamps width (min-width:auto otherwise lets the code's
// intrinsic width blow past the bubble column's max-w-[85%] cap and overflow
// the conversation pane).
const WIDE_CODE_LONG_MESSAGE = [
  'Here is the problem I found:',
  '```',
  'model-x/one is aliased to gateway-y/two which resolves to provider-z/three-large-context-name. ' + 'wide '.repeat(80),
  '```',
  'x'.repeat(600),
].join('\n')

describe('MessageBubble — code block width containment (collapsible path)', () => {
  it('clamps every wrapper between the bubble column and the code block with max-w-full + min-w-0', () => {
    const el = renderBubble(userMessage(WIDE_CODE_LONG_MESSAGE))

    // Collapsible wrapper engaged (long message) and clamped.
    const collapsedBody = el.querySelector('[data-user-message-collapsed]') as HTMLElement
    expect(collapsedBody).not.toBeNull()
    expect(collapsedBody.className).toContain('max-w-full')
    expect(collapsedBody.className).toContain('min-w-0')
    const collapsibleColumn = collapsedBody.parentElement as HTMLElement
    expect(collapsibleColumn.className).toContain('max-w-full')
    expect(collapsibleColumn.className).toContain('min-w-0')

    // The bubble div itself (the padded, bordered element) is clamped too.
    const bubble = collapsedBody.querySelector('.px-3') as HTMLElement
    expect(bubble).not.toBeNull()
    expect(bubble.className).toContain('max-w-full')
    expect(bubble.className).toContain('min-w-0')

    // And the code block rendered (regression shape includes a fence).
    expect(el.querySelector('pre')).not.toBeNull()
  })
})

describe('MessageBubble — left-edge overflow containment', () => {
  it('caps the bubble column with max-w-[85%] AND min-w-0 so it cannot grow past the cap', () => {
    const el = renderBubble(userMessage(LONG_UNBREAKABLE))

    // The bubble column is the `inline-flex flex-col items-end` wrapper.
    const column = el.querySelector('.inline-flex.flex-col.items-end') as HTMLElement | null
    expect(column).not.toBeNull()

    const cls = column!.className
    // The width cap that bounds the bubble inside the conversation pane.
    expect(cls).toContain('max-w-[85%]')
    // The shrink-enable that makes the cap actually hold for wide content.
    // Without this the flex item's `min-width: auto` overrides the cap and the
    // bubble spills off the left edge — the exact regression.
    expect(cls).toContain('min-w-0')
  })

  it('contains the prose body with min-w-0 + overflow-hidden so markdown wraps inside the bubble', () => {
    const el = renderBubble(userMessage(LONG_UNBREAKABLE))

    const prose = el.querySelector('.prose-cloud.prose-cloud-user') as HTMLElement | null
    expect(prose).not.toBeNull()

    const cls = prose!.className
    expect(cls).toContain('min-w-0')
    expect(cls).toContain('overflow-hidden')
  })
})

// ─── Verbatim whitespace ───

describe('MessageBubble — verbatim whitespace', () => {
  // The paste from the bug report. Hard-wrapped lines with a blank-line break:
  // before the fix every single newline collapsed to a space and the whole thing
  // reflowed into one paragraph.
  const TRANSCRIPT = [
    'λ ssh josh@192.168.86.166',
    'Linux hass-debian 6.1.0-51-amd64 #1 SMP PREEMPT_DYNAMIC',
    '',
    'The programs included with the Debian GNU/Linux system are free software;',
    'the exact distribution terms for each program are described in the',
    'individual files in /usr/share/doc/*/copyright.',
  ].join('\n')

  /**
   * The paragraph that owns `pre-wrap`, i.e. the one whose whitespace actually
   * renders as typed. Asserting on `el.textContent` alone is NOT sufficient:
   * textContent preserves newlines even when CSS collapses them visually, so a
   * text-only assertion passes on the unfixed code.
   */
  function verbatimParagraphs(el: HTMLElement): HTMLElement[] {
    return [...el.querySelectorAll('p')].filter(
      (n) => (n as HTMLElement).style.whiteSpace === 'pre-wrap',
    ) as HTMLElement[]
  }

  it('keeps every newline of a pasted console transcript', () => {
    const el = renderBubble(userMessage(TRANSCRIPT))
    const verbatim = verbatimParagraphs(el)
    // Both paragraphs of the transcript render verbatim (the blank line between
    // them is a real paragraph break, which markdown keeps).
    expect(verbatim).toHaveLength(2)
    const text = verbatim.map((p) => p.textContent).join('\n')
    expect(text).toContain('are free software;\nthe exact distribution terms')
    expect(text).toContain('described in the\nindividual files')
  })

  it('preserves repeated blank lines between every text line', () => {
    const source = 'first line\n\n\nsecond line\n\n\nthird line'
    const el = renderBubble(userMessage(source))
    const gaps = [...el.querySelectorAll('[data-ion-blank-lines]')] as HTMLElement[]
    expect(gaps).toHaveLength(2)
    expect(gaps.map((gap) => gap.dataset.ionBlankLines)).toEqual(['2', '2'])
    expect(gaps.map((gap) => gap.style.height)).toEqual(['2lh', '2lh'])
    expect([...el.querySelectorAll('p')].map((p) => (p as HTMLElement).style.margin)).toEqual(['', '', ''])
  })

  it('distinguishes one blank line from three blank lines', () => {
    const el = renderBubble(userMessage('a\n\nb\n\n\n\nc'))
    const gaps = [...el.querySelectorAll('[data-ion-blank-lines]')] as HTMLElement[]
    expect(gaps.map((gap) => gap.dataset.ionBlankLines)).toEqual(['1', '3'])
  })

  it('keeps continuation-line indentation', () => {
    const el = renderBubble(userMessage('trace:\n      at frame one\n      at frame two'))
    const verbatim = verbatimParagraphs(el)
    expect(verbatim).toHaveLength(1)
    expect(verbatim[0].textContent).toContain('trace:\n      at frame one\n      at frame two')
  })

  it('applies pre-wrap to the paragraph carrying preserved newlines', () => {
    const el = renderBubble(userMessage('line one\nline two'))
    const p = el.querySelector('p') as HTMLElement | null
    expect(p).not.toBeNull()
    expect(p!.style.whiteSpace).toBe('pre-wrap')
  })

  it('does NOT apply pre-wrap to a single-line paragraph', () => {
    // Scoping matters: pre-wrap is only for elements that own restored
    // whitespace, never blanket-applied.
    const el = renderBubble(userMessage('just one line'))
    const p = el.querySelector('p') as HTMLElement | null
    expect(p).not.toBeNull()
    expect(p!.style.whiteSpace).toBe('')
  })

  it('renders a hard break as exactly one <br> with no phantom blank line', () => {
    // This is why pre-wrap is NOT on the container: remark-rehype emits a
    // structural "\n" text node immediately after every <br>, which a container
    // rule would render as a second, empty line.
    const el = renderBubble(userMessage('line one  \nline two'))
    const p = el.querySelector('p') as HTMLElement | null
    expect(p).not.toBeNull()
    expect(p!.querySelectorAll('br').length).toBe(1)
    expect(p!.style.whiteSpace).toBe('')
  })

  it('renders a list without blank rows between items', () => {
    // Same hazard: structural newlines sit between <li> siblings.
    const el = renderBubble(userMessage('- alpha\n- beta\n'))
    const ul = el.querySelector('ul') as HTMLElement | null
    expect(ul).not.toBeNull()
    expect(ul!.querySelectorAll('li').length).toBe(2)
    // The list itself must not be marked for pre-wrap.
    expect(ul!.style.whiteSpace).toBe('')
  })

  it('renders a table without blank rows', () => {
    const el = renderBubble(userMessage('| h1 | h2 |\n| -- | -- |\n| a | b |\n'))
    const table = el.querySelector('table') as HTMLElement | null
    expect(table).not.toBeNull()
    expect(table!.style.whiteSpace).toBe('')
  })
})

// ─── Markdown still renders ───

describe('MessageBubble — markdown survives the whitespace fix', () => {
  it('renders a fenced code block as a pre', () => {
    const el = renderBubble(userMessage('```sh\necho hi\n```\n'))
    const pre = el.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre!.textContent).toContain('echo hi')
  })

  it('renders bold as a strong element', () => {
    const el = renderBubble(userMessage('this is **bold** text'))
    expect(el.querySelector('strong')?.textContent).toBe('bold')
  })

  it('renders a heading', () => {
    const el = renderBubble(userMessage('# Title\n\nbody'))
    expect(el.querySelector('h1')?.textContent).toBe('Title')
  })
})
