// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { openPlan, getState } = vi.hoisted(() => ({
  openPlan: vi.fn(),
  getState: vi.fn(),
}))

const colors = {
  containerBg: 'bg', permissionAllowBorder: 'border', permissionAllowBg: 'allow',
  successFg: 'success', textSecondary: 'text', permissionAllowHoverBg: 'hover',
  surfaceHover: 'surface-hover', textTertiary: 'tertiary', surfaceSecondary: 'secondary',
  surfaceActive: 'active',
}

vi.mock('framer-motion', () => ({
  motion: { div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div> },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('../../theme', () => ({ useColors: () => colors }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: (selector: (value: { allowSettingsEdits: boolean; showImplementClearContext: boolean }) => unknown) =>
    selector({ allowSettingsEdits: false, showImplementClearContext: false }),
}))
vi.mock('../../stores/sessionStore', () => ({ useSessionStore: { getState } }))
vi.mock('../../lib/file-open-router', () => ({ surfaceRouter: () => ({ openPlan, openTextFile: vi.fn() }) }))
vi.mock('../PlanViewer', () => ({ PlanViewer: () => null }))

import { PermissionDeniedCard } from '../PermissionDeniedCard'

describe('PermissionDeniedCard', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    vi.clearAllMocks()
    getState.mockReturnValue({
      activeTabId: 'active-tab',
      tabs: [
        { id: 'active-tab', workingDirectory: '/active' },
        { id: 'card-tab', workingDirectory: '/card' },
      ],
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('routes View Plan through card tab instead of unrelated active tab', async () => {
    await act(async () => {
      root.render(
        <PermissionDeniedCard
          tools={[{ toolName: 'ExitPlanMode', toolUseId: 'exit', toolInput: { planFilePath: '/plans/card.md' } }]}
          tabId="card-tab"
          sessionId={null}
          projectPath="/card"
          messages={[]}
          onDismiss={() => undefined}
          onImplement={() => undefined}
        />,
      )
    })

    const button = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('View Plan'))
    expect(button).toBeDefined()
    await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(openPlan).toHaveBeenCalledWith('/card', 'card-tab', '/plans/card.md')
  })
})
