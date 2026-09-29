import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { applySubjectMoves } from '../subject-moves'
import { _resetCredentialsStoreForTest, credentialsStore } from '../../auth/credentials-store'
import { _resetGitCredentialStoreForTest, gitCredentialStore } from '../../git/identity/credential-store'
import { _resetPrincipalRegistryForTest, lookupPrincipal, registerPrincipal } from '../principal-registry'
import { principalDir } from '../../conversation/principal-dir'
import { listOverlays, replaceOverlay } from '../../persistence/user-settings-store'
import { parseTenancy } from '../../config/tenancy-config'

const OLD = 'old-pairwise-sub'
const NEW = 'new-pairwise-sub'
let dir: string
let originalIonDataDir: string | undefined

beforeEach(() => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dir = mkdtempSync(join(tmpdir(), 'ion-subject-moves-'))
  process.env.ION_DATA_DIR = dir
  _resetCredentialsStoreForTest(dir)
  _resetGitCredentialStoreForTest(dir)
  _resetPrincipalRegistryForTest()
})

afterEach(() => {
  _resetPrincipalRegistryForTest()
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dir, { recursive: true, force: true })
})

describe('applySubjectMoves', () => {
  it('carries conversations, git keys, settings, tabs, pairings and the principal to the new subject', () => {
    credentialsStore().add({ clientId: 'phone', secret: randomBytes(32), scopes: ['conversations:read'], subject: OLD, kind: 'mobile' })
    credentialsStore().add({ clientId: 'other', secret: randomBytes(32), scopes: ['admin'], subject: 'someone-else', kind: 'desktop' })
    gitCredentialStore().set({ subject: OLD, host: 'github.com', source: 'user', kind: 'ssh', privateKey: 'k', publicKey: 'p' })
    registerPrincipal({ subject: OLD, displayName: 'Person', provider: 'entra', email: 'person@example.com' })
    const conversations = join(dir, 'principals', principalDir(OLD), 'conversations')
    mkdirSync(conversations, { recursive: true })
    writeFileSync(join(conversations, 'c1.jsonl'), '{}\n')
    writeFileSync(join(dir, 'tabs.json'), JSON.stringify({ tabs: [{ id: 't1', principalSubject: OLD }, { id: 't2', principalSubject: 'someone-else' }], settledHistory: [] }))
    replaceOverlay(OLD, { theme: 'dark', fontSize: 13 })
    replaceOverlay(NEW, { fontSize: 15 })

    const [result] = applySubjectMoves(dir, [{ from: OLD, to: NEW }])

    expect(result).toMatchObject({ from: OLD, to: NEW, pairings: ['phone'], gitHosts: ['github.com'], principals: [OLD], principalDirs: [principalDir(OLD)], tabs: 1, settings: true })
    expect(credentialsStore().get('phone')?.subject).toBe(NEW)
    expect(credentialsStore().get('other')?.subject).toBe('someone-else')
    expect(gitCredentialStore().privateKeyFor(NEW, 'github.com')).toBe('k')
    expect(lookupPrincipal(NEW)).toMatchObject({ subject: NEW, displayName: 'Person', email: 'person@example.com' })
    expect(lookupPrincipal(OLD)).toBeUndefined()
    expect(existsSync(join(dir, 'principals', principalDir(NEW), 'conversations', 'c1.jsonl'))).toBe(true)
    expect(existsSync(join(dir, 'principals', principalDir(OLD)))).toBe(false)
    const tabs = JSON.parse(readFileSync(join(dir, 'tabs.json'), 'utf-8')) as { tabs: Array<{ principalSubject: string }> }
    expect(tabs.tabs.map((t) => t.principalSubject)).toEqual([NEW, 'someone-else'])
    expect(existsSync(join(dir, 'tabs.json.pre-subject-move.bak'))).toBe(true)
    const overlays = listOverlays()
    expect(overlays.find((o) => o.subject === OLD)).toBeUndefined()
    expect(overlays.find((o) => o.subject === NEW)?.settings).toEqual({ theme: 'dark', fontSize: 15 })
  })

  it('changes nothing on a later boot once the move has run', () => {
    credentialsStore().add({ clientId: 'phone', secret: randomBytes(32), scopes: ['conversations:read'], subject: OLD, kind: 'mobile' })
    applySubjectMoves(dir, [{ from: OLD, to: NEW }])
    const [second] = applySubjectMoves(dir, [{ from: OLD, to: NEW }])
    expect(second).toMatchObject({ pairings: [], gitHosts: [], principalDirs: [], tabs: 0, terminals: 0, settings: false })
  })
})

describe('tenancy.subjectMoves', () => {
  it('keeps well-formed moves and drops the rest', () => {
    expect(parseTenancy({ subjectMoves: [{ from: 'a', to: 'b' }, { from: 'a', to: 'a' }, { from: 'x' }, 'junk'] }).subjectMoves).toEqual([{ from: 'a', to: 'b' }])
    expect(parseTenancy({}).subjectMoves).toBeUndefined()
  })
})
