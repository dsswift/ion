// @vitest-environment jsdom
/**
 * The "View Plan" button's `host.shell.readPlan` fallback, taken when no
 * surfaceRouter is registered: the plan is read through the host shell and
 * handed to the floating PlanViewer.
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { getState, readPlan } = vi.hoisted(() => ({
  getState: vi.fn(),
  readPlan: vi.fn(async () => ({ content: 'plan body', fileName: 'plan.md' })),
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
  usePreferencesStore: (selector: (value: { showImplementClearContext: boolean }) => unknown) =>
    selector({ showImplementClearContext: false }),
}))
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: { getState } }))
// No router registered -- forces the host.shell.readPlan fallback path.
vi.mock('../../lib/file-open-router', () => ({ surfaceRouter: () => null }))
vi.mock('../PlanViewer', () => ({ PlanViewer: () => null }))
vi.mock('../../host/host-instance', () => ({
  host: { shell: { readPlan }, capabilities: () => [] },
}))

import { PermissionDeniedCard } from '../PermissionDeniedCard'

describe('PermissionDeniedCard readPlan fallback', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    vi.clearAllMocks()
    getState.mockReturnValue({ activeTabId: 'tab-1', tabs: [{ id: 'tab-1', workingDirectory: '/repo' }] })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function clickViewPlan(): Promise<void> {
    await act(async () => {
      root.render(
        <PermissionDeniedCard
          tools={[{ toolName: 'ExitPlanMode', toolUseId: 'exit', toolInput: { planFilePath: '/plans/card.md' } }]}
          tabId="tab-1"
          sessionId={null}
          projectPath="/repo"
          messages={[]}
          onDismiss={() => undefined}
          onImplement={() => undefined}
        />,
      )
    })
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('View Plan'))
    expect(button).toBeDefined()
    await act(async () => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  }

  it('reads the plan through host.shell.readPlan when no router is registered', async () => {
    await clickViewPlan()
    expect(readPlan).toHaveBeenCalledWith('/plans/card.md')
  })
})
