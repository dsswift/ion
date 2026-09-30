// @vitest-environment jsdom
/**
 * Middle-clicking a conversation terminal tab closes it (destroying its shell),
 * the same as every other Studio tab strip. A locked (read-only) terminal
 * ignores the middle-click.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { TerminalInstance, TerminalPaneState } from '@ion/shared/types'

const { removeTerminalInstance, selectTerminalInstance, state } = vi.hoisted(() => ({
  removeTerminalInstance: vi.fn().mockResolvedValue(undefined),
  selectTerminalInstance: vi.fn(),
  state: { terminalPanes: new Map<string, unknown>() },
}))

vi.mock('@ion/server/store/sessionStore', () => {
  const fullState = () => ({
    ...state,
    terminalTallTabId: null,
    terminalBigScreenTabId: null,
    terminalActivities: new Map(),
    addTerminalInstance: vi.fn(),
    removeTerminalInstance,
    selectTerminalInstance,
    toggleTerminalReadOnly: vi.fn(),
    toggleTerminalTall: vi.fn(),
    toggleTerminalBigScreen: vi.fn(),
  })
  const useSessionStore = (selector: (s: ReturnType<typeof fullState>) => unknown) => selector(fullState())
  useSessionStore.getState = fullState
  return { useSessionStore }
})
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../git/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('../../lib/file-open-router', () => ({ contentRouter: {} }))
vi.mock('../../host/host-instance', () => ({ host: {} }))
vi.mock('../TerminalInstance', () => ({ getTerminalEntry: vi.fn() }))
vi.mock('../composer/composer-context-sources', () => ({ addTerminalContext: vi.fn() }))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rWarn: vi.fn() }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { TerminalTabStrip } from '../TerminalTabStrip'

const TAB_ID = 'tab-1'

function shell(id: string, readOnly: boolean): TerminalInstance {
  return { id, label: id, kind: 'user', readOnly, cwd: '/home/user' }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  removeTerminalInstance.mockClear()
  selectTerminalInstance.mockClear()
  const pane: TerminalPaneState = {
    instances: [shell('unlocked', false), shell('locked', true)],
    activeInstanceId: 'unlocked',
  } as TerminalPaneState
  state.terminalPanes = new Map([[TAB_ID, pane]])
  Element.prototype.scrollIntoView ??= () => {}
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(<TerminalTabStrip tabId={TAB_ID} />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function auxClick(instanceId: string, button: number) {
  const tab = container.querySelector(`[data-terminal-tab-id="${instanceId}"]`)
  if (!tab) throw new Error(`terminal tab ${instanceId} not rendered`)
  act(() => {
    tab.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button }))
  })
}

describe('TerminalTabStrip middle-click close', () => {
  it('closes an unlocked terminal', () => {
    auxClick('unlocked', 1)
    expect(removeTerminalInstance).toHaveBeenCalledWith(TAB_ID, 'unlocked')
  })

  it('leaves a locked terminal open', () => {
    auxClick('locked', 1)
    expect(removeTerminalInstance).not.toHaveBeenCalled()
  })

  it('ignores other auxiliary buttons', () => {
    auxClick('unlocked', 2)
    expect(removeTerminalInstance).not.toHaveBeenCalled()
  })
})
