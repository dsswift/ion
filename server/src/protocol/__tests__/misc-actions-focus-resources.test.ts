/**
 * `presence.focus` as the operator's focus, and the `resource.*` write
 * verbs that replaced the desktop's resource-wiring IPC.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  setFocusedTab: vi.fn(),
  publishTabFocus: vi.fn(),
  notifyStudioActiveTab: vi.fn(),
  publishResourceMarkRead: vi.fn(async () => undefined),
  publishResourceDelete: vi.fn(async () => undefined),
  resourceGet: vi.fn(async () => undefined),
  markReadPersisted: vi.fn(),
  markDeletedPersisted: vi.fn(),
  state: { studioActiveTabId: null as string | null, studioActiveProfileId: null as string | null, remoteTransport: null },
}))
vi.mock('../presence', () => ({ setFocusedTab: deps.setFocusedTab, setAttention: vi.fn() }))
vi.mock('../../engine/event-wiring-resources', () => ({
  publishTabFocus: deps.publishTabFocus,
  publishResourceMarkRead: deps.publishResourceMarkRead,
  publishResourceDelete: deps.publishResourceDelete,
  resourceGet: deps.resourceGet,
}))
vi.mock('../../engine/event-wiring-resource-state', () => ({
  markReadPersisted: deps.markReadPersisted,
  markDeletedPersisted: deps.markDeletedPersisted,
  getPersistedReadIds: vi.fn(() => []),
  projectPersistedResourceState: vi.fn((x: unknown) => x),
  isResourceRead: vi.fn(() => false),
}))
vi.mock('../../engine/studio-window-manager', () => ({ notifyStudioActiveTab: deps.notifyStudioActiveTab }))
const catalogGetItem = vi.hoisted(() => vi.fn<(kind: string, id: string, producer?: string) => { content?: string } | undefined>())
vi.mock('../../engine/resource-catalog', () => ({ resourceCatalog: { bootstrapItems: vi.fn(() => []), getItem: catalogGetItem } }))
vi.mock('../../engine/studio-state-cache', () => ({ getStudioState: vi.fn(() => ({ agents: [] })) }))
vi.mock('../../state', () => ({ state: deps.state }))
vi.mock('../../questions/questions-wiring', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../questions/questions-wiring')>()), applyQuestionsAction: vi.fn(), applyQuestionsPatch: vi.fn(), questionsSnapshot: vi.fn() }))
vi.mock('../../theme-packs', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../theme-packs')>()), getRendererThemes: vi.fn(() => []) }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { MISC_ACTIONS } from '../misc-actions'
import type { Connection } from '../connection'

const desktop = { id: 'd', transport: 'local', clientKind: 'desktop', principal: { subject: 'local:josh' } } as unknown as Connection
const web = { id: 'w', transport: 'tcp', clientKind: 'web', principal: { subject: 'oidc:alice' } } as unknown as Connection

beforeEach(() => {
  for (const v of Object.values(deps)) if (typeof v === 'function') (v as ReturnType<typeof vi.fn>).mockClear()
  deps.state.studioActiveTabId = null
  deps.state.studioActiveProfileId = null
})

describe('presence.focus', () => {
  it('records presence for every caller, and for the local desktop also moves the operator focus', async () => {
    expect(await MISC_ACTIONS['presence.focus'].handler(desktop, ['tab-1', 'example-profile'])).toEqual({ ok: true, value: null })
    expect(deps.setFocusedTab).toHaveBeenCalledWith(desktop, 'tab-1')
    expect(deps.state.studioActiveTabId).toBe('tab-1')
    expect(deps.state.studioActiveProfileId).toBe('example-profile')
    expect(deps.publishTabFocus).toHaveBeenCalledWith('tab-1')
    expect(deps.notifyStudioActiveTab).toHaveBeenCalledWith('tab-1')
    // What `studio.getState` answers without a tabId.
    expect(await MISC_ACTIONS['studio.getState'].handler(desktop, [])).toMatchObject({ ok: true, value: { activeTabId: 'tab-1', activeProfileId: 'example-profile' } })
  })

  it('a visiting client\'s focus is presence only, never the Environment\'s', async () => {
    await MISC_ACTIONS['presence.focus'].handler(web, ['tab-9', 'example-profile'])
    expect(deps.setFocusedTab).toHaveBeenCalledWith(web, 'tab-9')
    expect(deps.state.studioActiveTabId).toBeNull()
    expect(deps.publishTabFocus).not.toHaveBeenCalled()
    expect(deps.notifyStudioActiveTab).not.toHaveBeenCalled()
  })

  it('clearing focus (null) touches presence only, and a non-string is refused', async () => {
    deps.state.studioActiveTabId = 'tab-1'
    await MISC_ACTIONS['presence.focus'].handler(desktop, [null])
    expect(deps.setFocusedTab).toHaveBeenCalledWith(desktop, null)
    expect(deps.state.studioActiveTabId).toBe('tab-1')
    expect((await MISC_ACTIONS['presence.focus'].handler(desktop, [7])).ok).toBe(false)
  })
})

describe('resource.markRead / resource.delete / resource.get', () => {
  it('markRead persists the read identity and fans the delta through the broker', async () => {
    expect(await MISC_ACTIONS['resource.markRead'].handler(web, [{ kind: 'briefing', resourceId: 'r1', producer: 'p' }])).toEqual({ ok: true, value: null })
    expect(deps.markReadPersisted).toHaveBeenCalledWith('r1', 'p', 'briefing')
    expect(deps.publishResourceMarkRead).toHaveBeenCalledWith('briefing', 'r1', 'p')
  })

  it('delete tombstones and fans the delete', async () => {
    await MISC_ACTIONS['resource.delete'].handler(web, [{ kind: 'briefing', resourceId: 'r1' }])
    expect(deps.markDeletedPersisted).toHaveBeenCalledWith('r1', undefined, 'briefing')
    expect(deps.publishResourceDelete).toHaveBeenCalledWith('briefing', 'r1', undefined)
  })

  it('get forwards the addressing options to the producer query', async () => {
    await MISC_ACTIONS['resource.get'].handler(web, [{ kind: 'briefing', id: 'r1', global: true, producer: 'p', sessionKey: 'k' }])
    expect(deps.resourceGet).toHaveBeenCalledWith('briefing', 'r1', { sessionKey: 'k', global: true, producer: 'p' })
  })

  it('resource.get fromCatalog answers the content this server holds without asking the producer', async () => {
    catalogGetItem.mockReturnValueOnce({ content: '# Briefing' })
    expect(await MISC_ACTIONS['resource.get'].handler(web, [{ kind: 'briefing', id: 'r1', producer: 'p', fromCatalog: true }]))
      .toEqual({ ok: true, value: { kind: 'briefing', id: 'r1', producer: 'p', content: '# Briefing' } })
    expect(catalogGetItem).toHaveBeenCalledWith('briefing', 'r1', 'p')
    expect(deps.resourceGet).not.toHaveBeenCalled()
  })

  it('resource.get fromCatalog asks the producer on a miss and answers empty content', async () => {
    catalogGetItem.mockReturnValueOnce(undefined)
    expect(await MISC_ACTIONS['resource.get'].handler(web, [{ kind: 'briefing', id: 'r2', fromCatalog: true }]))
      .toEqual({ ok: true, value: { kind: 'briefing', id: 'r2', producer: undefined, content: '' } })
    expect(deps.resourceGet).toHaveBeenCalledWith('briefing', 'r2', { sessionKey: undefined, global: undefined, producer: undefined })
  })

  it('resource.get without the option still answers null', async () => {
    expect(await MISC_ACTIONS['resource.get'].handler(web, [{ kind: 'briefing', id: 'r1' }])).toEqual({ ok: true, value: null })
  })

  it('refuses a write or read with no kind or id, without touching persistence', async () => {
    await MISC_ACTIONS['resource.markRead'].handler(web, [{ kind: 'briefing' }])
    await MISC_ACTIONS['resource.delete'].handler(web, [{ resourceId: 'r1' }])
    await MISC_ACTIONS['resource.get'].handler(web, [{}])
    expect(deps.markReadPersisted).not.toHaveBeenCalled()
    expect(deps.markDeletedPersisted).not.toHaveBeenCalled()
    expect(deps.resourceGet).not.toHaveBeenCalled()
  })

  it('writes are conversations:operate, the read is conversations:read', () => {
    expect(MISC_ACTIONS['resource.markRead'].requiredScope).toBe('conversations:operate')
    expect(MISC_ACTIONS['resource.delete'].requiredScope).toBe('conversations:operate')
    expect(MISC_ACTIONS['resource.get'].requiredScope).toBe('conversations:read')
  })
})
