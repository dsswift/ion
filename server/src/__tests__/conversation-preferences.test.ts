/**
 * A Personal preference lives on a client. The server reads the ones it needs
 * from the conversation's stamp, which the creating and sending clients
 * write, because most of those reads happen with no request in context.
 *
 * The hole this closes: "read it from the request" cannot work for an AI
 * title fired by an engine event, an early-stop decision asked for mid-run,
 * or a session restarted after an engine crash with nobody connected.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const paths = vi.hoisted(() => ({ dir: '' }))
vi.mock('../paths', async (importOriginal) => ({ ...(await importOriginal<object>()), dataDir: () => paths.dir }))
vi.mock('../store/session-store-force-flush', () => ({ forceFlushTabs: vi.fn() }))

import { runAsPrincipal } from '../identity/request-principal'
import { writeSettingsForSubject } from '../persistence/user-settings-store'
import {
  defaultThinkingEffortOf, effectiveConversationPreferences, effectiveRequestPreferences, restamp,
  restoredConversationPreferences, sessionThinkingConfigOf, stampForNewConversation,
} from '../conversation-preferences'
import type { PersonalPreferences } from '@ion/shared/settings-registry'

function asClient<T>(preferences: PersonalPreferences, fn: () => T): T {
  return runAsPrincipal({ principal: { subject: 'user:guest', displayName: 'guest' }, preferences }, fn)
}

beforeEach(() => {
  paths.dir = mkdtempSync(join(tmpdir(), 'ion-conversation-preferences-'))
  writeFileSync(join(paths.dir, 'settings.json'), JSON.stringify({}))
})
afterEach(() => rmSync(paths.dir, { recursive: true, force: true }))

describe('stamping', () => {
  it("stamps a new conversation with the creating client's preferences", () => {
    asClient({ enableClaudeCompat: true, defaultThinkingEffort: 'high' }, () => {
      expect(stampForNewConversation()).toEqual({ enableClaudeCompat: true, defaultThinkingEffort: 'high' })
      expect(effectiveRequestPreferences().defaultThinkingEffort).toBe('high')
      expect(effectiveRequestPreferences().defaultPermissionMode).toBe('plan')
    })
  })

  it('stamps an empty object outside a request, never nothing', () => {
    expect(stampForNewConversation()).toEqual({})
  })

  it("takes the sending client's preferences over the earlier stamp", () => {
    const earlier: PersonalPreferences = { aiGeneratedTitles: true, enableClaudeCompat: true }
    asClient({ aiGeneratedTitles: false }, () => {
      expect(restamp(earlier)).toEqual({ aiGeneratedTitles: false, enableClaudeCompat: true })
    })
  })

  it('leaves the stamp alone for a machine-sent prompt and for an unchanged client', () => {
    const earlier: PersonalPreferences = { aiGeneratedTitles: false }
    expect(restamp(earlier)).toBe(earlier)
    asClient({ aiGeneratedTitles: false }, () => expect(restamp(earlier)).toBe(earlier))
  })
})

describe('reading with no request in context', () => {
  it('reads the stamp, then the registry default', () => {
    const prefs = effectiveConversationPreferences({ conversationPreferences: { enableEarlyStopContinuation: true } })
    expect(prefs.enableEarlyStopContinuation).toBe(true)
    expect(prefs.aiGeneratedTitles).toBe(true)
    expect(prefs.enableClaudeCompat).toBe(false)
    expect(effectiveConversationPreferences(undefined).enableEarlyStopContinuation).toBe(false)
  })
})

describe('a conversation from before the stamp existed', () => {
  it("keeps running under its owner's earlier settings, not a default", () => {
    writeSettingsForSubject('user:guest', { enableClaudeCompat: true, defaultThinkingEffort: 'high', selectedTheme: 'dusk' })
    const stamp = restoredConversationPreferences({ id: 't', principalSubject: 'user:guest' })
    expect(stamp).toEqual({ enableClaudeCompat: true, defaultThinkingEffort: 'high' })
  })

  it('never overwrites a stamp a conversation already has', () => {
    writeSettingsForSubject('user:guest', { enableClaudeCompat: true })
    const existing: PersonalPreferences = { enableClaudeCompat: false }
    expect(restoredConversationPreferences({ id: 't', principalSubject: 'user:guest', conversationPreferences: existing })).toBe(existing)
  })
})

describe('thinking level', () => {
  it('ships medium for a value that is not on the ladder', () => {
    expect(defaultThinkingEffortOf({ defaultThinkingEffort: 'grande' })).toBe('medium')
  })

  it("rejects 'adaptive': this preference seeds effort-based models only", () => {
    expect(defaultThinkingEffortOf({ defaultThinkingEffort: 'adaptive' })).toBe('medium')
  })

  it("carries the conversation's level to the engine, and omits it entirely when off", () => {
    expect(sessionThinkingConfigOf({ defaultThinkingEffort: 'low' })).toEqual({ enabled: true, effort: 'low' })
    // Deliberately undefined rather than {enabled:false}: an absent field
    // leaves the engine's own engine.json default in play.
    expect(sessionThinkingConfigOf({ defaultThinkingEffort: 'off' })).toBeUndefined()
    expect(sessionThinkingConfigOf({ defaultThinkingEffort: 'high' })).not.toHaveProperty('streamDeltas')
  })
})
