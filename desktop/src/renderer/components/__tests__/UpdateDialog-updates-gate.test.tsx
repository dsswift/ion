// @vitest-environment jsdom
/**
 * Capability gate (spec 18): the install button's click handler calls
 * `host.shell.restartForUpdate`/`installUpdate` synchronously with no wire
 * equivalent -- reuses `updates`, the same gate `useUpdateEvents.ts` checks.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUpdateStore } from '@ion/server/store/update-store'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../hooks/useInteractiveState', () => ({
  useInteractiveState: () => ({ hover: false, pressed: false, handlers: {} }),
  interactiveBg: () => '#000',
}))
vi.mock('../PopoverLayer', () => ({ usePopoverLayer: () => document.body }))

const restartForUpdate = vi.hoisted(() => vi.fn())
const installUpdate = vi.hoisted(() => vi.fn())
let caps: string[] = []
vi.mock('../../host/host-instance', () => ({
  host: { shell: { restartForUpdate, installUpdate }, capabilities: () => caps },
}))

import { UpdateDialog } from '../UpdateDialog'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.clearAllMocks()
  useUpdateStore.setState({ dialogOpen: true, version: '1.0.0', progress: null, staged: true, error: null })
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
  useUpdateStore.setState({ dialogOpen: false, version: null, progress: null, staged: false, error: null })
})

function mount(): void {
  act(() => {
    root = createRoot(container)
    root.render(React.createElement(UpdateDialog))
  })
}

describe('UpdateDialog updates gate', () => {
  it('does not throw and skips restartForUpdate on a browser host', () => {
    caps = ['terminal', 'git', 'files', 'questions', 'graph']
    mount()
    const btn = Array.from(document.body.querySelectorAll('button')).find((b) => /restart/i.test(b.textContent ?? '')) as HTMLButtonElement
    expect(() => act(() => btn.click())).not.toThrow()
    expect(restartForUpdate).not.toHaveBeenCalled()
  })

  it('calls restartForUpdate when updates is present', () => {
    caps = ['updates']
    mount()
    const btn = Array.from(document.body.querySelectorAll('button')).find((b) => /restart/i.test(b.textContent ?? '')) as HTMLButtonElement
    act(() => btn.click())
    expect(restartForUpdate).toHaveBeenCalledTimes(1)
  })
})
