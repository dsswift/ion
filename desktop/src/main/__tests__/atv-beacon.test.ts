import { describe, it, expect, vi } from 'vitest'
import type { NormalizedEvent } from '../../shared/types'

vi.mock('electron', () => ({ app: { dock: { bounce: vi.fn() } } }))
vi.mock('../state', () => ({ state: { atvWindow: null } }))
vi.mock('../settings-store', () => ({ readSettings: () => ({}) }))
vi.mock('../logger', () => ({ log: vi.fn() }))

// Pure-core test: shouldBeacon only (the electron shell is untestable here).
import { shouldBeacon } from '../atv-beacon'

const perm = { type: 'permission_request', questionId: 'q', toolName: 'Bash', options: [] } as unknown as NormalizedEvent
const status = { type: 'status', fields: { state: 'running' } } as unknown as NormalizedEvent

describe('shouldBeacon', () => {
  it('fires only for permission requests while open + unfocused + enabled', () => {
    expect(shouldBeacon(perm, true, false, true)).toEqual(['bounce', 'title'])
  })
  it('suppressed when focused, closed, disabled, or wrong event', () => {
    expect(shouldBeacon(perm, true, true, true)).toEqual([])
    expect(shouldBeacon(perm, false, false, true)).toEqual([])
    expect(shouldBeacon(perm, true, false, false)).toEqual([])
    expect(shouldBeacon(status, true, false, true)).toEqual([])
  })
})
