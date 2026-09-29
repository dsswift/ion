/**
 * An import writes the tab record to the tabs file; the live store owns that
 * file. Before adoption the store never learned of the tab, so the next save
 * would have dropped it, the save guard refused every save from then on, and
 * the conversation never appeared.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), log: vi.fn(), error: vi.fn() }))

import { useSessionStore } from '../../store/sessionStore'
import { adoptImportedTab } from '../adopt-imported-tab'
import { makeTestPaths, minimalPersistedTab, writeTabsFile } from './fixtures'

describe('adoptImportedTab', () => {
  it('puts the imported conversation into the live store, once', async () => {
    const paths = makeTestPaths('adopt')
    const record = { ...minimalPersistedTab({ id: 'imported-tab', conversationId: 'conv-imported' }), workingDirectory: '/tmp', title: 'What color is the sky?' }
    writeTabsFile(paths.tabsFile, [record])
    expect(useSessionStore.getState().tabs.some((t) => t.id === 'imported-tab')).toBe(false)

    expect(await adoptImportedTab(paths.tabsFile, 'imported-tab')).toBe(true)
    const live = useSessionStore.getState().tabs.filter((t) => t.id === 'imported-tab')
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ conversationId: 'conv-imported', workingDirectory: '/tmp', title: 'What color is the sky?' })

    expect(await adoptImportedTab(paths.tabsFile, 'imported-tab')).toBe(true)
    expect(useSessionStore.getState().tabs.filter((t) => t.id === 'imported-tab')).toHaveLength(1)
  })

  it('reports false when the tabs file has no such record', async () => {
    const paths = makeTestPaths('adopt-missing')
    writeTabsFile(paths.tabsFile, [])
    expect(await adoptImportedTab(paths.tabsFile, 'nowhere')).toBe(false)
  })
})
