/**
 * The automation mutations answer with the envelope every client reads:
 * `{ ok, definition }`. A duplicate that answered with the bare definition
 * read as a failure on every client, which then showed an error for a copy
 * that had been saved.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AutomationDefinition } from '@ion/shared/types-automation'
import type { Connection } from '../connection'

const definition = (id: string, name: string): AutomationDefinition => ({
  id, name, enabled: false, trigger: { kind: 'event', event: 'worktree:created' }, steps: [{ kind: 'record' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})

const runtime = {
  duplicateDefinition: vi.fn((id: string) => definition(`user.copy-of-${id}`, 'Rule (copy)')),
  saveUserDefinition: vi.fn((d: AutomationDefinition) => ({ ...d, updatedAt: '2026-02-02T00:00:00.000Z' })),
}
vi.mock('../../automation/runtime', () => ({ getAutomationRuntime: () => runtime }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

const { MISC_ACTIONS } = await import('../misc-actions')
const conn = { id: 'c1', principal: { subject: 'local:user', displayName: 'User' } } as unknown as Connection

describe('automation mutations', () => {
  it('duplicate answers { ok, definition } with the new user copy', async () => {
    const outcome = await MISC_ACTIONS['automation.duplicate'].handler(conn, [{ id: 'b1', projectPath: '/repo' }])
    expect(runtime.duplicateDefinition).toHaveBeenCalledWith('b1', '/repo')
    expect(outcome).toEqual({ ok: true, value: { ok: true, definition: definition('user.copy-of-b1', 'Rule (copy)') } })
  })

  it('upsert answers { ok, definition } with the stored definition', async () => {
    const saved = definition('user.a', 'Mine')
    const outcome = await MISC_ACTIONS['automation.upsert'].handler(conn, [saved])
    expect(outcome).toEqual({ ok: true, value: { ok: true, definition: { ...saved, updatedAt: '2026-02-02T00:00:00.000Z' } } })
  })

  it('upsert refuses a malformed definition without saving', async () => {
    runtime.saveUserDefinition.mockClear()
    const outcome = await MISC_ACTIONS['automation.upsert'].handler(conn, [{ id: 'x' }])
    expect(outcome).toEqual({ ok: true, value: { ok: false, error: 'invalid automation definition' } })
    expect(runtime.saveUserDefinition).not.toHaveBeenCalled()
  })
})
