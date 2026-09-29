/**
 * P0: `buildSendPromptMessage` attaches `principal` only when the ambient
 * caller (a live Studio-wire dispatch) differs from the tab's own owner --
 * the common "prompting your own tab" case needs no override, since
 * `start_session` already attributed the session.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildSendPromptMessage } from '../engine-bridge-prompts'
import { runAsPrincipal } from '../../identity/request-principal'
import { _resetPrincipalIndexForTest } from '../../protocol/tabs-index'

let dataDir: string
let originalIonDataDir: string | undefined

beforeEach(() => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-send-prompt-principal-'))
  process.env.ION_DATA_DIR = dataDir
})

afterEach(() => {
  _resetPrincipalIndexForTest()
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

describe('buildSendPromptMessage: turn attribution', () => {
  it('omits principal when there is no ambient caller (desktop local IPC)', () => {
    const msg = buildSendPromptMessage({ key: 'tab-1', text: 'hi' })
    expect(msg.principal).toBeUndefined()
  })

  it('omits principal when the caller matches the tab owner', () => {
    writeFileSync(join(dataDir, 'tabs.json'), JSON.stringify({ tabs: [{ id: 'tab-1', principalSubject: 'alice' }] }))
    const msg = runAsPrincipal({ principal: { subject: 'alice', displayName: 'Alice' } }, () => buildSendPromptMessage({ key: 'tab-1', text: 'hi' }))
    expect(msg.principal).toBeUndefined()
  })

  it('attaches principal when a different caller drives the tab (shared tenancy)', () => {
    writeFileSync(join(dataDir, 'tabs.json'), JSON.stringify({ tabs: [{ id: 'tab-1', principalSubject: 'alice' }] }))
    const msg = runAsPrincipal({ principal: { subject: 'bob', displayName: 'Bob', provider: 'entra', kind: 'operator' } }, () => buildSendPromptMessage({ key: 'tab-1', text: 'hi' }))
    expect(msg.principal).toEqual({ subject: 'bob', provider: 'entra', kind: 'operator', username: undefined, displayName: 'Bob', multiTenant: true })
  })
})
