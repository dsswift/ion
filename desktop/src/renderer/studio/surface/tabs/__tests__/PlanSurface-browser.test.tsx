// @vitest-environment jsdom
/**
 * The browser-host path for PlanSurface. Separate from PlanSurface.test.tsx,
 * which drives real ElectronStudioHost resolution via `window.ion` --
 * host-instance.ts caches its resolved host class for the module's lifetime
 * by design, so mocking host-instance directly here is what exercises a
 * browser Studio client's capability set. The fs verbs are bridged over the
 * studio-wire, so the plan loads and watches exactly like Electron.
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { sessionState, fsReadFile, fsWatchFile, fsUnwatchFile, onFileChanged, capabilities } = vi.hoisted(() => ({
  sessionState: {
    activeTabId: 'tab-1',
    conversationPanes: new Map<string, unknown>(),
  },
  fsReadFile: vi.fn(),
  fsWatchFile: vi.fn().mockResolvedValue({ ok: true }),
  fsUnwatchFile: vi.fn().mockResolvedValue(undefined),
  onFileChanged: vi.fn(() => () => undefined),
  capabilities: vi.fn<() => string[]>(),
}))

vi.mock('../../../../host/host-instance', () => ({
  host: { shell: { fsReadFile, fsWatchFile, fsUnwatchFile, onFileChanged, fsSaveDialog: vi.fn(), fsWriteFile: vi.fn() }, capabilities },
}))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionState) => unknown) => selector(sessionState),
}))
vi.mock('../../../../theme', () => ({
  useColors: () => ({ textTertiary: 'gray', containerBorder: 'border', statusComplete: 'green', textSecondary: 'gray' }),
}))
vi.mock('../../../../components/PlanContent', () => ({
  PlanContent: ({ content }: { content: string }) => <div data-testid="plan-content">{content}</div>,
}))

import { PlanSurface } from '../PlanSurface'

const planPath = '/plans/first.md'

function pane(planFilePath: string | null, messages: Array<Record<string, unknown>>) {
  return {
    activeInstanceId: 'main',
    instances: [{ id: 'main', planFilePath, messages }],
  }
}

function render() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(<PlanSurface />) })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

beforeEach(() => {
  fsReadFile.mockClear()
  fsWatchFile.mockClear()
  fsUnwatchFile.mockClear()
  onFileChanged.mockClear()
  sessionState.activeTabId = 'tab-1'
  sessionState.conversationPanes = new Map([['tab-1', pane(null, [
    { role: 'system', content: '── Plan created', planFilePath: planPath },
  ])]])
})

describe('PlanSurface on a browser Studio client', () => {
  it('loads the plan through the bridged fs verbs', async () => {
    capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    fsReadFile.mockResolvedValue({ content: '# first plan' })

    const view = render()
    await act(async () => {})

    expect(fsReadFile).toHaveBeenCalledWith(planPath)
    expect(fsWatchFile).toHaveBeenCalledWith(planPath)
    expect(view.container.textContent).toContain('# first plan')
    view.unmount()
  })
})
