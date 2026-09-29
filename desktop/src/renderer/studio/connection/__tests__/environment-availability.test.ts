// @vitest-environment jsdom
/**
 * environment-availability — the grace window between "the wire dropped"
 * and "this Environment shows nothing".
 *
 * The two behaviours that matter: a blip must not clear the Tab Strip, and
 * a real outage must not leave another machine's conversations on screen
 * looking live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentPhaseState } from '@ion/shared/types-environments'

let phaseListener: ((states: Map<string, EnvironmentPhaseState>) => void) | null = null

vi.mock('../../state/secondary-store-purge', () => ({ dropEnvironmentState: vi.fn() }))
vi.mock('../registry', () => ({
  registry: {
    subscribe: (cb: (states: Map<string, EnvironmentPhaseState>) => void) => {
      phaseListener = cb
      return () => { phaseListener = null }
    },
  },
}))
vi.mock('../catalog', () => ({ readCatalog: vi.fn(async () => [{ id: 'grover', label: 'grover', target: { kind: 'paired', label: 'grover', url: 'http://grover:7331' } }]) }))

import { environmentAvailability, RECONNECT_GRACE_MS } from '../environment-availability'
import { dropEnvironmentState as dropMock } from '../../state/secondary-store-purge'

const dropEnvironmentState = vi.mocked(dropMock)

function phase(p: EnvironmentPhaseState['phase']): Map<string, EnvironmentPhaseState> {
  return new Map([['grover', { phase: p } as EnvironmentPhaseState]])
}

describe('environment availability', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    dropEnvironmentState.mockClear()
    environmentAvailability.dispose()
    environmentAvailability.boot()
  })

  afterEach(() => {
    environmentAvailability.dispose()
    vi.useRealTimers()
  })

  it('holds the rows, inert, through a blip and never drops them when the wire comes back', () => {
    phaseListener?.(phase('connected'))
    expect(environmentAvailability.availabilityOf('grover')).toBe('connected')

    phaseListener?.(phase('backoff'))
    expect(environmentAvailability.availabilityOf('grover')).toBe('reconnecting')

    vi.advanceTimersByTime(RECONNECT_GRACE_MS - 500)
    phaseListener?.(phase('connected'))
    vi.advanceTimersByTime(RECONNECT_GRACE_MS * 2)

    expect(environmentAvailability.availabilityOf('grover')).toBe('connected')
    expect(dropEnvironmentState).not.toHaveBeenCalled()
  })

  it('drops the environment once the wire has stayed down past the grace window', () => {
    phaseListener?.(phase('connected'))
    phaseListener?.(phase('offline'))
    expect(environmentAvailability.availabilityOf('grover')).toBe('reconnecting')
    expect(dropEnvironmentState).not.toHaveBeenCalled()

    vi.advanceTimersByTime(RECONNECT_GRACE_MS + 1)

    expect(environmentAvailability.availabilityOf('grover')).toBe('offline')
    expect(dropEnvironmentState).toHaveBeenCalledWith('grover')
  })

  /**
   * An Environment that was never reachable has nothing on screen to take
   * away, so it is offline from the first phase rather than spending five
   * seconds claiming to reconnect.
   */
  it('reports an environment that never connected as offline immediately, with nothing to drop', () => {
    phaseListener?.(phase('backoff'))
    expect(environmentAvailability.availabilityOf('grover')).toBe('offline')
    vi.advanceTimersByTime(RECONNECT_GRACE_MS * 2)
    expect(dropEnvironmentState).not.toHaveBeenCalled()
  })

  it('lists what is not answering for the title bar, and stops listing it on reconnect', () => {
    phaseListener?.(phase('connected'))
    expect(environmentAvailability.all().get('grover')?.availability).toBe('connected')

    phaseListener?.(phase('backoff'))
    const degraded = [...environmentAvailability.all().values()].filter((e) => e.availability !== 'connected')
    expect(degraded.map((e) => e.environmentId)).toEqual(['grover'])

    phaseListener?.(phase('connected'))
    expect([...environmentAvailability.all().values()].filter((e) => e.availability !== 'connected')).toEqual([])
  })
})
