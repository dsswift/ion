// @vitest-environment jsdom
/**
 * Agent rules: the settings-edits toggle and its organization seal, the
 * browser tools toggle, the plan-mode Bash allowlist and its side panel, and
 * the AI workflow prompts.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_ASSIST_WORKFLOWS } from '@ion/shared/ai-assist-workflows'
import { createHarness, flush, type Harness } from './page-harness'
import { installFakeWire } from '../../../../host/__tests__/fake-wire'

const prefs = vi.hoisted(() => ({
  state: {
    allowSettingsEdits: false,
    setAllowSettingsEdits: vi.fn((_: boolean) => {}),
    studioPlaywrightEnabled: true,
    setStudioPlaywrightEnabled: vi.fn((_: boolean) => {}),
    aiAssistPromptOverrides: {} as Record<string, string>,
    setAiAssistPromptOverride: vi.fn((id: string, prompt: string | null) => {
      if (prompt) prefs.state.aiAssistPromptOverrides[id] = prompt
      else delete prefs.state.aiAssistPromptOverrides[id]
    }),
  },
}))
vi.mock('../../settings-target', () => ({
  useSettingsPreferences: (sel: (s: typeof prefs.state) => unknown) => sel(prefs.state),
  useSettingsTargetEnvironmentId: () => 'local',
}))
vi.mock('../../settings-servers', () => ({ useSettingsEnvironment: () => ({ id: 'devbox', label: 'Devbox', isLocal: false, justAdded: false }) }))
vi.mock('../../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../../PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rError: vi.fn() }))

const { holdDevicePolicy } = await import('../../../../settings-policy')
const { AgentAccessSection, AgentToolsSection } = await import('../agent/AgentToggleSections')
const { PlanBashSection, planBashSummary } = await import('../agent/PlanBashSection')
const { AIWorkflowsSection } = await import('../agent/AIWorkflowsSection')

const stub = {
  getPlanBashAllowlist: vi.fn(async (): Promise<string[]> => []),
  setPlanBashAllowlist: vi.fn(async () => undefined),
}

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Agent rules', () => {
  let h: Harness
  beforeEach(() => {
    vi.clearAllMocks()
    prefs.state.allowSettingsEdits = false
    prefs.state.aiAssistPromptOverrides = {}
    holdDevicePolicy(null)
    stub.getPlanBashAllowlist.mockResolvedValue([])
    ;(window as unknown as { ion: unknown }).ion = installFakeWire(stub)
    h = createHarness()
  })
  afterEach(() => h.unmount())

  describe('toggles', () => {
    it('saves the settings-edits toggle and carries its warning and search anchor', async () => {
      await h.render(<AgentAccessSection />)
      expect(h.container.querySelector('[data-settings-anchor="settings-edits"]')).not.toBeNull()
      expect(h.container.textContent).toContain('An approved agent can change what the engine on this server permits.')
      await h.click('Allow settings edits by the agent')
      expect(prefs.state.setAllowSettingsEdits).toHaveBeenCalledWith(true)
    })

    it('shows the organization seal and will not change', async () => {
      holdDevicePolicy({ customFields: { 'ion-server': { agentSettingsEdits: { allowed: true } } } })
      await h.render(<AgentAccessSection />)
      const toggle = h.control('Allow settings edits by the agent')
      expect(toggle.getAttribute('aria-checked')).toBe('true')
      expect(h.container.textContent).toContain('Set by your organization.')
      await h.click('Allow settings edits by the agent')
      expect(prefs.state.setAllowSettingsEdits).not.toHaveBeenCalled()
    })

    it('locks any row whose setting the settings policy seals', async () => {
      holdDevicePolicy({ customFields: { 'ion-server': { settingsPolicy: { keys: { studioPlaywrightEnabled: { class: 'sealed', value: false } } } } } })
      await h.render(<AgentToolsSection />)
      expect(h.control('Built-in Playwright browser tools').getAttribute('aria-checked')).toBe('false')
      expect(h.container.textContent).toContain('Set by your organization.')
      await h.click('Built-in Playwright browser tools')
      expect(prefs.state.setStudioPlaywrightEnabled).not.toHaveBeenCalled()
    })

    it('saves the browser tools toggle', async () => {
      await h.render(<AgentToolsSection />)
      expect(h.container.querySelector('[data-settings-anchor="playwright"]')).not.toBeNull()
      await h.click('Built-in Playwright browser tools')
      expect(prefs.state.setStudioPlaywrightEnabled).toHaveBeenCalledWith(false)
    })
  })

  describe('plan-mode Bash', () => {
    it('summarizes the list in one line', () => {
      expect(planBashSummary([])).toBe('None. Bash is blocked entirely in plan mode.')
      expect(planBashSummary(['gh'])).toBe('1 command · gh')
      expect(planBashSummary(['gh', 'git status', 'ls', 'cat'])).toBe('4 commands · gh, git status, ls, …')
    })

    it('reads the server list, and adds and removes a command in the side panel, saving each change there', async () => {
      stub.getPlanBashAllowlist.mockResolvedValue(['gh'])
      await h.render(<PlanBashSection />)
      expect(h.container.querySelector('[data-settings-anchor="plan-bash"]')?.textContent).toContain('1 command · gh')
      await h.click('Edit')
      expect(h.container.textContent).toContain('"gh" matches "gh pr view" but not "ghost"')
      act(() => type(h.container.querySelector<HTMLInputElement>('input[aria-label="Add to Allowed Bash commands"]')!, 'git status'))
      await h.click('Add')
      expect(stub.setPlanBashAllowlist).toHaveBeenLastCalledWith(['gh', 'git status'])
      await h.click('Remove gh')
      expect(stub.setPlanBashAllowlist).toHaveBeenLastCalledWith(['git status'])
      await h.click('Remove git status')
      expect(stub.setPlanBashAllowlist).toHaveBeenLastCalledWith([])
      expect(h.container.textContent).toContain('No commands allowed. Bash is blocked entirely in plan mode.')
    })
  })

  describe('AI workflow prompts', () => {
    const open = async (label: string): Promise<void> => {
      const row = [...h.container.querySelectorAll<HTMLElement>('[role="listitem"]')].find((r) => r.textContent?.startsWith(label))!
      await act(async () => { row.click(); await flush() })
    }
    const editor = (label: string): HTMLTextAreaElement => h.container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label} prompt"]`)!

    it('lists every workflow as Default, and opens its full default template', async () => {
      await h.render(<AIWorkflowsSection />)
      expect(h.container.querySelectorAll('[role="listitem"]')).toHaveLength(AI_ASSIST_WORKFLOWS.length)
      expect(h.container.textContent).not.toContain('Customized')
      for (const workflow of AI_ASSIST_WORKFLOWS) {
        await open(workflow.label)
        expect(editor(workflow.label).value).toBe(workflow.defaultTemplate)
      }
    })

    it('blocks an unknown placeholder and saves a valid override', async () => {
      const workflow = AI_ASSIST_WORKFLOWS[0]
      await h.render(<AIWorkflowsSection />)
      await open(workflow.label)
      act(() => type(editor(workflow.label), 'bad {{unknown}}'))
      expect(h.container.textContent).toContain('Unknown placeholder')
      expect((h.control(`Save ${workflow.label} prompt`) as HTMLButtonElement).disabled).toBe(true)
      act(() => type(editor(workflow.label), 'custom {{directory}}'))
      await h.click(`Save ${workflow.label} prompt`)
      expect(prefs.state.setAiAssistPromptOverride).toHaveBeenCalledWith(workflow.id, 'custom {{directory}}')
    })

    it('marks an override Customized, and Reset removes it and restores the default', async () => {
      prefs.state.aiAssistPromptOverrides['merge-resolution'] = 'custom {{directory}}'
      const workflow = AI_ASSIST_WORKFLOWS.find((entry) => entry.id === 'merge-resolution')!
      await h.render(<AIWorkflowsSection />)
      expect(h.container.textContent).toContain('Customized')
      await open(workflow.label)
      expect(editor(workflow.label).value).toBe('custom {{directory}}')
      await h.click(`Reset ${workflow.label} prompt`)
      expect(prefs.state.setAiAssistPromptOverride).toHaveBeenCalledWith(workflow.id, null)
      expect(editor(workflow.label).value).toBe(workflow.defaultTemplate)
    })
  })
})
