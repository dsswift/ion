/**
 * ConflictToasts — bottom-right toasts raised the moment a sync or land fails
 * with conflicts.
 *
 * The failure this closes: a conflicted sync used to fail into the log file
 * only, the operator believed it succeeded, and the worktree sat mid-rebase
 * with its work invisible. The toast fires at the moment of failure — not on
 * the next panel open — names the directory, and carries the Resolve entry.
 *
 * Follows the EngineNotificationToasts pattern: a flow column of individually
 * dismissable toasts. No auto-dismiss timer here, deliberately — an engine
 * notification is ephemeral signal, but an unresolved conflict blocks work
 * until acted on, and a toast that ages out re-hides exactly the failure this
 * surface exists to show. Dismissing hides the toast only; the row badge and
 * panel banner derive from live inventory state and stay until resolved.
 */
import React, { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Warning, X } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import { ConflictsDialog } from './git/ConflictsDialog'

export function ConflictToasts(): React.JSX.Element | null {
  const colors = useColors()
  const alerts = useSessionStore((s) => s.gitConflictAlerts)
  const [resolving, setResolving] = useState<string | null>(null)

  const visible = [...alerts.entries()].filter(([, a]) => !a.dismissed)
  if (visible.length === 0 && !resolving) return null

  return (
    <>
      {/* data-ion-ui: the overlay window ignores mouse events except over
          elements carrying this marker (useClickThrough). Without it every
          click on the toast — Resolve, dismiss — passed through to the
          desktop underneath, making the toast undismissable. */}
      <div
        data-ion-ui
        style={{
          // viewport-ok: pinned to the bottom-right corner by construction (bottom/right are constants, not an anchor), and pointerEvents:'none' means it never intercepts a click even if content overflowed.
          position: 'fixed', bottom: 32, right: 12, zIndex: 60,
          display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end',
          pointerEvents: 'none',
        }}
      >
        <AnimatePresence>
          {visible.map(([directory, alert]) => (
            <motion.div
              key={directory}
              data-testid={`conflict-toast-${directory.split('/').filter(Boolean).pop()}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 10px', borderRadius: 6, pointerEvents: 'auto',
                background: colors.containerBg,
                border: `1px solid ${alert.kind === 'refusal' ? colors.warningFg : colors.dangerFg}`,
                boxShadow: colors.containerShadow,
                maxWidth: 420,
              }}
            >
              <Warning size={13} color={alert.kind === 'refusal' ? colors.warningFg : colors.dangerFg} style={{ flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: colors.textPrimary, minWidth: 0 }}>
                {alert.kind === 'refusal'
                  ? <>Sync refused for <strong>{alert.label ?? directory.split('/').filter(Boolean).pop()}</strong>{alert.message ? ` — ${alert.message}` : ''}</>
                  : <>
                    {alert.source === 'sync' ? 'Sync hit conflicts' : alert.source === 'land' ? 'Land hit conflicts' : 'Conflicts detected'}
                    {' in '}
                    <strong>{alert.label ?? directory.split('/').filter(Boolean).pop()}</strong>
                  </>}
              </span>
              {/* A refusal has no in-progress operation to resolve — the
                  remediation is in the message (commit or stash), so offering
                  Resolve would open a dialog with nothing in it. */}
              {alert.kind !== 'refusal' && (
                <button
                  data-testid="conflict-toast-resolve"
                  onClick={() => setResolving(directory)}
                  style={{
                    fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer', flexShrink: 0,
                    border: `1px solid ${colors.dangerFg}`, background: 'transparent', color: colors.dangerFg,
                  }}
                >
                  Resolve
                </button>
              )}
              <button
                data-testid="conflict-toast-dismiss"
                onClick={() => useSessionStore.getState().dismissConflictAlert(directory)}
                style={{
                  display: 'inline-flex', alignItems: 'center', padding: 1, flexShrink: 0,
                  background: 'transparent', border: 'none', color: colors.textTertiary, cursor: 'pointer',
                }}
              >
                <X size={11} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {resolving && (
        <ConflictsDialog
          directory={resolving}
          onClose={() => setResolving(null)}
        />
      )}
    </>
  )
}
