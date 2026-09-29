// @vitest-environment jsdom
/**
 * The plain form pages — Behavior, the device git section, Defaults,
 * Thinking, and Developer — carry every catalog anchor and write through
 * the right setter.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarness, type Harness } from './page-harness'

vi.mock('../../settings-target', async () => {
  const { create } = await import('zustand')
  return { useSettingsPreferences: create<Record<string, unknown>>(() => ({})) }
})

const { useSettingsPreferences } = await import('../../settings-target')
const { useUpdateStore } = await import('@ion/server/store/update-store')
const { BehaviorPage, DeviceGitSection } = await import('../BehaviorPage')
const { DefaultsPage, ThinkingSection } = await import('../DefaultsPage')
const { DeveloperSection } = await import('../DeveloperSection')

const setters = {
  setStudioSurfaceSwitchMode: vi.fn(), setShowTodoList: vi.fn(), setAgentPanelDefaultOpen: vi.fn(), setSoundEnabled: vi.fn(),
  setBrowserPreviewNetworkShield: vi.fn(), setShowImplementClearContext: vi.fn(), setGitChangesTreeView: vi.fn(),
  setDefaultPermissionMode: vi.fn(), setAiGeneratedTitles: vi.fn(), setBashCommandEntry: vi.fn(), setEnableClaudeCompat: vi.fn(),
  setEnableEarlyStopContinuation: vi.fn(), setDefaultThinkingEffort: vi.fn(),
}

let h: Harness
beforeEach(() => {
  for (const fn of Object.values(setters)) fn.mockReset()
  ;(useSettingsPreferences as unknown as { setState(s: object, replace: boolean): void }).setState({
    ...setters, studioSurfaceSwitchMode: 'preserve', showTodoList: true, agentPanelDefaultOpen: true, soundEnabled: false, browserPreviewNetworkShield: true,
    showImplementClearContext: false, gitChangesTreeView: false, defaultPermissionMode: 'plan', aiGeneratedTitles: true, bashCommandEntry: false,
    enableClaudeCompat: false, enableEarlyStopContinuation: false, defaultThinkingEffort: 'medium',
  }, true)
  h = createHarness()
})
afterEach(() => h.unmount())

const anchors = (): string[] => [...h.container.querySelectorAll('[data-settings-anchor]')].map((el) => el.getAttribute('data-settings-anchor') ?? '')

describe('device and personal form pages', () => {
  it('Behavior and the device git section write their device keys', async () => {
    await h.render(<><BehaviorPage /><DeviceGitSection /></>)
    expect(anchors()).toEqual(expect.arrayContaining(['surface-switch', 'task-list', 'agent-panel', 'sound', 'network-shield', 'implement-clear', 'changes-tree']))
    expect(h.container.textContent).not.toContain('Playwright')
    await h.click('Per conversation')
    expect(setters.setStudioSurfaceSwitchMode).toHaveBeenCalledWith('per-conversation')
    await h.click('Notification sound')
    expect(setters.setSoundEnabled).toHaveBeenCalledWith(true)
    await h.click('Show "Implement, clear context" button')
    expect(setters.setShowImplementClearContext).toHaveBeenCalledWith(true)
    await h.click('Tree view for changes')
    expect(setters.setGitChangesTreeView).toHaveBeenCalledWith(true)
  })

  it('Defaults and Thinking write their personal keys', async () => {
    await h.render(<><DefaultsPage /><ThinkingSection /></>)
    expect(anchors()).toEqual(expect.arrayContaining(['permission-mode', 'ai-titles', 'bash-entry', 'claude-compat', 'early-stop', 'thinking']))
    await h.click('Auto')
    expect(setters.setDefaultPermissionMode).toHaveBeenCalledWith('auto')
    await h.click('Early-stop continuation nudge')
    expect(setters.setEnableEarlyStopContinuation).toHaveBeenCalledWith(true)
    const levels = [...h.container.querySelectorAll('[role="radiogroup"][aria-label="Default thinking level"] [role="radio"]')]
    expect(levels).toHaveLength(6)
    await h.click('Max')
    expect(setters.setDefaultThinkingEffort).toHaveBeenCalledWith('max')
  })

  it('Developer simulates an update and clears it', async () => {
    useUpdateStore.setState({ version: null, dialogOpen: false })
    await h.render(<DeveloperSection />)
    expect(anchors()).toContain('simulate-update')
    await h.click('Simulate Update')
    expect(useUpdateStore.getState().version).toBe('9.9.9-dev')
    await h.click('Inspect')
    expect(h.container.textContent).toContain('version: 9.9.9-dev')
    await h.click('Clear')
    expect(useUpdateStore.getState().version).toBeNull()
  })
})
