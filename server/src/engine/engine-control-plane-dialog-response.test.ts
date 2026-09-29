/**
 * A settings-file approval is asked and answered by this server. The engine
 * never saw the question, so the answer must not be sent to it, and an Allow
 * must grant exactly that file in exactly that conversation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/settings-store', () => ({ readSettings: () => ({ allowSettingsEdits: true }) }))
vi.mock('../paths', () => ({ dataDir: () => '/data/ion' }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('./studio-state-cache', () => ({ resolveStudioPermission: vi.fn() }))

import { askSettingsEdit, registerSettingsGuardAnswered, respondToPermission } from './engine-control-plane-dialog-response'
import {
  SETTINGS_GUARD_ALLOW, SETTINGS_GUARD_DENY, hasSettingsEditGrant, openSettingsGuardQuestion, resetSettingsGuardForTest,
} from './settings-files-guard'
import type { EngineBridge } from './engine-bridge'
import type { TabEntry } from './engine-control-plane-events'

const PATH = '/data/ion/engine.json'
const tabs = new Map<string, TabEntry>([['tab-1', {} as TabEntry]])
const bridge = { sendPermissionResponse: vi.fn() }
const answered = vi.fn()
const resolved = vi.fn()

function open() {
  return openSettingsGuardQuestion({ tabId: 'tab-1', sessionKey: 'tab-1', toolName: 'Edit', input: { file_path: PATH }, cwd: '/w' }, PATH).question
}

beforeEach(() => {
  resetSettingsGuardForTest()
  bridge.sendPermissionResponse.mockClear(); answered.mockClear(); resolved.mockClear()
  registerSettingsGuardAnswered(answered)
})

describe('askSettingsEdit', () => {
  it('raises the ordinary permission card on every surface', () => {
    const emit = vi.fn()
    const question = open()
    askSettingsEdit(emit, question)
    const [desktop, remote] = emit.mock.calls
    expect(desktop[0]).toBe('event')
    expect(desktop[2]).toMatchObject({ type: 'permission_request', questionId: question.questionId })
    expect(remote[0]).toBe('remote-permission')
    expect(remote[2].options.map((o: { id: string }) => o.id)).toEqual([SETTINGS_GUARD_ALLOW, SETTINGS_GUARD_DENY])
  })
})

describe('answering', () => {
  it('Allow grants the file, tells the conversation, and sends nothing to the engine', () => {
    const question = open()
    expect(respondToPermission(tabs, bridge as unknown as EngineBridge, 'tab-1', question.questionId, SETTINGS_GUARD_ALLOW, resolved)).toBe(true)
    expect(hasSettingsEditGrant('tab-1', PATH)).toBe(true)
    expect(answered).toHaveBeenCalledWith(expect.objectContaining({ path: PATH }), true)
    expect(bridge.sendPermissionResponse).not.toHaveBeenCalled()
    expect(resolved).toHaveBeenCalledWith('tab-1', question.questionId)
  })

  it('Deny grants nothing and still tells the conversation', () => {
    const question = open()
    respondToPermission(tabs, bridge as unknown as EngineBridge, 'tab-1', question.questionId, SETTINGS_GUARD_DENY, resolved)
    expect(hasSettingsEditGrant('tab-1', PATH)).toBe(false)
    expect(answered).toHaveBeenCalledWith(expect.objectContaining({ path: PATH }), false)
  })

  it('an engine question still goes to the engine', () => {
    respondToPermission(tabs, bridge as unknown as EngineBridge, 'tab-1', 'q-engine', 'allow', resolved)
    expect(bridge.sendPermissionResponse).toHaveBeenCalledWith('tab-1', 'q-engine', 'allow')
    expect(answered).not.toHaveBeenCalled()
  })
})
