// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({ useColors: () => ({ textTertiary: '#888888' }) }))
vi.mock('../StatusBarContextIndicator', () => ({ ContextIndicator: () => <span>Context</span> }))
vi.mock('../StatusBarModelPicker', () => ({ ModelPicker: () => <span>Model</span> }))
vi.mock('../StatusBarPermissionModePicker', () => ({ PermissionModePicker: () => <span>Mode</span> }))
vi.mock('../StatusBarThinkingPicker', () => ({ ThinkingPicker: () => <span>Think</span> }))
vi.mock('../StatusBarAttachmentsButton', () => ({ AttachmentsButton: () => <span>Attachments</span> }))
vi.mock('../StatusBarEngineState', () => ({
  StatusBarEngineState: () => <span data-testid="composer-activity-status">[running]</span>,
}))

vi.mock('../composer/useComposerActions', () => ({ useComposerActions: () => [] }))
vi.mock('../composer/ComposerPlusMenu', () => ({ ComposerPlusMenu: () => <span>Plus</span> }))
vi.mock('../composer/ComposerQuickToolsButton', () => ({ ComposerQuickToolsButton: () => <span>Quick</span> }))

import { ComposerControls } from '../ComposerControls'

function render(): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => { root.render(<ComposerControls actions={<span>Send</span>} />) })
  return { container, unmount: () => act(() => { root.unmount() }) }
}

describe('ComposerControls row', () => {
  afterEach(() => { document.body.replaceChildren() })

  it('puts the content readouts on the left and run activity beside send', () => {
    const { container, unmount } = render()

    const controls = container.querySelector('[data-testid="composer-controls"]')
    // Attachments before the context radial: the fixed-width icon anchors the
    // cluster. Run activity is not a reading of the prompt's contents — it
    // reports on the run the send button starts, so it stays on the right,
    // immediately left of the verbs it describes.
    expect(controls?.textContent).toBe('PlusQuickModelThinkModeAttachmentsContext[running]Send')
    expect(controls?.querySelector('[data-testid="composer-pickers-expanded"]')).not.toBeNull()
    expect(controls?.getAttribute('data-collapsed')).toBe('false')

    unmount()
  })

  it('separates the readouts from the send controls with the growing spacer', () => {
    // The readouts used to live on the right, where a hand-tuned gap was the
    // only thing saying the attachments button was not one of the send
    // buttons. They now sit with the controls they describe, and the flex
    // spacer — not a gap value — is what holds the send cluster apart.
    const { container, unmount } = render()

    const readouts = container.querySelector('[data-testid="composer-readouts"]')
    const activity = container.querySelector('[data-testid="composer-activity-status-inset"]')
    const sendCluster = container.querySelector('[data-testid="composer-send-cluster"]')
    expect(readouts?.textContent).toBe('AttachmentsContext')
    expect(sendCluster?.textContent).toBe('Send')

    const children = [...(container.querySelector('[data-testid="composer-controls"]')?.children ?? [])]
    const spacer = container.querySelector('[data-testid="composer-row-spacer"]')
    expect(spacer).not.toBeNull()
    expect(children.indexOf(readouts as Element)).toBeLessThan(children.indexOf(spacer as Element))
    const trailing = sendCluster?.parentElement as HTMLElement
    expect(children.indexOf(spacer as Element)).toBeLessThan(children.indexOf(trailing))
    // Run activity rides with the send controls, directly before them.
    expect(activity?.parentElement).toBe(trailing)
    expect(activity?.nextElementSibling).toBe(sendCluster)

    unmount()
  })
})
