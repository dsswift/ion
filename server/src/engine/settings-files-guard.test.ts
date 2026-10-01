/**
 * The settings-files guard. The setting it reads used to be a per-device
 * switch that nothing enforced: any connected device could claim the agent was
 * allowed to edit a shared server's engine config, and the server had no say.
 * These pin that the SERVER decides, per file, per conversation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('../persistence/settings-store', () => ({ readSettings: () => settings.value }))
vi.mock('../paths', () => ({ dataDir: () => '/data/ion' }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }))
const policy = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }))
vi.mock('../enterprise-policy-source', () => ({ currentEnterprisePolicy: () => policy.value }))

import {
  evaluateSettingsGuard, grantSettingsEdit, openSettingsGuardQuestion, protectedFileInCommand,
  protectedSettingsFile, resetSettingsGuardForTest, takeSettingsGuardQuestion,
} from './settings-files-guard'

const edit = (file_path: string, tabId = 'tab-1') => ({ tabId, sessionKey: tabId, toolName: 'Edit', input: { file_path }, cwd: '/work/project' })
const bash = (command: string) => ({ tabId: 'tab-1', sessionKey: 'tab-1', toolName: 'Bash', input: { command }, cwd: '/work/project' })

beforeEach(() => {
  settings.value = {}
  policy.value = null
  resetSettingsGuardForTest()
})

describe('protectedSettingsFile', () => {
  it('covers the engine config, the settings document, the overlays, and a project engine config', () => {
    expect(protectedSettingsFile('/data/ion/engine.json')).toBe('/data/ion/engine.json')
    expect(protectedSettingsFile('/data/ion/settings.json')).toBe('/data/ion/settings.json')
    expect(protectedSettingsFile('/data/ion/user-settings/abc.json')).toBe('/data/ion/user-settings/abc.json')
    expect(protectedSettingsFile('/work/project/.ion/engine.json')).toBe('/work/project/.ion/engine.json')
  })

  it('leaves everything else alone', () => {
    expect(protectedSettingsFile('/data/ion/engine.jsonl')).toBeNull()
    expect(protectedSettingsFile('/work/project/src/engine.json')).toBeNull()
    expect(protectedSettingsFile('/work/project/.ion/worktree.json')).toBeNull()
  })
})

describe('protectedFileInCommand', () => {
  it('finds a literal path, a home-relative path, and a cwd-relative path', () => {
    expect(protectedFileInCommand('jq . /data/ion/engine.json > /tmp/x && mv /tmp/x /data/ion/engine.json', '/w')).toBe('/data/ion/engine.json')
    expect(protectedFileInCommand('echo "{}" >~/proj/.ion/engine.json', '/w')).toBe(join(homedir(), 'proj/.ion/engine.json'))
    expect(protectedFileInCommand('sed -i "" s/a/b/ .ion/engine.json', '/work/project')).toBe('/work/project/.ion/engine.json')
  })

  it('does not guess at a path built at run time, and ignores unrelated commands', () => {
    expect(protectedFileInCommand('cat "$CFG"', '/w')).toBeNull()
    expect(protectedFileInCommand('npm test -- engine', '/w')).toBeNull()
  })
})

describe('evaluateSettingsGuard', () => {
  it('has no opinion about an ordinary file', () => {
    expect(evaluateSettingsGuard(edit('/work/project/src/a.ts')).kind).toBe('not-applicable')
  })

  it('refuses outright, and asks nobody, when the server has it turned off', () => {
    const decision = evaluateSettingsGuard(edit('/data/ion/engine.json'))
    expect(decision.kind).toBe('deny')
    // An approval held from earlier does not outrank the server's setting.
    grantSettingsEdit('tab-1', '/data/ion/engine.json')
    expect(evaluateSettingsGuard(edit('/data/ion/engine.json')).kind).toBe('deny')
  })

  it('asks when the server allows it and the conversation has no approval yet', () => {
    settings.value = { allowSettingsEdits: true }
    expect(evaluateSettingsGuard(edit('/data/ion/engine.json')).kind).toBe('ask')
    expect(evaluateSettingsGuard(bash('echo x > /data/ion/engine.json')).kind).toBe('ask')
  })

  it('allows only the approved file, only in the approved conversation', () => {
    settings.value = { allowSettingsEdits: true }
    grantSettingsEdit('tab-1', '/data/ion/engine.json')
    expect(evaluateSettingsGuard(edit('/data/ion/engine.json')).kind).toBe('allow')
    expect(evaluateSettingsGuard(edit('/data/ion/settings.json')).kind).toBe('ask')
    expect(evaluateSettingsGuard(edit('/data/ion/engine.json', 'tab-2')).kind).toBe('ask')
  })
})

describe('the organization seal', () => {
  it('sealed off: refused even when the server setting is on and an approval is held', () => {
    settings.value = { allowSettingsEdits: true }
    policy.value = { customFields: { 'ion-server': { agentSettingsEdits: { allowed: false } } } }
    grantSettingsEdit('tab-1', '/data/ion/engine.json')
    const decision = evaluateSettingsGuard(edit('/data/ion/engine.json'))
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' && decision.reason).toContain('sealed')
  })

  it('sealed on: approvals work even when the saved setting is off', () => {
    settings.value = { allowSettingsEdits: false }
    policy.value = { customFields: { 'ion-server': { agentSettingsEdits: { allowed: true } } } }
    expect(evaluateSettingsGuard(edit('/data/ion/engine.json')).kind).toBe('ask')
  })
})

describe('enterprise config', () => {
  it('is sealed: refused with the setting on, and refused with an approval in hand', () => {
    settings.value = { allowSettingsEdits: true }
    for (const path of ['/etc/ion/config.json', '/etc/ion/config.d/10-models.json', '/Library/Managed Preferences/com.ion.engine.plist', '/Library/Managed Preferences/someone/com.ion.engine.plist', '/etc/ion/managed.json', '/Library/Application Support/Ion/managed.json']) {
      grantSettingsEdit('tab-1', path)
      const decision = evaluateSettingsGuard(edit(path))
      expect(decision.kind).toBe('deny')
      expect(decision.kind === 'deny' && decision.reason).toContain('enterprise configuration')
    }
    expect(evaluateSettingsGuard(bash('sudo tee /etc/ion/config.json < /tmp/x')).kind).toBe('deny')
  })

  it('covers the file ION_ENTERPRISE_CONFIG names', () => {
    process.env.ION_ENTERPRISE_CONFIG = '/opt/managed/ion.json'
    try {
      settings.value = { allowSettingsEdits: true }
      expect(evaluateSettingsGuard(edit('/opt/managed/ion.json')).kind).toBe('deny')
    } finally {
      delete process.env.ION_ENTERPRISE_CONFIG
    }
  })
})

describe('the question', () => {
  it('is asked once per conversation and file while it is open', () => {
    const first = openSettingsGuardQuestion(edit('/data/ion/engine.json'), '/data/ion/engine.json')
    const again = openSettingsGuardQuestion(edit('/data/ion/engine.json'), '/data/ion/engine.json')
    expect(first.isNew).toBe(true)
    expect(again.isNew).toBe(false)
    expect(again.question.questionId).toBe(first.question.questionId)
  })

  it('can be taken once', () => {
    const { question } = openSettingsGuardQuestion(edit('/data/ion/engine.json'), '/data/ion/engine.json')
    expect(takeSettingsGuardQuestion(question.questionId)?.path).toBe('/data/ion/engine.json')
    expect(takeSettingsGuardQuestion(question.questionId)).toBeNull()
  })
})
