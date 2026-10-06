// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const prefs = { enterpriseNewConversationDefaults: null as null | { locked: boolean; baseDirectory: string; engineProfileId: string } }
vi.mock('../../preferences', () => ({ usePreferencesStore: Object.assign((selector: (s: typeof prefs) => unknown) => selector(prefs), { getState: () => prefs }) }))
vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#111' }) }))
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: (selector: (s: unknown) => unknown) => selector({ setBaseDirectory: vi.fn(), tabs: [], activeTabId: '' }) }))
vi.mock('@ion/server/store/remote-fs-store', () => ({ pickDirectoryForSession: vi.fn() }))
vi.mock('../../rendererLogger', () => ({ rError: vi.fn() }))

import { EmptyState } from './EmptyState'

let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
function render(): void {
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  act(() => { root.render(<EmptyState />) })
}
afterEach(() => { act(() => root.unmount()); container.remove() })

describe('EmptyState', () => {
  it('offers Choose folder when nothing locks the folder', () => {
    prefs.enterpriseNewConversationDefaults = null
    render()
    expect(container.textContent).toContain('Choose folder')
  })

  it('offers no folder choice under a directory lock', () => {
    prefs.enterpriseNewConversationDefaults = { locked: true, baseDirectory: '/o', engineProfileId: 'orion' }
    render()
    expect(container.textContent).not.toContain('Choose folder')
  })
})
