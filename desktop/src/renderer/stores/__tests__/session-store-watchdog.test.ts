import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const preferences = {
  tabRecoveryEnabled: true,
  tabRecoveryTimeoutSec: 60,
}

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => preferences },
}))
vi.mock('../../components/TerminalInstance', () => ({ serializeTerminalBuffer: () => null }))
vi.mock('../../../shared/tab-predicates', () => ({ tabHasExtensions: () => false }))
vi.mock('../serialize-conversation-pane', () => ({
  serializeConversationPane: () => null,
  collectExternalInstanceMessages: () => null,
  isExtensionErrorMessage: () => false,
  resolvePersistedLastKnownSessionId: () => null,
}))
vi.mock('../../../shared/types-persistence', () => ({ EXTERNALIZE_SCHEMA_VERSION: 4 }))

import { lastArrivalAt, markEventArrival, pruneEventLiveness } from '../event-liveness'
import { scanForStuckTabs } from '../session-store-persistence'

function storeFor(tab: Record<string, unknown>) {
  const autoRecoverStuckTab = vi.fn()
  return {
    getState: () => ({ tabs: [tab], autoRecoverStuckTab }),
    autoRecoverStuckTab,
  }
}

describe('stuck-tab watchdog liveness clock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-14T21:58:28.896Z'))
    preferences.tabRecoveryEnabled = true
    preferences.tabRecoveryTimeoutSec = 60
  })

  afterEach(() => {
    pruneEventLiveness([])
    vi.useRealTimers()
  })

  it('does not recover a tab with a fresh arrival while its renderer clock is frozen', () => {
    const store = storeFor({
      id: 'tab-1', status: 'running', activeRequestId: 'request-1',
      lastEventAt: Date.now() - 61_000,
    })
    // Models a hidden window: IPC arrived, but requestAnimationFrame did not
    // flush it through the reducer to update lastEventAt.
    markEventArrival('tab-1', Date.now())

    scanForStuckTabs(store as unknown as Parameters<typeof scanForStuckTabs>[0])

    expect(store.autoRecoverStuckTab).not.toHaveBeenCalled()
  })

  it('still recovers a tab with no recent transport arrival', () => {
    const store = storeFor({
      id: 'tab-1', status: 'running', activeRequestId: 'request-1',
      lastEventAt: Date.now() - 61_000,
    })

    scanForStuckTabs(store as unknown as Parameters<typeof scanForStuckTabs>[0])

    expect(store.autoRecoverStuckTab).toHaveBeenCalledWith('tab-1')
  })

  it('prunes liveness for a closed tab during a scan', () => {
    markEventArrival('closed-tab', Date.now())
    const store = storeFor({
      id: 'open-tab', status: 'idle', activeRequestId: null, lastEventAt: null,
    })

    scanForStuckTabs(store as unknown as Parameters<typeof scanForStuckTabs>[0])

    expect(lastArrivalAt('closed-tab')).toBeNull()
  })
})
