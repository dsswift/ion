// @vitest-environment jsdom
/**
 * `ChartMovedMarker`'s click handler calls `host.shell.requestChartJump` on
 * every host: the verb is wire-served (browser-shell-bridge.ts SHELL_INVOKE),
 * so a browser Studio client reporting only the bridged capabilities must
 * reach it, not skip it.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../../rendererLogger', () => ({ rDebug: vi.fn() }))

const requestChartJump = vi.hoisted(() => vi.fn())
vi.mock('../../../host/host-instance', () => ({
  host: { shell: { requestChartJump }, capabilities: () => ['terminal', 'git', 'files', 'questions', 'graph'] },
}))

import { ChartMovedMarker } from '../ChartMovedMarker'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
})

function mount(): void {
  act(() => {
    root = createRoot(container)
    root.render(React.createElement(ChartMovedMarker, { chartId: 'c1', title: 't', targetMessageId: 'm1', tabId: 'tab-1' }))
  })
}

describe('ChartMovedMarker chart jump', () => {
  it('calls requestChartJump on a browser host', () => {
    mount()
    const btn = container.querySelector('[data-testid="chart-moved-marker"]') as HTMLButtonElement
    act(() => btn.click())
    expect(requestChartJump).toHaveBeenCalledWith({ tabId: 'tab-1', chartId: 'c1', messageId: 'm1' })
  })
})
