import { describe, expect, it } from 'vitest'
import { handleSnapshotRequest } from '../snapshot-request'
import type { Connection } from '../connection'
import type { StudioFrame, StudioSnapshot } from '@ion/shared/studio-wire/types'

function fakeConn(principal: { subject: string; displayName: string } | null): { conn: Connection; sent: StudioFrame[] } {
  const sent: StudioFrame[] = []
  const conn = {
    id: 'conn-test',
    principal,
    scopes: ['conversations:read'],
    send: (frame: StudioFrame) => { sent.push(frame); return true },
  } as unknown as Connection
  return { conn, sent }
}

const SNAPSHOT = { tabs: [{ id: 't1' }], settings: {}, worktrees: {}, terminals: {}, automations: [], engine: {}, presence: {} } as unknown as StudioSnapshot

describe('handleSnapshotRequest', () => {
  it('answers with a full studio_snapshot built for the connection principal', () => {
    const { conn, sent } = fakeConn({ subject: 'josh', displayName: 'Josh' })
    const seen: string[] = []
    const ok = handleSnapshotRequest(conn, (principal) => { seen.push(principal.subject); return SNAPSHOT })
    expect(ok).toBe(true)
    expect(seen).toEqual(['josh'])
    expect(sent).toEqual([{ type: 'studio_snapshot', snapshot: SNAPSHOT }])
  })

  it('drops a request that arrives before hello', () => {
    const { conn, sent } = fakeConn(null)
    expect(handleSnapshotRequest(conn, () => SNAPSHOT)).toBe(false)
    expect(sent).toEqual([])
  })

  it('leaves the request unanswered when the builder throws', () => {
    const { conn, sent } = fakeConn({ subject: 'josh', displayName: 'Josh' })
    expect(handleSnapshotRequest(conn, () => { throw new Error('store unavailable') })).toBe(false)
    expect(sent).toEqual([])
  })
})
