/**
 * session-init-capture — captureSessionInitId contract.
 *
 * Pins two behaviors of captureSessionInitId (session-init-capture.ts):
 *
 *  1. Capture: a session_init carrying a NOT-yet-known sessionId produces a
 *     patch that appends the id to the raw `conversationIds` chain AND grows
 *     the reasoned session ledger (`sessions`). The pending cut reason (if any)
 *     is consumed into the ledger entry; absent a pending reason it defaults to
 *     'unknown'.
 *
 *  2. Reload survival: the documented reload path is the session-ledger
 *     invariant (shared/session-ledger.ts) — "a process or engine restart
 *     resumes currentSessionId and appends nothing". After the captured id is
 *     persisted into the instance and the instance is reloaded, resolving the
 *     current session id yields the captured id, and a repeated session_init
 *     for that SAME id is a no-op (idempotent: returns {}), so restart cannot
 *     fragment the conversation.
 */

import { describe, it, expect } from 'vitest'
import { captureSessionInitId } from '../session-init-capture'
import { resolveCurrentSessionId } from '@ion/shared/session-ledger'
import type { ConversationInstance } from '@ion/shared/types'

type CaptureInst = Pick<ConversationInstance, 'conversationIds' | 'sessions' | 'pendingCutReason'>

const NOW = 1_700_000_000_000

describe('session-init-capture — captureSessionInitId capture', () => {
  it('captures a new session_init id into the conversationIds chain and the ledger', () => {
    const inst: CaptureInst = { conversationIds: [], sessions: [] }

    const patch = captureSessionInitId(inst, 'sess-A', NOW)

    // Raw chain grows with the new id.
    expect(patch.conversationIds).toEqual(['sess-A'])
    // Ledger grows with a reasoned entry (default reason 'unknown', timestamped).
    expect(patch.sessions).toHaveLength(1)
    expect(patch.sessions![0].id).toBe('sess-A')
    expect(patch.sessions![0].reason).toBe('unknown')
    expect(patch.sessions![0].createdAt).toBe(NOW)
  })

  it('consumes a pending cut reason into the ledger entry', () => {
    const inst: CaptureInst = { conversationIds: [], sessions: [], pendingCutReason: 'clear' }

    const patch = captureSessionInitId(inst, 'sess-A', NOW)

    expect(patch.sessions![0].reason).toBe('clear')
    // The one-shot pending reason is consumed (cleared) on use.
    expect('pendingCutReason' in patch).toBe(true)
    expect(patch.pendingCutReason).toBeUndefined()
  })

  it('is a no-op when the id is already in the chain', () => {
    const inst: CaptureInst = { conversationIds: ['sess-A'], sessions: [] }
    expect(captureSessionInitId(inst, 'sess-A', NOW)).toEqual({})
  })
})

describe('session-init-capture — captured id survives the documented reload path', () => {
  it('resumes the captured id after reload and appends nothing on a repeat session_init', () => {
    // 1. Live capture: session_init mints sess-A onto a fresh instance.
    const live: CaptureInst = { conversationIds: [], sessions: [] }
    const patch = captureSessionInitId(live, 'sess-A', NOW)

    // 2. Persist: the caller commits the patch onto the instance (this is the
    //    force-flushed state that lands on disk).
    const persisted = {
      conversationIds: patch.conversationIds!,
      sessions: patch.sessions!,
    }

    // 3. Reload: a fresh process reads the persisted instance back. The
    //    documented reload path resolves the CURRENT session id from the
    //    ledger — the captured id is the newest entry, so it survives the
    //    reload verbatim.
    const reloaded = { sessions: persisted.sessions, conversationIds: persisted.conversationIds }
    expect(resolveCurrentSessionId(reloaded)).toBe('sess-A')

    // 4. Restart resumes, appends nothing: the engine re-emits session_init for
    //    the SAME resumed id after reload. captureSessionInitId is idempotent on
    //    a known id — it returns {} (no new ledger entry, no chain growth), so a
    //    restart structurally cannot fragment the conversation.
    const afterReload: CaptureInst = { conversationIds: persisted.conversationIds, sessions: persisted.sessions }
    expect(captureSessionInitId(afterReload, 'sess-A', NOW + 5000)).toEqual({})

    // The captured id is still the resolved current id after the idempotent
    // repeat — unchanged and unduplicated.
    expect(resolveCurrentSessionId(afterReload)).toBe('sess-A')
    expect(afterReload.conversationIds).toEqual(['sess-A'])
  })
})
