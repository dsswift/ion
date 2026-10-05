// @vitest-environment jsdom
/**
 * The worktree branch step: the Ephemeral and Remember choices, the
 * remembered branch skipping the step, and choosing it again.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const createConversationTab = vi.fn().mockResolvedValue('tab-created')
const gitFetch = vi.fn().mockResolvedValue({ ok: true })
const gitBranches = vi.fn().mockResolvedValue({ current: 'main', branches: [{ name: 'main', isRemote: false }, { name: 'release', isRemote: false }] })
const resolveNewConversationDefaults = vi.fn().mockResolvedValue(null)
const gitWorktreeEphemeralDefault = vi.fn().mockResolvedValue({ ephemeral: true, source: 'manifest' })
const close = vi.fn()
const preferenceState = {
  projects: {} as Record<string, { addedManually: boolean; lastUsedAt: number; isDefault?: boolean; profileOverride?: { kind: 'plain' } }>,
  engineProfiles: [{ id: 'dev', name: 'Development', extensions: ['ext/dev'] }],
  enterpriseNewConversationDefaults: null as null | { locked: boolean; baseDirectory: string; engineProfileId: string },
}

vi.mock('../../theme', () => ({ useColors: () => ({ scrim: 'rgba(0,0,0,.2)', popoverBg: '#111', popoverBorder: '#222', popoverShadow: 'none', textPrimary: '#fff', textSecondary: '#ccc', textTertiary: '#999', tabActive: '#333', accent: '#0af' }) }))
vi.mock('../../components/PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../../preferences', () => ({ usePreferencesStore: (selector: (state: typeof preferenceState) => unknown) => selector(preferenceState) }))
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: { getState: () => ({ createConversationTab }) } }))
vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rError: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn() }))

import { NewConversationPicker } from '../NewConversationPicker'
import { installFakeWire } from '../../host/__tests__/fake-wire'

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
  Object.assign(window, { ion: installFakeWire({ gitFetch, gitBranches, resolveNewConversationDefaults, gitWorktreeEphemeralDefault }) })
})

afterEach(() => { act(() => root.unmount()); container.remove() })

const settle = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }) }
const button = (text: string): HTMLButtonElement => [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text)) as HTMLButtonElement
const checkbox = (label: string): HTMLButtonElement => document.querySelector(`[role="checkbox"][aria-label="${label}"]`) as HTMLButtonElement

describe('NewConversationPicker worktree choices', () => {
  it('preselects Ephemeral from the project default and sends both choices with the branch', async () => {
    render({ initialDirectory: '/work/alpha', initialUseWorktree: true, onClose: close })
    await settle()

    expect(gitWorktreeEphemeralDefault).toHaveBeenCalledWith({ repoPath: '/work/alpha' })
    expect(checkbox('Ephemeral').getAttribute('aria-checked')).toBe('true')
    expect(checkbox('Remember for this project').getAttribute('aria-checked')).toBe('true')

    act(() => { checkbox('Ephemeral').click() })
    act(() => { button('release').click() })
    await act(async () => { button('Plain conversation').click(); await Promise.resolve() })

    expect(createConversationTab).toHaveBeenCalledWith('/work/alpha', expect.objectContaining({
      useWorktree: true, sourceBranch: 'release', ephemeralWorktree: false, rememberWorktreeChoice: true,
    }))
  })

  it('does not remember the choice when Remember is cleared', async () => {
    render({ initialDirectory: '/work/alpha', initialUseWorktree: true, onClose: close })
    await settle()
    act(() => { checkbox('Remember for this project').click() })
    act(() => { button('main').click() })
    await act(async () => { button('Plain conversation').click(); await Promise.resolve() })

    const opts = createConversationTab.mock.calls[0][1] as Record<string, unknown>
    expect(opts).toMatchObject({ sourceBranch: 'main', ephemeralWorktree: true })
    expect(opts).not.toHaveProperty('rememberWorktreeChoice')
  })

  it('skips the branch step with a remembered branch and leaves ephemeral to the server', async () => {
    render({ initialDirectory: '/work/alpha', initialUseWorktree: true, initialSourceBranch: 'release', onClose: close })
    await settle()

    expect(document.body.textContent).not.toContain('Remember for this project')
    expect(gitWorktreeEphemeralDefault).not.toHaveBeenCalled()
    await act(async () => { button('Plain conversation').click(); await Promise.resolve() })
    const opts = createConversationTab.mock.calls[0][1] as Record<string, unknown>
    expect(opts).toMatchObject({ useWorktree: true, sourceBranch: 'release' })
    expect(opts).not.toHaveProperty('ephemeralWorktree')
    expect(opts).not.toHaveProperty('rememberWorktreeChoice')
  })

  it('shows the branch step again on request, with the remembered branch highlighted', async () => {
    render({ initialDirectory: '/work/alpha', initialUseWorktree: true, initialSourceBranch: 'release', initialChooseBranch: true, onClose: close })
    await settle()

    expect(document.body.textContent).toContain('Remember for this project')
    const input = document.querySelector('input[aria-label="New conversation search"]') as HTMLInputElement
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await Promise.resolve() })
    await act(async () => { button('Plain conversation').click(); await Promise.resolve() })
    expect(createConversationTab).toHaveBeenCalledWith('/work/alpha', expect.objectContaining({ sourceBranch: 'release', rememberWorktreeChoice: true }))
  })
})
