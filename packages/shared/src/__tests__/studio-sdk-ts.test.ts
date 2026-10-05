/**
 * The TypeScript flavor of the Studio SDK (packages/studio-sdk/ts). It lives in
 * this package's test run because this package is where Studio's consuming
 * parser lives: the last test feeds what the SDK publishes straight into what
 * Studio parses, so the two halves cannot drift apart.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { COMPOSER_ACTION_KIND, LINK_ROUTE_KIND, STUDIO_CONTROL_KIND_PREFIX, composerActionItem, linkRouteItem, studio, type StudioResourceFilter, type StudioResourceItem } from '../../../studio-sdk/ts/index'
import { composerActionsFor, parseLinkRoute } from '../studio-sdk-contract'

const contract = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../studio-sdk/contract.json'), 'utf8'))

function fakeIon() {
  const publish = vi.fn(async (_op: string, _item: StudioResourceItem) => undefined)
  type QueryHandler = (filter: StudioResourceFilter) => StudioResourceItem[] | Promise<StudioResourceItem[]>
  const queries = new Map<string, QueryHandler>()
  const ion = {
    resources: {
      declare: vi.fn(async (_decl: { kind: string }) => ({ publish })),
      onQuery: vi.fn((kind: string, handler: QueryHandler) => { queries.set(kind, handler) }),
    },
  }
  return { ion, publish, runQuery: (filter: StudioResourceFilter) => queries.get(filter.kind)!(filter) }
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

  describe('links', () => {
    it('publishes exactly the contract shape', () => {
      expect(LINK_ROUTE_KIND).toBe(contract.linkRoute.kind)
      const example = contract.linkRoute.example
      expect(linkRouteItem({ id: 'open-briefing', label: 'Open briefing', command: '/briefing' }, example.createdAt)).toEqual(example)
    })

    it('declares its own kind only when used, beside the composer', async () => {
      const { ion, runQuery } = fakeIon()
      studio(ion).composer.register([{ id: 'a', label: 'A', command: '/a' }])
      expect(ion.resources.declare).toHaveBeenCalledTimes(1)
      studio(ion).links.register([{ id: 'r', label: 'R', command: '/r' }])
      expect(ion.resources.declare.mock.calls.map((c) => c[0].kind)).toEqual([COMPOSER_ACTION_KIND, LINK_ROUTE_KIND])
      expect((await runQuery({ kind: COMPOSER_ACTION_KIND })).map((i) => i.id)).toEqual(['a'])
      expect((await runQuery({ kind: LINK_ROUTE_KIND })).map((i) => i.id)).toEqual(['r'])
    })

    it('registers at start-up without publishing, then adds, replaces, and removes with deltas', async () => {
      const { ion, publish, runQuery } = fakeIon()
      const links = studio(ion).links
      links.register([{ id: 'r', label: 'R', command: '/r' }])
      expect(publish).not.toHaveBeenCalled()
      await links.addRoute({ id: 'r', label: 'R again', command: '/r now' })
      await links.addRoute({ id: 'c', label: 'C', command: '/c', conversationId: 'conv-1' })
      expect(links.routes().map((r) => r.id)).toEqual(['r', 'c'])
      expect((await runQuery({ kind: LINK_ROUTE_KIND, conversationId: 'conv-2' })).map((i) => i.id)).toEqual(['r'])
      await links.removeRoute('r')
      await links.removeRoute('never-added')
      expect(publish.mock.calls.map((c) => [c[0], c[1].kind])).toEqual([
        ['update', LINK_ROUTE_KIND], ['create', LINK_ROUTE_KIND], ['delete', LINK_ROUTE_KIND],
      ])
      expect((await runQuery({ kind: LINK_ROUTE_KIND })).map((i) => i.id)).toEqual(['c'])
    })

    it('refuses a bad id, an over-long label, and a non-slash command', async () => {
      const { ion, publish } = fakeIon()
      const links = studio(ion).links
      await expect(links.addRoute({ id: 'a/b', label: 'X', command: '/x' })).rejects.toThrow(/id must be/)
      await expect(links.addRoute({ id: 'x'.repeat(65), label: 'X', command: '/x' })).rejects.toThrow(/id must be/)
      await expect(links.addRoute({ id: 'x', label: 'l'.repeat(81), command: '/x' })).rejects.toThrow(/label must be/)
      await expect(links.addRoute({ id: 'x', label: 'X', command: 'rm -rf /' })).rejects.toThrow(/slash command/)
      expect(() => links.register([{ id: 'bad id', label: 'B', command: '/b' }])).toThrow(/id must be/)
      expect(publish).not.toHaveBeenCalled()
    })

    it('produces items Studio parses into the same routes', async () => {
      const { ion, runQuery } = fakeIon()
      studio(ion).links.register([{ id: 'open-briefing', label: 'Open briefing', command: '/briefing', conversationId: 'conv-1' }])
      const items = (await runQuery({ kind: LINK_ROUTE_KIND })).map((item) => ({ ...item, producer: 'cos2' }))
      expect(items.map(parseLinkRoute)).toEqual([
        { id: 'open-briefing', producer: 'cos2', label: 'Open briefing', command: '/briefing', conversationId: 'conv-1' },
      ])
    })
  })
})
