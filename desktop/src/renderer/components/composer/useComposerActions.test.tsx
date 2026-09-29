// @vitest-environment jsdom
/**
 * The `+` menu renders exactly the Composer Actions the server offers for the
 * active conversation, and choosing a row submits the extension's slash
 * command through the normal submit path. The hook derives nothing: which
 * conversations an action applies to is the server's decision.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComposerAction } from '@ion/shared/studio-sdk-contract'
import type { ComposerActionsState } from '@ion/shared/composer-actions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const submit = vi.fn(async (_tab: string, _text: string) => ({ accepted: true }))
const state = { activeTabId: 'tab-1' as string | null, submit }
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state }),
}))
vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn() }))

let offered: Record<string, ComposerAction[]> = {}
let publish: ((s: ComposerActionsState) => void) | null = null
const composerActions = vi.fn(async (tabId: string) => offered[tabId] ?? [])
vi.mock('../../host/host-instance', () => ({
  host: { shell: {
    composerActions: (tabId: string) => composerActions(tabId),
    onComposerActions: (cb: (s: ComposerActionsState) => void) => { publish = cb; return () => { publish = null } },
  } },
}))

import { useComposerActions } from './useComposerActions'
import type { ComposerPlusMenuItem } from './ComposerPlusMenu'

const briefing: ComposerAction = { id: 'briefing', producer: 'cos2', label: 'Briefing', icon: 'Newspaper', command: '/briefing' }

describe('useComposerActions', () => {
  let rows: ComposerPlusMenuItem[] = []
  function Probe(): null { rows = useComposerActions(); return null }
  const mount = async (): Promise<void> => { await act(async () => { createRoot(document.createElement('div')).render(<Probe />) }) }
  afterEach(() => { offered = {}; state.activeTabId = 'tab-1'; rows = []; vi.clearAllMocks() })

  it('renders the actions the server offers for the active conversation', async () => {
    offered = { 'tab-1': [briefing], 'tab-2': [{ ...briefing, id: 'other', label: 'Other' }] }
    await mount()
    expect(composerActions).toHaveBeenCalledWith('tab-1')
    expect(rows.map((r) => [r.id, r.label, r.detail])).toEqual([['cos2:briefing', 'Briefing', 'cos2']])
  })

  it('offers nothing in a conversation the server offers nothing for', async () => {
    offered = { 'tab-2': [briefing] }
    await mount()
    expect(rows).toEqual([])
  })

  it('replaces the list when the server publishes a change, and ignores another tab', async () => {
    await mount()
    expect(rows).toEqual([])
    act(() => publish?.({ tabId: 'tab-2', actions: [briefing] }))
    expect(rows).toEqual([])
    act(() => publish?.({ tabId: 'tab-1', actions: [briefing] }))
    expect(rows.map((r) => r.id)).toEqual(['cos2:briefing'])
    act(() => publish?.({ tabId: 'tab-1', actions: [] }))
    expect(rows).toEqual([])
  })

  it('submits the slash command when a row is chosen', async () => {
    offered = { 'tab-1': [briefing] }
    await mount()
    rows[0].onSelect()
    expect(submit).toHaveBeenCalledWith('tab-1', '/briefing')
  })
})
