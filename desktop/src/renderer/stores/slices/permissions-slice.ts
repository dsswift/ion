import type { TabStatus } from '../../../shared/types'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'
import { activeInstance, commitInstance } from '../conversation-instance'
import { rDebug, rInfo, rWarn } from '../../rendererLogger'

// Auto-recovery bounds for the stuck-tab watchdog. A genuinely dead provider
// must not drive an infinite stall→resume loop, so automatic resumes are
// capped within a rolling window. After the cap, the watchdog stops
// auto-resuming and surfaces an honest message (forceRecoverTab) instead.
const AUTO_RECOVERY_MAX_ATTEMPTS = 2
const AUTO_RECOVERY_WINDOW_MS = 10 * 60 * 1000 // 10 minutes

export function createPermissionsSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    respondPermission: (tabId, questionId, optionId) => {
      window.ion.respondPermission(tabId, questionId, optionId).catch(() => {})

      // permissionQueue lives on the active conversation instance now; filter it
      // there and derive currentActivity (a tab field) from the remaining queue.
      set((s) => {
        const inst = activeInstance(s.conversationPanes, tabId)
        const remaining = (inst?.permissionQueue ?? []).filter((p) => p.questionId !== questionId)
        const conversationPanes = commitInstance(s.conversationPanes, tabId, (i) => ({
          ...i,
          permissionQueue: i.permissionQueue.filter((p) => p.questionId !== questionId),
        }))
        const tabs = s.tabs.map((t) => {
          if (t.id !== tabId) return t
          return {
            ...t,
            currentActivity: remaining.length > 0
              ? `Waiting for permission: ${remaining[0].toolTitle}`
              : 'Working...',
          }
        })
        return { tabs, conversationPanes }
      })
    },

    respondElicitation: (tabId, requestId, response, cancelled) => {
      window.ion.respondElicitation(tabId, requestId, response, cancelled).catch(() => {})

      // elicitationQueue lives on the active conversation instance. Remove the
      // answered request and derive currentActivity from what remains so the
      // tab stops showing "Waiting for approval" once the queue drains.
      set((s) => {
        const inst = activeInstance(s.conversationPanes, tabId)
        const remaining = (inst?.elicitationQueue ?? []).filter((e) => e.requestId !== requestId)
        const conversationPanes = commitInstance(s.conversationPanes, tabId, (i) => ({
          ...i,
          elicitationQueue: i.elicitationQueue.filter((e) => e.requestId !== requestId),
        }))
        const tabs = s.tabs.map((t) => {
          if (t.id !== tabId) return t
          return {
            ...t,
            currentActivity: remaining.length > 0 ? 'Waiting for approval' : 'Working...',
          }
        })
        return { tabs, conversationPanes }
      })
    },

    forceRecoverTab: (tabId, reason) => {
      rWarn('session.recover', 'force recovering tab', { tab_id: tabId, reason })
      try { window.ion.stopTab(tabId) } catch {}
      // permissionQueue / permissionDenied / messages all live on the active
      // conversation instance now. Clear the queue + denial and append the
      // recovery system message onto the instance; keep status/activity on the tab.
      set((s) => {
        const inst = activeInstance(s.conversationPanes, tabId)
        const msgs = inst?.messages ?? []
        const lastMsg = msgs[msgs.length - 1]
        const alreadyRecovered = lastMsg?.role === 'system' && lastMsg.content.startsWith('Recovered:')
        const conversationPanes = commitInstance(s.conversationPanes, tabId, (i) => ({
          ...i,
          permissionQueue: [],
          permissionDenied: null,
          messages: alreadyRecovered
            ? i.messages
            : [
                ...i.messages,
                {
                  id: nextMsgId(),
                  role: 'system' as const,
                  content: `Recovered: ${reason}`,
                  timestamp: Date.now(),
                },
              ],
        }))
        const tabs = s.tabs.map((t) => {
          if (t.id !== tabId) return t
          return {
            ...t,
            status: 'idle' as TabStatus,
            activeRequestId: null,
            currentActivity: '',
            lastEventAt: Date.now(),
          }
        })
        return { tabs, conversationPanes }
      })
    },

    autoRecoverStuckTab: (tabId) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) return false

      // Bound automatic resumes within a rolling window so a genuinely dead
      // provider can't loop forever. Reset the window if it has elapsed.
      const now = Date.now()
      const windowStart = tab.autoRecoveryWindowStartedAt ?? 0
      const windowOpen = now - windowStart < AUTO_RECOVERY_WINDOW_MS
      const attempts = windowOpen ? (tab.autoRecoveryAttempts ?? 0) : 0

      if (attempts >= AUTO_RECOVERY_MAX_ATTEMPTS) {
        // Cap reached — stop auto-resuming and surface an honest message. Only
        // now does the user need to know anything happened.
        rWarn('session.recover', 'attempt cap reached, falling back to manual recovery', { tab_id: tabId, attempt: attempts, max: AUTO_RECOVERY_MAX_ATTEMPTS })
        get().forceRecoverTab(
          tabId,
          `The connection stalled repeatedly and automatic recovery did not succeed after ${AUTO_RECOVERY_MAX_ATTEMPTS} attempts. The tab has been reset; send a message to continue.`,
        )
        // Clear the recovery window so a later, unrelated stall starts fresh.
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tabId ? { ...t, autoRecoveryAttempts: 0, autoRecoveryWindowStartedAt: null } : t,
          ),
        }))
        return false
      }

      // The last user prompt is the pinned prompt captured by submit(). If it's
      // missing (e.g. a session with no user turn yet), we cannot resume — fall
      // back to a plain reset so the tab is at least usable.
      const lastPrompt = get().enginePinnedPrompt.get(tabId)
      if (!lastPrompt || !lastPrompt.trim()) {
        rWarn('session.recover', 'no last prompt to resume, plain reset', { tab_id: tabId })
        get().forceRecoverTab(
          tabId,
          'The connection stalled with no engine activity. The tab has been reset; send a message to continue.',
        )
        return false
      }

      const attemptNo = attempts + 1
      rWarn('session.recover', 'auto-resuming', { tab_id: tabId, attempt: attemptNo, max: AUTO_RECOVERY_MAX_ATTEMPTS })

      // Record the attempt and a quiet, non-alarming system line. The user's
      // stated ideal is "nothing would have happened"; a single easy-to-ignore
      // line keeps the resume observable without an alert.
      set((s) => {
        const inst = activeInstance(s.conversationPanes, tabId)
        const msgs = inst?.messages ?? []
        const lastMsg = msgs[msgs.length - 1]
        const alreadyNoted = lastMsg?.role === 'system' && lastMsg.content.startsWith('Connection stalled')
        const conversationPanes = alreadyNoted
          ? s.conversationPanes
          : commitInstance(s.conversationPanes, tabId, (i) => ({
              ...i,
              messages: [
                ...i.messages,
                {
                  id: nextMsgId(),
                  role: 'system' as const,
                  content: 'Connection stalled — automatically resuming…',
                  timestamp: Date.now(),
                },
              ],
            }))
        return {
          conversationPanes,
          tabs: s.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  // Reset run state to idle BEFORE the resubmit so submit()
                  // starts a fresh run instead of treating the tab as busy and
                  // steering into a run that no longer exists.
                  status: 'idle' as TabStatus,
                  activeRequestId: null,
                  currentActivity: '',
                  autoRecoveryAttempts: attemptNo,
                  autoRecoveryWindowStartedAt: windowOpen ? (t.autoRecoveryWindowStartedAt ?? now) : now,
                  lastEventAt: now, // reset the watchdog clock so it doesn't immediately re-fire
                }
              : t,
          ),
        }
      })

      // Power-cycle the engine session in-process (stop + drop started flag) so
      // the next prompt re-StartSessions with a fresh, live root — no process
      // restart. restartTabSession PRESERVES conversationId; the engine reloads
      // history from disk by that id on the resubmit, so context is preserved.
      // (resetTabSession would NULL conversationId and force a fresh empty
      // conversation — destructive for a simple stuck-tab recovery, and a source
      // of the conversation-fragmentation defect. Use the non-destructive
      // restart here.) Then resubmit the last prompt through the normal send path.
      //
      // ORDERING GUARANTEE (B4): restartTabSession (ipcMain.on — fire-and-forget)
      // and the resubmit's PROMPT (ipcMain.handle) arrive to the main process over
      // Electron's single-renderer IPC channel, which is FIFO. The stop_session
      // command is queued to the engine socket inside the .on handler, which
      // completes before the .handle for PROMPT is dequeued. Engine socket is also
      // FIFO. So stop_session reaches the engine before start_session — the old
      // session is always stopped before the new one starts. No sequencing fix is
      // needed; this comment is the ordering proof.
      try {
        rDebug('session.recover', 'queueing stop_session', { tab_id: tabId })
        window.ion.restartTabSession(tabId)
        rDebug('session.recover', 'stop_session dispatched', { tab_id: tabId })
      } catch (err) {
        rWarn('session.recover', 'restartTabSession failed', { tab_id: tabId, error: String(err) })
        return false
      }
      rInfo('session.recover', 'resubmitting prompt', { tab_id: tabId, prompt_len: lastPrompt.length })
      get().submit(tabId, lastPrompt)
      return true
    },
  }
}
