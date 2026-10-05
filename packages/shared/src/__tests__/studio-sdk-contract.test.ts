import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ResourceItem } from '../types-engine'
import { COMPOSER_ACTION_KIND, LINK_ROUTE_KIND, STUDIO_CONTROL_KIND_PREFIX, STUDIO_FOCUS_KIND, composerActionCommandName, composerActionsFor, isStudioControlKind, isStudioTrafficKind, linkRouteCommandName, parseComposerAction, parseLinkRoute } from '../studio-sdk-contract'

const contract = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../studio-sdk/contract.json'), 'utf8'))
const item = (over: Partial<ResourceItem> & { contentObject?: unknown }): ResourceItem => ({
  id: 'a1',
  kind: COMPOSER_ACTION_KIND,
  producer: 'cos2',
  content: JSON.stringify(over.contentObject ?? { label: 'Briefing', icon: 'Newspaper', command: '/briefing' }),
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
} as ResourceItem)

describe('studio sdk contract', () => {
  it('matches the contract file every producer is pinned to', () => {
    expect(STUDIO_CONTROL_KIND_PREFIX).toBe(contract.controlKindPrefix)
    expect(COMPOSER_ACTION_KIND).toBe(contract.composerAction.kind)
    expect(parseComposerAction({ ...contract.composerAction.example, producer: 'cos2' })).toEqual({
      id: 'briefing', producer: 'cos2', label: 'Briefing', icon: 'Newspaper', command: '/briefing',
    })
  })

  it('marks every ion-studio kind as a control kind, and nothing else', () => {
    expect(isStudioControlKind('ion-studio.composer-action')).toBe(true)
    expect(isStudioControlKind(LINK_ROUTE_KIND)).toBe(true)
    expect(isStudioControlKind('briefing')).toBe(false)
    expect(isStudioControlKind(undefined)).toBe(false)
  })

  it("counts Studio's own focus and every control kind as Studio traffic, and nothing else", () => {
    expect(isStudioTrafficKind(STUDIO_FOCUS_KIND)).toBe(true)
    expect(isStudioTrafficKind('ion-studio.composer-action')).toBe(true)
    expect(isStudioTrafficKind('briefing')).toBe(false)
    expect(isStudioTrafficKind(undefined)).toBe(false)
    expect(isStudioControlKind(STUDIO_FOCUS_KIND)).toBe(false)
  })

  it('refuses an action that is not a slash command, and malformed content', () => {
    expect(parseComposerAction(item({ contentObject: { label: 'x', command: 'rm -rf /' } }))).toBeNull()
    expect(parseComposerAction(item({ contentObject: { command: '/x' } }))).toBeNull()
    expect(parseComposerAction(item({ content: 'not json' }))).toBeNull()
    expect(parseComposerAction(item({ kind: 'briefing' }))).toBeNull()
  })

  it('offers a workspace action only where the conversation owns its command', () => {
    const items = [item({ id: 'w' }), item({ id: 'c', conversationId: 'conv-1' })]
    const owns = new Set(['briefing'])
    expect(composerActionsFor(items, 'conv-1', owns).map((a) => a.id).sort()).toEqual(['c', 'w'])
    expect(composerActionsFor(items, 'conv-2', owns).map((a) => a.id)).toEqual(['w'])
    // A conversation that does not run the extension owns none of its commands.
    expect(composerActionsFor(items, 'conv-2', new Set()).map((a) => a.id)).toEqual([])
    expect(composerActionsFor(items, 'conv-1', new Set()).map((a) => a.id)).toEqual(['c'])
    expect(composerActionsFor(undefined, null, owns)).toEqual([])
  })

  it('matches on the command name, ignoring arguments', () => {
    const items = [item({ id: 'w', contentObject: { label: 'Brief', command: '/briefing today' } })]
    expect(composerActionsFor(items, null, new Set(['briefing'])).map((a) => a.id)).toEqual(['w'])
    expect(composerActionCommandName('/briefing today')).toBe('briefing')
  })

  describe('link routes', () => {
    const route = (over: Partial<ResourceItem> & { contentObject?: unknown }): ResourceItem => item({
      id: 'open-briefing',
      kind: LINK_ROUTE_KIND,
      content: JSON.stringify(over.contentObject ?? { label: 'Open briefing', command: '/briefing' }),
      ...over,
    })

    it('matches the contract file every producer is pinned to', () => {
      expect(LINK_ROUTE_KIND).toBe(contract.linkRoute.kind)
      expect(new RegExp(contract.linkRoute.idPattern).test('open-briefing')).toBe(true)
      expect(parseLinkRoute({ ...contract.linkRoute.example, producer: 'cos2' })).toEqual({
        id: 'open-briefing', producer: 'cos2', label: 'Open briefing', command: '/briefing',
      })
    })

    it('keeps the conversation a route is scoped to', () => {
      expect(parseLinkRoute(route({ conversationId: 'conv-1' }))?.conversationId).toBe('conv-1')
    })

    it('refuses an id that is not one safe path segment', () => {
      expect(parseLinkRoute(route({ id: 'a/b' }))).toBeNull()
      expect(parseLinkRoute(route({ id: 'a b' }))).toBeNull()
      expect(parseLinkRoute(route({ id: '' }))).toBeNull()
      expect(parseLinkRoute(route({ id: 'x'.repeat(65) }))).toBeNull()
      expect(parseLinkRoute(route({ id: 'x'.repeat(64) }))).not.toBeNull()
    })

    it('refuses an over-long label, a non-slash command, and malformed content', () => {
      expect(parseLinkRoute(route({ contentObject: { label: 'l'.repeat(81), command: '/briefing' } }))).toBeNull()
      expect(parseLinkRoute(route({ contentObject: { label: '', command: '/briefing' } }))).toBeNull()
      expect(parseLinkRoute(route({ contentObject: { label: 'x', command: 'rm -rf /' } }))).toBeNull()
      expect(parseLinkRoute(route({ contentObject: { label: 'x', command: '/' + 'c'.repeat(200) } }))).toBeNull()
      expect(parseLinkRoute(route({ content: 'not json' }))).toBeNull()
      expect(parseLinkRoute(route({ kind: COMPOSER_ACTION_KIND }))).toBeNull()
    })

    it('names the command a route runs, ignoring arguments', () => {
      expect(linkRouteCommandName('/briefing today')).toBe('briefing')
    })
  })
})
