// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const store = { activeTabId: 'tab-1' as string | null, addAttachments: vi.fn() }
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: { getState: () => store } }))
vi.mock('../../rendererLogger', () => ({ rError: vi.fn(), rInfo: vi.fn() }))
const saveAttachmentData = vi.fn(async (_tabId: string, name: string, _b64: string) => ({ id: 'att-1', type: 'file' as const, name, path: `/data/${name}` }))
vi.mock('../../host/host-instance', () => ({ host: { shell: { saveAttachmentData: (t: string, n: string, b: string) => saveAttachmentData(t, n, b) } } }))

import { addComposerContext, diffContextToken, reconcileContextLinks, stripContextTokens, useComposerContextStore } from './composer-context'
import { COMPOSER_INSERT_EVENT } from './composer-events'
import { findComposerChipTokens } from './composer-chips'

afterEach(() => { vi.clearAllMocks(); store.activeTabId = 'tab-1'; useComposerContextStore.setState({ links: {} }) })

describe('reconcileContextLinks', () => {
  const seen = { tokenSeen: true, attachmentSeen: true }
  const links = [{ token: '@@terminal:1', attachmentId: 'a1', ...seen }, { token: '@@diff:src/a.ts', attachmentId: 'a2', ...seen }]
  const both = 'see @@terminal:1 and @@diff:src/a.ts'

  it('keeps a link while both halves exist, and reports no change', () => {
    expect(reconcileContextLinks(links, both, new Set(['a1', 'a2']))).toMatchObject({ keep: links, changed: false })
  })
  it('removes the attachment when its chip was deleted', () => {
    expect(reconcileContextLinks(links, 'see @@diff:src/a.ts', new Set(['a1', 'a2']))).toMatchObject({
      keep: [links[1]], removeAttachmentIds: ['a1'], removeTokens: [],
    })
  })
  it('removes the chip when its attachment was removed', () => {
    const plan = reconcileContextLinks(links, both, new Set(['a1']))
    expect(plan).toMatchObject({ keep: [links[0]], removeAttachmentIds: [], removeTokens: ['@@diff:src/a.ts'] })
    expect(stripContextTokens(`${both} ok`, plan.removeTokens)).toBe('see @@terminal:1 and ok')
  })
  it('drops a link with neither half, as after a send', () => {
    expect(reconcileContextLinks(links, '', new Set())).toMatchObject({ keep: [], removeAttachmentIds: [], removeTokens: [] })
  })
  it('does not mistake a half that has not arrived yet for one that was removed', () => {
    const fresh = [{ token: '@@terminal:2', attachmentId: 'a9' }]
    // Token rendered, attachment still on its round trip: nothing is removed.
    const first = reconcileContextLinks(fresh, 'x @@terminal:2', new Set())
    expect(first).toMatchObject({ removeAttachmentIds: [], removeTokens: [], changed: true })
    expect(first.keep).toEqual([{ token: '@@terminal:2', attachmentId: 'a9', tokenSeen: true, attachmentSeen: false }])
    // Attachment arrives, then the operator deletes the chip: now it is removed.
    const second = reconcileContextLinks(first.keep, 'x @@terminal:2', new Set(['a9']))
    expect(reconcileContextLinks(second.keep, 'x', new Set(['a9'])).removeAttachmentIds).toEqual(['a9'])
  })
})

describe('addComposerContext', () => {
  it('stores the content, stages it, links it, and inserts a token the editor draws as a chip', async () => {
    const inserted: string[] = []
    const onInsert = (e: Event): void => { inserted.push((e as CustomEvent<string>).detail) }
    window.addEventListener(COMPOSER_INSERT_EVENT, onInsert)
    const token = diffContextToken('src/my file.ts')
    expect(await addComposerContext(token, 'my file.ts.diff', '+added')).toBe(true)
    window.removeEventListener(COMPOSER_INSERT_EVENT, onInsert)

    expect(saveAttachmentData).toHaveBeenCalledWith('tab-1', 'my file.ts.diff', btoa('+added'))
    expect(store.addAttachments).toHaveBeenCalledWith([expect.objectContaining({ id: 'att-1' })])
    expect(useComposerContextStore.getState().links['tab-1']).toEqual([{ token, attachmentId: 'att-1' }])
    expect(inserted).toEqual([`${token} `])
    expect(findComposerChipTokens(inserted[0]).map((t) => t.kind)).toEqual(['diff'])
  })

  it('inserts nothing when the content could not be stored', async () => {
    saveAttachmentData.mockResolvedValueOnce(null as never)
    expect(await addComposerContext('@@terminal:9', 't.txt', 'x')).toBe(false)
    expect(store.addAttachments).not.toHaveBeenCalled()
    expect(useComposerContextStore.getState().links['tab-1']).toBeUndefined()
  })
})
