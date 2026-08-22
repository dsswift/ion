// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { sessionState, rDebug, rWarn, clipboardWriteText, fsSaveDialog, fsWriteFile } = vi.hoisted(() => ({
  sessionState: {
    activeTabId: 'tab-1',
    conversationPanes: new Map<string, unknown>(),
  },
  rDebug: vi.fn(),
  rWarn: vi.fn(),
  clipboardWriteText: vi.fn(async () => undefined),
  fsSaveDialog: vi.fn<() => Promise<{ filePath: string | null; error?: string }>>(async () => ({ filePath: '/exports/first-export.md' })),
  fsWriteFile: vi.fn(async () => ({ ok: true })),
}))

vi.mock('../../../../stores/sessionStore', () => ({
  useSessionStore: (selector: (state: typeof sessionState) => unknown) => selector(sessionState),
}))
vi.mock('../../../../theme', () => ({
  useColors: () => ({ textTertiary: 'gray', containerBorder: 'border', statusComplete: 'green' }),
}))
vi.mock('../../../../components/PlanContent', () => ({
  PlanContent: ({ content }: { content: string }) => <div data-testid="plan-content">{content}</div>,
}))
vi.mock('../../../../components/git/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('../../../../rendererLogger', () => ({ rDebug, rWarn }))

import { PlanSurface } from '../PlanSurface'
import { formatImplementDivider } from '../../../../../shared/clear-divider'

const firstPath = '/plans/first.md'
const secondPath = '/plans/second.md'
/** The durable record the implement flow writes when the user approves. */
const firstImplementDivider = formatImplementDivider(new Date(), 'first')

function pane(planFilePath: string | null, messages: Array<Record<string, unknown>>) {
  return {
    activeInstanceId: 'main',
    instances: [{ id: 'main', planFilePath, messages }],
  }
}

function render() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => { root.render(<PlanSurface />) })
  return {
    host,
    rerender: () => act(() => { root.render(<PlanSurface />) }),
    unmount: () => {
      act(() => { root.unmount() })
      host.remove()
    },
  }
}

describe('PlanSurface', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionState.activeTabId = 'tab-1'
    sessionState.conversationPanes = new Map([['tab-1', pane(null, [
      { role: 'system', content: '── Plan created', planFilePath: firstPath },
      { role: 'system', content: firstImplementDivider },
    ])]])
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWriteText },
    })
    window.ion = {
      fsReadFile: vi.fn(async (path: string) => ({ content: path === firstPath ? '# first plan' : '# second plan' })),
      fsSaveDialog,
      fsWriteFile,
      fsWatchFile: vi.fn(async () => ({ ok: true })),
      fsUnwatchFile: vi.fn(async () => undefined),
      onFileChanged: vi.fn(() => () => undefined),
    } as never
  })

  afterEach(() => { document.body.replaceChildren() })

  it('shows reserved state without reading a plan file before the agent writes it', async () => {
    sessionState.conversationPanes = new Map([['tab-1', pane(firstPath, [])]])
    const view = render()
    await act(async () => {})

    expect(view.host.querySelector('[data-testid="plan-reserved-state"]')?.textContent).toContain('Plan reserved')
    expect(window.ion.fsReadFile).not.toHaveBeenCalled()
    expect(window.ion.fsWatchFile).not.toHaveBeenCalled()
    view.unmount()
  })

  it('keeps implemented plan visible after current plan path clears', async () => {
    const view = render()
    await act(async () => {})

    expect(view.host.textContent).toContain('# first plan')
    expect(view.host.querySelector('[data-testid="plan-implementation-status"]')?.textContent).toContain('Implemented')
    expect(window.ion.fsReadFile).toHaveBeenCalledWith(firstPath)
    view.unmount()
  })

  it('reports NOT implemented when the plan path cleared without an implement divider', async () => {
    // REGRESSION: `implemented` was derived as "a plan path is known from
    // history but instance.planFilePath is empty". The implement flow does
    // clear that field last, but so does every other path that nulls it, so
    // the badge asserted an implementation that never happened. The divider is
    // the record; its absence means not implemented.
    sessionState.conversationPanes = new Map([['tab-1', pane(null, [
      { role: 'system', content: '── Plan created', planFilePath: firstPath },
    ])]])
    const view = render()
    await act(async () => {})

    expect(view.host.textContent).toContain('# first plan')
    expect(view.host.querySelector('[data-testid="plan-implementation-status"]')?.textContent).toContain('Not implemented')
    view.unmount()
  })

  it('shows the resolved path and copies the plan path or contents', async () => {
    const view = render()
    await act(async () => {})

    expect(view.host.querySelector('[data-testid="plan-file-path"]')?.textContent).toBe(firstPath)

    const actionsButton = view.host.querySelector<HTMLButtonElement>('button[aria-label="Plan actions"]')
    expect(actionsButton).not.toBeNull()
    act(() => { actionsButton?.click() })

    const menuItems = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    expect(menuItems.map((item) => item.textContent)).toEqual(['Copy Plan Path', 'Copy Plan Contents', 'Download Plan'])

    act(() => { menuItems[0]?.click() })
    await act(async () => {})
    expect(clipboardWriteText).toHaveBeenLastCalledWith(firstPath)

    act(() => { actionsButton?.click() })
    const copyContents = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent === 'Copy Plan Contents')
    act(() => { copyContents?.click() })
    await act(async () => {})
    expect(clipboardWriteText).toHaveBeenLastCalledWith('# first plan')
    view.unmount()
  })

  it('downloads the plan with its source name and export timestamp', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2027, 2, 5, 9, 7))
    const view = render()
    await act(async () => {})

    act(() => { view.host.querySelector<HTMLButtonElement>('button[aria-label="Plan actions"]')?.click() })
    const download = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent === 'Download Plan')
    await act(async () => { download?.click(); await Promise.resolve() })

    expect(fsSaveDialog).toHaveBeenCalledWith(undefined, 'first-20270305-0907.md')
    expect(fsWriteFile).toHaveBeenCalledWith('/exports/first-export.md', '# first plan')
    view.unmount()
    vi.useRealTimers()
  })

  it('does not write a plan when the export dialog is cancelled', async () => {
    fsSaveDialog.mockResolvedValueOnce({ filePath: null })
    const view = render()
    await act(async () => {})

    act(() => { view.host.querySelector<HTMLButtonElement>('button[aria-label="Plan actions"]')?.click() })
    const download = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent === 'Download Plan')
    await act(async () => { download?.click(); await Promise.resolve() })

    expect(fsWriteFile).not.toHaveBeenCalled()
    expect(rDebug).toHaveBeenCalledWith('studio.plan', 'plan export cancelled', { path: firstPath })
    view.unmount()
  })

  it('logs clipboard failures with the plan path', async () => {
    clipboardWriteText.mockRejectedValueOnce(new Error('clipboard unavailable'))
    const view = render()
    await act(async () => {})

    act(() => { view.host.querySelector<HTMLButtonElement>('button[aria-label="Plan actions"]')?.click() })
    const copyPath = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent === 'Copy Plan Path')
    act(() => { copyPath?.click() })
    await act(async () => {})

    expect(rWarn).toHaveBeenCalledWith('studio.plan', 'copy plan value failed', {
      path: firstPath,
      copy_kind: 'path',
      error: 'Error: clipboard unavailable',
    })
    view.unmount()
  })

  it('retargets to newer live plan instead of retained implementation plan', async () => {
    const view = render()
    await act(async () => {})

    sessionState.conversationPanes = new Map([['tab-1', pane(secondPath, [
      { role: 'system', content: '── Implementing plan', planFilePath: firstPath },
      { role: 'system', content: '── Plan created', planFilePath: secondPath },
    ])]])
    view.rerender()
    await act(async () => {})

    expect(view.host.textContent).toContain('# second plan')
    expect(view.host.querySelector('[data-testid="plan-implementation-status"]')?.textContent).toContain('Not implemented')
    expect(window.ion.fsReadFile).toHaveBeenLastCalledWith(secondPath)
    view.unmount()
  })
})
