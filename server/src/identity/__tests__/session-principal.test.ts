import { describe, expect, it, afterEach } from 'vitest'
import { toSessionPrincipal } from '../session-principal'
import { _resetCurrentServerConfigForTest, currentServerConfig, setCurrentServerConfig } from '../../config/current'
import type { StudioPrincipalSummary } from '@ion/shared/studio-wire/types'

afterEach(() => {
  _resetCurrentServerConfigForTest()
})

const summary: StudioPrincipalSummary = {
  subject: 'entra-oid-teammate',
  provider: 'entra',
  kind: 'operator',
  displayName: 'teammate@dciartform.com',
}

// Pins the multiTenant flag toSessionPrincipal now sets from isSharedTenancy():
// the engine (engine/internal/session/start_session.go's
// promoteSessionPrincipalProcessWide) uses it to decide whether a session's
// principal is safe to promote process-wide for telemetry.
describe('toSessionPrincipal multiTenant flag', () => {
  it('omits multiTenant on the default (isSharedTenancy true — single-person) install', () => {
    setCurrentServerConfig({ ...currentServerConfig(), tenancyDefault: 'shared' })
    expect(toSessionPrincipal(summary).multiTenant).toBeUndefined()
  })

  it('omits multiTenant when tenancy.mode is explicitly shared', () => {
    setCurrentServerConfig({ ...currentServerConfig(), tenancy: { mode: 'shared' } })
    expect(toSessionPrincipal(summary).multiTenant).toBeUndefined()
  })

  it('sets multiTenant true when tenancy.mode is explicitly isolated (the genuine multi-person case)', () => {
    setCurrentServerConfig({ ...currentServerConfig(), tenancy: { mode: 'isolated' } })
    expect(toSessionPrincipal(summary).multiTenant).toBe(true)
  })

  it('sets multiTenant true on the standard install-profile default (no explicit tenancy.mode)', () => {
    setCurrentServerConfig({ ...currentServerConfig(), tenancyDefault: 'isolated' })
    expect(toSessionPrincipal(summary).multiTenant).toBe(true)
  })
})
