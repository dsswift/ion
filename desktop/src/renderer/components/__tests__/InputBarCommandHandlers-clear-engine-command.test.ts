/**
 * `/clear` issues `host.shell.engineCommand` on every host: the verb is
 * wire-served (browser-shell-bridge.ts SHELL_INVOKE), so a browser Studio
 * client reporting only the bridged capabilities must reach it, not skip it.
 */
import { describe, expect, it, vi } from 'vitest'

const engineCommand = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('../../host/host-instance', () => ({
  host: { shell: { engineCommand }, capabilities: () => ['terminal', 'git', 'files', 'questions', 'graph'] },
}))

import { executeBuiltinCommand, type ExecuteCommandDeps } from '../InputBarCommandHandlers'
import type { TabState } from '@ion/shared/types'

function makeDeps(): ExecuteCommandDeps {
  return { tab: { id: 'tab-1' } as unknown as TabState, clearTab: vi.fn(), addSystemMessage: vi.fn() }
}

describe('executeBuiltinCommand /clear', () => {
  it('calls engineCommand and adds the divider on a browser host', () => {
    const deps = makeDeps()
    executeBuiltinCommand('/clear', deps)
    expect(engineCommand).toHaveBeenCalledWith('tab-1', 'clear', '')
    expect(deps.addSystemMessage).toHaveBeenCalledTimes(1)
  })
})
