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

import { ComposerControls } from '../ComposerControls'

describe('ComposerControls activity status', () => {
  afterEach(() => { document.body.replaceChildren() })

  it('anchors aggregate activity status after all conversation controls', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => { root.render(<ComposerControls />) })

    const controls = container.querySelector('[data-testid="composer-controls"]')
    const statusInset = controls?.querySelector('[data-testid="composer-activity-status-inset"]') as HTMLElement
    expect(statusInset.style.paddingRight).toBe('10px')
    expect(statusInset.style.height).toBe('20px')
    expect(statusInset.style.alignSelf).toBe('center')
    expect(statusInset.style.transform).toBe('translateY(-5px)')
    expect(statusInset.lastElementChild?.getAttribute('data-testid')).toBe('composer-activity-status')
    expect(controls?.textContent).toContain('[running]')

    act(() => { root.unmount() })
  })
})
