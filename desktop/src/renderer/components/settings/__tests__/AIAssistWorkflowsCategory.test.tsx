// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_ASSIST_WORKFLOWS } from '../../../../shared/ai-assist-workflows'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = {
  aiAssistPromptOverrides: {} as Record<string, string>,
  setAiAssistPromptOverride: vi.fn((id: string, prompt: string | null) => {
    if (prompt) state.aiAssistPromptOverrides[id] = prompt
    else delete state.aiAssistPromptOverrides[id]
  }),
}
vi.mock('../../../preferences', () => ({
  usePreferencesStore: (selector: (value: typeof state) => unknown) => selector(state),
}))
vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn() }))
vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))

import { AIAssistWorkflowsCategory } from '../AIAssistWorkflowsCategory'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  state.aiAssistPromptOverrides = {}
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(): void {
  act(() => root.render(<AIAssistWorkflowsCategory />))
}

describe('AIAssistWorkflowsCategory', () => {
  it('renders every workflow with its complete default template', () => {
    render()
    for (const workflow of AI_ASSIST_WORKFLOWS) {
      const editor = container.querySelector(`textarea[aria-label="${workflow.label} prompt"]`) as HTMLTextAreaElement
      expect(editor.value).toBe(workflow.defaultTemplate)
    }
  })

  it('blocks unknown placeholders and saves a valid independent override', () => {
    render()
    const workflow = AI_ASSIST_WORKFLOWS[0]
    const editor = container.querySelector(`textarea[aria-label="${workflow.label} prompt"]`) as HTMLTextAreaElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(editor, 'bad {{unknown}}')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.textContent).toContain('Unknown placeholder')
    const save = container.querySelector(`[aria-label="Save ${workflow.label} prompt"]`) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(editor, 'custom {{directory}}')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      save.click()
    })
    expect(state.setAiAssistPromptOverride).toHaveBeenCalledWith(workflow.id, 'custom {{directory}}')
  })

  it('reset removes override and restores source default', () => {
    state.aiAssistPromptOverrides['merge-resolution'] = 'custom {{directory}}'
    render()
    const workflow = AI_ASSIST_WORKFLOWS.find((entry) => entry.id === 'merge-resolution')!
    const reset = container.querySelector(`[aria-label="Reset ${workflow.label} prompt"]`) as HTMLButtonElement
    act(() => reset.click())
    expect(state.setAiAssistPromptOverride).toHaveBeenCalledWith(workflow.id, null)
    const editor = container.querySelector(`textarea[aria-label="${workflow.label} prompt"]`) as HTMLTextAreaElement
    expect(editor.value).toBe(workflow.defaultTemplate)
  })
})
