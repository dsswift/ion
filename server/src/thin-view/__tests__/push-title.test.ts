/**
 * What a push may say about its conversation is the server's Environment
 * setting: on by default, the title and nothing more; off, nothing at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../../persistence/settings-store', () => ({ readSettings: () => settings.value }))

import { pushConversationTitle, pushTitlesEnabled } from '../push-title'

beforeEach(() => { settings.value = {} })

describe('push conversation titles', () => {
  it('are on when the setting was never set', () => {
    expect(pushTitlesEnabled()).toBe(true)
    expect(pushConversationTitle({ id: 'tab-1', title: 'Fix relay pushes', customTitle: null })).toBe('Fix relay pushes')
  })

  it('prefer the name the person gave the conversation', () => {
    expect(pushConversationTitle({ id: 'tab-1', title: 'Generated', customTitle: 'Mine' })).toBe('Mine')
  })

  it('are withheld when the server turns them off', () => {
    settings.value = { pushConversationTitles: false }
    expect(pushTitlesEnabled()).toBe(false)
    expect(pushConversationTitle({ id: 'tab-1', title: 'Fix relay pushes' })).toBeNull()
  })

  it('fall back to generic text for a conversation with no title or no record', () => {
    expect(pushConversationTitle({ id: 'tab-1', title: '   ' })).toBeNull()
    expect(pushConversationTitle(undefined)).toBeNull()
  })

  it('are one short line', () => {
    expect(pushConversationTitle({ id: 'tab-1', title: 'two\n  lines' })).toBe('two lines')
    const long = pushConversationTitle({ id: 'tab-1', title: 'x'.repeat(200) })!
    expect(long).toHaveLength(80)
    expect(long.endsWith('…')).toBe(true)
  })
})
