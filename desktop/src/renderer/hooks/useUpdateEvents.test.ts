// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useUpdateEvents } from './useUpdateEvents'
import { host } from '../host/host-instance'

vi.mock('../host/host-instance', () => ({
  host: {
    capabilities: vi.fn(),
    shell: {
      onUpdateDownloaded: vi.fn(() => vi.fn()),
      onUpdateProgress: vi.fn(() => vi.fn()),
      onUpdateStaged: vi.fn(() => vi.fn()),
      onUpdateError: vi.fn(() => vi.fn()),
    },
  },
}))

function Probe(): React.ReactElement {
  useUpdateEvents()
  return React.createElement('div')
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(host.shell.onUpdateDownloaded).mockClear()
  vi.mocked(host.shell.onUpdateProgress).mockClear()
  vi.mocked(host.shell.onUpdateStaged).mockClear()
  vi.mocked(host.shell.onUpdateError).mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useUpdateEvents', () => {
  it('does not touch host.shell when the host lacks the updates capability (browser Studio client)', () => {
    vi.mocked(host.capabilities).mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    act(() => root.render(React.createElement(Probe)))
    expect(host.shell.onUpdateDownloaded).not.toHaveBeenCalled()
    expect(host.shell.onUpdateProgress).not.toHaveBeenCalled()
    expect(host.shell.onUpdateStaged).not.toHaveBeenCalled()
    expect(host.shell.onUpdateError).not.toHaveBeenCalled()
  })

  it('subscribes to every update event when the host reports the updates capability (Electron)', () => {
    vi.mocked(host.capabilities).mockReturnValue(['updates'])
    act(() => root.render(React.createElement(Probe)))
    expect(host.shell.onUpdateDownloaded).toHaveBeenCalledTimes(1)
    expect(host.shell.onUpdateProgress).toHaveBeenCalledTimes(1)
    expect(host.shell.onUpdateStaged).toHaveBeenCalledTimes(1)
    expect(host.shell.onUpdateError).toHaveBeenCalledTimes(1)
  })
})
