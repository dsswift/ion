// @vitest-environment jsdom
import { describe as suite, expect, it, vi } from 'vitest'

vi.mock('../registry', () => ({ registry: { subscribe: () => () => {}, refresh: vi.fn() } }))
vi.mock('../EnvironmentUnavailable', () => ({ openEnvironmentSettings: vi.fn() }))

import { describe } from '../EnvironmentStatusIndicator'
import type { EnvironmentAvailabilityEntry } from '../environment-availability'

const entry = (over: Partial<EnvironmentAvailabilityEntry>): EnvironmentAvailabilityEntry => ({ environmentId: 'devbox', label: 'devbox', availability: 'offline', since: null, ...over })

suite('EnvironmentStatusIndicator describe', () => {
  it('says a server on an incompatible version is incompatible, not offline', () => {
    expect(describe(entry({ reason: 'protocol_version' }))).toContain('incompatible version')
    expect(describe(entry({ reason: 'protocol_version' }))).not.toContain('offline')
  })

  it('says an unreachable server is offline', () => {
    expect(describe(entry({ reason: 'server_unreachable' }))).toContain('offline')
    expect(describe(entry({ availability: 'reconnecting' }))).toContain('reconnecting')
  })
})
