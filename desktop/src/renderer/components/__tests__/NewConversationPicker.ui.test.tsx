// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const createConversationTab = vi.fn().mockResolvedValue('tab-created')
const gitFetch = vi.fn().mockResolvedValue({ ok: true })
const gitBranches = vi.fn().mockResolvedValue({ current: 'main', branches: [{ name: 'main', isRemote: false }, { name: 'release', isRemote: false }] })
const close = vi.fn()
const preferenceState = {
  projects: {} as Record<string, { addedManually: boolean; lastUsedAt: number; isDefault?: boolean; profileOverride?: { kind: 'plain' } }>,
  engineProfiles: [{ id: 'dev', name: 'Development', extensions: ['ext/dev'] }],
  enterpriseNewConversationDefaults: null as null | { locked: boolean; baseDirectory: string; engineProfileId: string },
}

vi.mock('../../theme', () => ({ useColors: () => ({ scrim: 'rgba(0,0,0,.2)', popoverBg: '#111', popoverBorder: '#222', popoverShadow: 'none', textPrimary: '#fff', textSecondary: '#ccc', textTertiary: '#999', tabActive: '#333' }) }))
vi.mock('../../components/PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../../preferences', () => ({ usePreferencesStore: (selector: (state: typeof preferenceState) => unknown) => selector(preferenceState) }))
vi.mock('../../stores/sessionStore', () => ({ useSessionStore: { getState: () => ({ createConversationTab }) } }))
vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rError: vi.fn() }))

import { NewConversationPicker } from '../NewConversationPicker'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function render(props: React.ComponentProps<typeof NewConversationPicker> = { onClose: close }): void {
  root = createRoot(container)
  act(() => { root.render(<NewConversationPicker {...props} />) })
}

beforeEach(() => {
  vi.clearAllMocks()
  preferenceState.projects = { '/work/alpha': { addedManually: true, lastUsedAt: 0 }, '/work/beta': { addedManually: true, lastUsedAt: 0, isDefault: true } }
  preferenceState.engineProfiles = [{ id: 'dev', name: 'Development', extensions: ['ext/dev'] }]
  preferenceState.enterpriseNewConversationDefaults = null
  container = document.createElement('div')
  document.body.appendChild(container)
  Object.assign(window, { ion: { gitFetch, gitBranches } })
})

afterEach(() => { act(() => root.unmount()); container.remove() })

describe('NewConversationPicker', () => {
  it('uses the starred Project and asks for a conversation type without a worktree page', () => {
    render()
    expect(document.body.textContent).toContain('Choose conversation type')
    expect(document.body.textContent).not.toContain('Source repository')
  })

  it('bypasses the saved Project profile choice when requested', () => {
    preferenceState.projects = { '/work/beta': { addedManually: true, lastUsedAt: 0, isDefault: true, profileOverride: { kind: 'plain' } } }
    render({ forceProfilePicker: true, onClose: close })

    expect(document.body.textContent).toContain('Choose conversation type')
    expect(document.body.textContent).toContain('Development')
  })
  it('creates a normal plain conversation in the starred Project', async () => {
    render()
    const plain = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Plain conversation'))!
    await act(async () => { plain.click(); await Promise.resolve() })
    expect(createConversationTab).toHaveBeenCalledWith('/work/beta', expect.objectContaining({}))
  })

  it('uses an explicit Project selection when no default Project exists', async () => {
    preferenceState.projects = { '/work/alpha': { addedManually: true, lastUsedAt: 0 } }
    render()
    expect(document.body.textContent).toContain('Projects')
    act(() => { [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('alpha'))?.click() })
    expect(document.body.textContent).toContain('Choose conversation type')
    expect(document.body.textContent).not.toContain('Source repository')
  })

  it('opens source branches only for an explicit new-worktree route', async () => {
    render({ initialDirectory: '/work/alpha', initialUseWorktree: true, onClose: close })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(document.body.textContent).toContain('Choose source branch')
    act(() => { [...document.querySelectorAll('button')].find((button) => button.textContent?.startsWith('release'))?.click() })
    const plain = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Plain conversation'))!
    await act(async () => { plain.click(); await Promise.resolve() })
    expect(createConversationTab).toHaveBeenCalledWith('/work/alpha', expect.objectContaining({ useWorktree: true, sourceBranch: 'release' }))
  })

  it('applies a locked enterprise directory and profile without showing the picker', async () => {
    preferenceState.enterpriseNewConversationDefaults = { locked: true, baseDirectory: '/corp/project', engineProfileId: 'corp-profile' }
    render({ initialDirectory: '/work/alpha', onClose: close })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(createConversationTab).toHaveBeenCalledWith('/corp/project', expect.objectContaining({ profileId: 'corp-profile', projectDirectory: '/work/alpha' }))
    expect(document.body.textContent).not.toContain('Choose conversation type')
  })
})
