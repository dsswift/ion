/**
 * The drift guard for `phone-actions.json`: the studio_actions a phone calls
 * directly to administer its server. Each entry must be an action this server
 * answers, with the scope the server really requires, and none may be one the
 * server refuses to every caller but the local desktop, because a phone is
 * never that caller.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn() }))

import { registeredActionSpec } from '../actions'
import { SCOPES } from '@ion/shared/studio-wire/types'

interface Entry { action: string; scope: string }

/** Read as a file, not imported: it is plain data a Swift client can read the same way. */
const LIST_PATH = join(__dirname, '..', '..', '..', '..', 'packages', 'shared', 'src', 'studio-wire', 'phone-actions.json')
const entries = (JSON.parse(readFileSync(LIST_PATH, 'utf-8')) as { actions: Entry[] }).actions

describe('phone actions', () => {
  it('lists actions, once each, sorted by name', () => {
    expect(entries.length).toBeGreaterThan(0)
    const names = entries.map((e) => e.action)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual([...names].sort())
  })

  it('names only registered actions, each with the scope the server requires', () => {
    const drift = entries.flatMap((entry) => {
      const spec = registeredActionSpec(entry.action)
      if (!spec) return [`${entry.action}: not registered`]
      if (!(SCOPES as readonly string[]).includes(entry.scope)) return [`${entry.action}: ${entry.scope} is not a scope`]
      return spec.requiredScope === entry.scope ? [] : [`${entry.action}: listed ${entry.scope}, server requires ${spec.requiredScope}`]
    })
    expect(drift).toEqual([])
  })

  it('names no action the server keeps for the local desktop', () => {
    expect(entries.filter((e) => registeredActionSpec(e.action)?.localOnly).map((e) => e.action)).toEqual([])
  })

  it('can tell a local-only action from the rest', () => {
    // Without this, a lookup that never reports localOnly would pass the check above for any list.
    expect(registeredActionSpec('lifecycle.shutdown')?.localOnly).toBe(true)
    expect(registeredActionSpec('deeplink.dispatch')?.localOnly).toBe(true)
    expect(registeredActionSpec('entra.accessToken')?.localOnly).toBe(true)
    expect(registeredActionSpec('remote.testRelay')).toEqual({ requiredScope: 'admin', localOnly: false })
  })
})
