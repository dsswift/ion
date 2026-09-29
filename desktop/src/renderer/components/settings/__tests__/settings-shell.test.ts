/**
 * A Server page's shell calls go to the picked server. The bug: MCP,
 * Automation, and Enterprise Auth called a bare `host.shell`, which lands on
 * the local server, so with another server picked they listed and edited this
 * machine under that server's name.
 */
import { describe, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => ({ targets: [] as Array<string | null> }))
vi.mock('../../../host/host-instance', async () => {
  const { explicitTargetEnvironment } = await import('../../../studio/connection/tab-environment')
  return { host: { shell: { mcpList: vi.fn(async () => { seen.targets.push(explicitTargetEnvironment()); return { ok: true, servers: [] } }) } } }
})
vi.mock('../settings-target', () => ({ useSettingsTargetEnvironmentId: () => 'env-remote' }))
vi.mock('../environment/environment-client', () => ({ onEnvironmentEvent: vi.fn() }))

import { host } from '../../../host/host-instance'
import { shellFor } from '../settings-shell'

describe('shellFor', () => {
  it('sends the call to the named server', async () => {
    await shellFor('env-remote').mcpList()
    expect(seen.targets).toEqual(['env-remote'])
  })

  it('a bare host.shell call carries no target', async () => {
    seen.targets.length = 0
    await host.shell.mcpList()
    expect(seen.targets).toEqual([null])
  })
})
