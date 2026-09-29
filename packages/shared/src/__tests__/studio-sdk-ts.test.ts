/**
 * The TypeScript flavor of the Studio SDK (packages/studio-sdk/ts). It lives in
 * this package's test run because this package is where Studio's consuming
 * parser lives: the last test feeds what the SDK publishes straight into what
 * Studio parses, so the two halves cannot drift apart.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { COMPOSER_ACTION_KIND, STUDIO_CONTROL_KIND_PREFIX, composerActionItem, studio, type StudioResourceFilter, type StudioResourceItem } from '../../../studio-sdk/ts/index'
import { composerActionsFor } from '../studio-sdk-contract'

const contract = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../studio-sdk/contract.json'), 'utf8'))

function fakeIon() {
  const publish = vi.fn(async (_op: string, _item: StudioResourceItem) => undefined)
  let query: ((filter: StudioResourceFilter) => StudioResourceItem[] | Promise<StudioResourceItem[]>) | null = null
  const ion = {
    resources: {
      declare: vi.fn(async (_decl: { kind: string }) => ({ publish })),
      onQuery: vi.fn((_kind: string, handler: typeof query) => { query = handler }),
    },
  }
  return { ion, publish, runQuery: (filter: StudioResourceFilter) => query!(filter) }
}

describe('studio sdk (ts)', () => {
  it('publishes exactly the contract shape', () => {
    expect(STUDIO_CONTROL_KIND_PREFIX).toBe(contract.controlKindPrefix)
    expect(COMPOSER_ACTION_KIND).toBe(contract.composerAction.kind)
    const example = contract.composerAction.example
    const item = composerActionItem({ id: 'briefing', label: 'Briefing', icon: 'Newspaper', command: '/briefing' }, example.createdAt)
    expect(item).toEqual(example)
  })

  it('declares the kind once, publishes create then update, and answers the snapshot query', async () => {
    const { ion, publish, runQuery } = fakeIon()
    const composer = studio(ion).composer
    await composer.addAction({ id: 'a', label: 'A', command: '/a' })
    await composer.addAction({ id: 'a', label: 'A again', command: '/a' })
    expect(studio(ion)).toBe(studio(ion))
    expect(ion.resources.declare).toHaveBeenCalledTimes(1)
    expect(ion.resources.declare).toHaveBeenCalledWith({ kind: COMPOSER_ACTION_KIND })
    expect(publish.mock.calls.map((c) => c[0])).toEqual(['create', 'update'])
    const snapshot = await runQuery({ kind: COMPOSER_ACTION_KIND })
    expect(snapshot.map((i) => JSON.parse(i.content).label)).toEqual(['A again'])
  })

  it('registers at start-up without publishing, and serves the snapshot', async () => {
    const { ion, publish, runQuery } = fakeIon()
    studio(ion).composer.register([{ id: 'r', label: 'R', command: '/r' }])
    expect(publish).not.toHaveBeenCalled()
    expect((await runQuery({ kind: COMPOSER_ACTION_KIND })).map((i) => i.id)).toEqual(['r'])
    expect(() => studio(ion).composer.register([{ id: 'bad', label: 'B', command: 'nope' }])).toThrow(/slash command/)
  })

  it('removes an action with a delete delta and drops it from the snapshot', async () => {
    const { ion, publish, runQuery } = fakeIon()
    const composer = studio(ion).composer
    await composer.addAction({ id: 'a', label: 'A', command: '/a' })
    await composer.removeAction('a')
    await composer.removeAction('never-added')
    expect(publish.mock.calls.map((c) => c[0])).toEqual(['create', 'delete'])
    expect(await runQuery({ kind: COMPOSER_ACTION_KIND })).toEqual([])
  })

  it('refuses anything that is not a slash command', async () => {
    const { ion, publish } = fakeIon()
    await expect(studio(ion).composer.addAction({ id: 'x', label: 'X', command: 'rm -rf /' })).rejects.toThrow(/slash command/)
    expect(publish).not.toHaveBeenCalled()
  })

  it('produces items Studio parses into the same actions', async () => {
    const { ion, runQuery } = fakeIon()
    studio(ion).composer.register([{ id: 'briefing', label: 'Briefing', icon: 'Newspaper', command: '/briefing' }])
    const items = (await runQuery({ kind: COMPOSER_ACTION_KIND })).map((item) => ({ ...item, producer: 'cos2' }))
    expect(composerActionsFor(items, null, new Set(['briefing']))).toEqual([
      { id: 'briefing', producer: 'cos2', label: 'Briefing', icon: 'Newspaper', command: '/briefing' },
    ])
  })

  it('scopes a conversation action to its conversation in the snapshot', async () => {
    const { ion, runQuery } = fakeIon()
    const composer = studio(ion).composer
    await composer.addAction({ id: 'w', label: 'W', command: '/w' })
    await composer.addAction({ id: 'c', label: 'C', command: '/c', conversationId: 'conv-1' })
    expect((await runQuery({ kind: COMPOSER_ACTION_KIND, conversationId: 'conv-2' })).map((i) => i.id)).toEqual(['w'])
  })
})
