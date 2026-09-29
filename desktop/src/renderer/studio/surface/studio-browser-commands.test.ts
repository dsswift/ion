import { describe, it, expect, vi, beforeEach } from 'vitest'

const { onStudioBrowserOpenUrl, onStudioBrowserCommand, capabilities } = vi.hoisted(() => ({
  onStudioBrowserOpenUrl: vi.fn(() => vi.fn()),
  onStudioBrowserCommand: vi.fn(() => vi.fn()),
  capabilities: vi.fn<() => string[]>(),
}))

vi.mock('../../host/host-instance', () => ({
  host: { capabilities, shell: { onStudioBrowserOpenUrl, onStudioBrowserCommand } },
}))
vi.mock('./surface-store', () => ({ useSurfaceStore: { getState: () => ({ openBrowserTab: vi.fn(), setVisible: vi.fn() }) } }))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rWarn: vi.fn() }))

import { registerStudioBrowserCommands } from './studio-browser-commands'

beforeEach(() => {
  onStudioBrowserOpenUrl.mockClear()
  onStudioBrowserCommand.mockClear()
})

describe('registerStudioBrowserCommands', () => {
  it('does not subscribe without the browser capability (browser Studio client)', () => {
    capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    registerStudioBrowserCommands()
    expect(onStudioBrowserOpenUrl).not.toHaveBeenCalled()
    expect(onStudioBrowserCommand).not.toHaveBeenCalled()
  })

  it('subscribes when the host reports the browser capability (Electron)', () => {
    capabilities.mockReturnValue(['browser'])
    registerStudioBrowserCommands()
    expect(onStudioBrowserOpenUrl).toHaveBeenCalledTimes(1)
    expect(onStudioBrowserCommand).toHaveBeenCalledTimes(1)
  })
})
