// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationWorkspace } from '@ion/shared/types'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { useEnvironmentSettingsStore } from '../state/environment-settings-store'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const benchRerereCount = vi.fn(async () => 0)
const benchResolveConflict = vi.fn(async () => '/integration/repo-main')

vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({ benchRerereCount, benchResolveConflict }),
  },
}))

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ uiZoom: 1 }) },
}))

vi.mock('../../rendererLogger', () => ({
  rError: vi.fn(),
}))

vi.mock('../../components/git/ConflictsDialog', () => ({
  ConflictsDialog: ({ directory }: { directory: string }) => <div data-testid="conflicts-dialog">{directory}</div>,
}))

import { InboxBenchMenu } from './InboxBenchMenu'

const workspace: IntegrationWorkspace = {
  repoPath: '/repo',
  sourceBranch: 'main',
  benchPath: '/integration/repo-main',
  benchBranch: 'ion/bench/main',
  members: [],
  baseSha: 'abc123',
  lastBuiltAt: 0,
}

let host: HTMLDivElement
let outside: HTMLButtonElement
let root: ReturnType<typeof createRoot>
let onClose: ReturnType<typeof vi.fn<() => void>>

async function renderMenu(): Promise<void> {
  await act(async () => {
    root.render(<InboxBenchMenu environmentId={LOCAL_ENVIRONMENT_ID} repoPath="/repo" workspace={workspace} anchor={{ x: 20, y: 20 }} onClose={onClose} />)
  })
}

beforeEach(() => {
  // A full-view connection: the server granted it the terminal scope.
  useEnvironmentSettingsStore.getState().hydrate(LOCAL_ENVIRONMENT_ID, {}, ['conversations:read', 'conversations:operate', 'terminal:operate'])
  vi.clearAllMocks()
  host = document.createElement('div')
  outside = document.createElement('button')
  document.body.append(host, outside)
  root = createRoot(host)
  onClose = vi.fn<() => void>()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  outside.remove()
})

describe('InboxBenchMenu dismissal', () => {
  it('closes when the operator clicks outside the menu', async () => {
    await renderMenu()

    act(() => {
      outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('opens ConflictsDialog for the recovered bench path', async () => {
    await renderMenu()
    const recover = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Recover conflict')
    if (!recover) throw new Error('recover conflict control did not render')
    await act(async () => { recover.click() })
    const confirm = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Recover conflict')
    if (!confirm) throw new Error('recover conflict confirmation did not render')
    await act(async () => { confirm.click() })

    expect(benchResolveConflict).toHaveBeenCalledWith('/repo', 'main')
    expect(document.querySelector('[data-testid="conflicts-dialog"]')?.textContent).toBe('/integration/repo-main')
  })

  it('offers Open Bench Terminal only to a connection with terminal:operate', async () => {
    await renderMenu()
    expect(host.ownerDocument.body.textContent).toContain('Open Bench Terminal')
    await act(async () => { useEnvironmentSettingsStore.getState().hydrate(LOCAL_ENVIRONMENT_ID, {}, ['conversations:read', 'conversations:operate']) })
    await renderMenu()
    expect(host.ownerDocument.body.textContent).not.toContain('Open Bench Terminal')
    expect(host.ownerDocument.body.textContent).toContain('Open Bench Conversation')
  })
})
