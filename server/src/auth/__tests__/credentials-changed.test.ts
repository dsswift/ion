/** A write that changes WHO is paired is announced; a last-seen touch is not. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CredentialsStore, onCredentialsChanged } from '../credentials-store'

let dir: string
let store: CredentialsStore
let seen: Array<[string, string[]]>
let off: () => void

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-credentials-changed-'))
  store = new CredentialsStore(dir)
  seen = []
  off = onCredentialsChanged((change, ids) => seen.push([change, ids]))
})
afterEach(() => { off(); rmSync(dir, { recursive: true, force: true }) })

const phone = (clientId: string, deviceId?: string) => ({ clientId, secret: Buffer.alloc(32, 1), scopes: ['conversations:read' as const], subject: 'paired:x', kind: 'mobile' as const, deviceId })

describe('onCredentialsChanged', () => {
  it('announces a pairing, naming the record it superseded for the same device', () => {
    store.add(phone('c1', 'HW-1'))
    store.add(phone('c2', 'HW-1'))
    expect(seen).toEqual([['added', ['c1']], ['added', ['c2', 'c1']]])
  })

  it('announces a revoke once, and a rebind only when something moved', () => {
    store.add(phone('c1'))
    seen.length = 0
    store.revoke('c1')
    store.revoke('c1')
    store.revoke('nobody')
    expect(seen).toEqual([['revoked', ['c1']]])
    seen.length = 0
    store.rebindSubjects((s) => s === 'paired:x', 'local:owner')
    store.rebindSubjects((s) => s === 'paired:x', 'local:owner')
    expect(seen).toEqual([['rebound', ['c1']]])
  })

  it('stays quiet for a last-seen touch and after unsubscribing', () => {
    store.add(phone('c1'))
    seen.length = 0
    store.touch('c1')
    off()
    store.revoke('c1')
    expect(seen).toEqual([])
  })
})
