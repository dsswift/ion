// @vitest-environment jsdom
/**
 * Stash flow: Mod+S sets the prompt and its attachments aside under the source
 * project, persists through the settings funnel, and restore brings both back.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const store = { clearAttachments: vi.fn(), setDraftInput: vi.fn(), addAttachments: vi.fn() }
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: { getState: () => store } }))
vi.mock('../../studio/surface/surface-scratch', () => ({ scratchProjectKey: (tab?: { workingDirectory: string }) => tab?.workingDirectory ?? null }))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn() }))

const studioSetSetting = vi.fn(async (_key: string, _value: unknown) => true)
vi.mock('../../host/host-instance', () => ({
  host: { shell: {
    studioSetSetting: (key: string, value: unknown) => studioSetSetting(key, value),
    studioGetSettings: async () => ({ studioComposerStash: { version: 1, projects: {} } }),
    onSettingsChanged: () => () => undefined,
  } },
}))

import { parseComposerStash } from '@ion/shared/composer-stash'
import { useComposerStash, type ComposerStashApi } from './useComposerStash'
import { useComposerStashStore } from './composer-stash-store'
import { stashEntryTitle } from './ComposerStashButton'

const tab = { id: 'tab-1', workingDirectory: '/src/ion', worktree: undefined } as unknown as Parameters<typeof useComposerStash>[0]
const attachment = { id: 'a1', type: 'image' as const, name: 'shot.png', path: '/img/shot.png', dataUrl: 'data:image/png;base64,AAAA' }

describe('useComposerStash', () => {
  let root: Root
  let api: ComposerStashApi
  let text = ''
  const setText = vi.fn((next: string) => { text = next })

  function Probe(): null { api = useComposerStash(tab, text, text ? [attachment] : [], setText); return null }
  const render = async (): Promise<void> => { await act(async () => { root.render(<Probe />) }) }
  const press = (init: KeyboardEventInit): { handled: boolean; event: KeyboardEvent } => {
    const event = new KeyboardEvent('keydown', { cancelable: true, ...init })
    let handled = false
    act(() => { handled = api.handleKeyDown(event) })
    return { handled, event }
  }

  afterEach(() => {
    act(() => root.unmount())
    vi.clearAllMocks()
    text = ''
    useComposerStashStore.setState({ stash: { version: 1, projects: {} } })
  })

  it('stashes on Mod+S, clears the composer, and persists a valid stash without the image preview', async () => {
    root = createRoot(document.createElement('div'))
    text = 'finish the parser'
    await render()
    const { handled, event } = press({ key: 's', metaKey: true })
    expect(handled).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(setText).toHaveBeenCalledWith('')
    expect(store.clearAttachments).toHaveBeenCalled()
    expect(store.setDraftInput).toHaveBeenCalledWith('tab-1', '')

    const [key, value] = studioSetSetting.mock.calls[0]
    expect(key).toBe('studioComposerStash')
    const persisted = parseComposerStash(JSON.parse(JSON.stringify(value)))!
    expect(persisted.projects['/src/ion'][0]).toMatchObject({ text: 'finish the parser', attachments: [{ path: '/img/shot.png' }] })
    expect(JSON.stringify(value)).not.toContain('base64')
  })

  it('takes the chord but stashes nothing when the composer is empty', async () => {
    root = createRoot(document.createElement('div'))
    await render()
    expect(press({ key: 's', ctrlKey: true }).handled).toBe(true)
    expect(studioSetSetting).not.toHaveBeenCalled()
    expect(press({ key: 's' }).handled).toBe(false)
  })

  it('restores text and attachments and removes the entry', async () => {
    root = createRoot(document.createElement('div'))
    text = 'set aside'
    await render()
    press({ key: 's', metaKey: true })
    text = ''
    await render()
    expect(api.entries).toHaveLength(1)
    act(() => api.restore(api.entries[0]))
    expect(setText).toHaveBeenLastCalledWith('set aside')
    expect(store.addAttachments).toHaveBeenCalledWith([expect.objectContaining({ path: '/img/shot.png' })])
    await render()
    expect(api.entries).toHaveLength(0)
  })

  it('titles an entry by its first non-empty line', () => {
    expect(stashEntryTitle({ text: '\n  do the thing\nmore', attachments: [] })).toBe('do the thing')
    expect(stashEntryTitle({ text: '', attachments: [{ id: '1', type: 'file', name: 'a.txt', path: '/a.txt' }] })).toBe('a.txt')
  })
})
