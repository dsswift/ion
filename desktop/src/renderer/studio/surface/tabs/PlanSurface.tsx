/**
 * PlanSurface — the Plan singleton surface tab: the active conversation's
 * plan document, live-updating, with an explicit empty state.
 *
 * Resolves current plan path first, then newest transcript plan path after
 * Implement clears current state. This preserves an implemented plan until a
 * newer plan replaces it. The implemented badge reads the transcript's durable
 * implementation provenance. Loads via fsReadFile and live-updates through fsWatchFile/onFileChanged. Conversation switches
 * retarget automatically.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle, Circle, DotsThree, FileText } from '@phosphor-icons/react'
import { useSessionStore } from '../../../stores/sessionStore'
import { PlanContent } from '../../../components/PlanContent'
import { useColors } from '../../../theme'
import { rDebug, rWarn } from '../../../rendererLogger'
import { activeInstance } from '../../../stores/conversation-instance'
import { hasPlanFileBeenWritten, isPlanImplementedInMessages, latestPlanPathFromMessages } from '../../../components/StatusBarAttachmentsParser'
import { Tooltip } from '../../../components/git/Tooltip'
import { useInteractiveState, interactiveBg } from '../../../hooks/useInteractiveState'
import { PlanActionsMenu } from './PlanActionsMenu'
import { planExportFileName } from './plan-export'

type PlanState =
  | { kind: 'empty' }
  | { kind: 'loading'; filePath: string }
  | { kind: 'reserved'; filePath: string }
  | { kind: 'ready'; filePath: string; content: string }
  | { kind: 'error'; filePath: string; message: string }

export function PlanSurface(): React.JSX.Element {
  const colors = useColors()
  const planInstance = useSessionStore((s) => activeInstance(s.conversationPanes, s.activeTabId))
  const planFilePath = latestPlanPathFromMessages(
    planInstance?.messages ?? [],
    planInstance?.planFilePath ?? null,
  )
  const planFileWritten = hasPlanFileBeenWritten(
    planInstance?.messages ?? [],
    planInstance?.planFilePath ?? null,
  )
  const reserved = !!planInstance?.planFilePath && !planFileWritten
  // Read positive implementation evidence from the transcript. Current history
  // carries implementationPhase on the user turn. Older live transcripts can
  // carry the renderer-only divider. Never infer completion from a missing path.
  const implemented = isPlanImplementedInMessages(planInstance?.messages ?? [], planFilePath)
  const [plan, setPlan] = useState<PlanState>({ kind: 'empty' })
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null)
  const actionButtonRef = useRef<HTMLButtonElement>(null)
  const actionButtonState = useInteractiveState()
  const closeMenu = useCallback(() => setMenuAnchor(null), [])

  const copyPlanValue = useCallback((value: string, kind: 'path' | 'contents'): void => {
    const fields = { path: planFilePath ?? '', copy_kind: kind }
    rDebug('studio.plan', 'copying plan value', fields)
    void navigator.clipboard.writeText(value).then(
      () => rDebug('studio.plan', 'copied plan value', fields),
      (error) => rWarn('studio.plan', 'copy plan value failed', { ...fields, error: String(error) }),
    )
  }, [planFilePath])

  const downloadPlan = useCallback((filePath: string, content: string): void => {
    const defaultFileName = planExportFileName(filePath, new Date())
    rDebug('studio.plan', 'opening plan export dialog', { path: filePath, default_file_name: defaultFileName })
    void window.ion.fsSaveDialog(undefined, defaultFileName).then(async (dialog) => {
      if (dialog.error) {
        rWarn('studio.plan', 'plan export dialog failed', { path: filePath, error: dialog.error })
        return
      }
      if (!dialog.filePath) {
        rDebug('studio.plan', 'plan export cancelled', { path: filePath })
        return
      }
      const result = await window.ion.fsWriteFile(dialog.filePath, content)
      if (!result.ok) {
        rWarn('studio.plan', 'plan export write failed', { path: dialog.filePath, error: result.error ?? 'unknown error' })
        return
      }
      rDebug('studio.plan', 'plan exported', { path: dialog.filePath, content_length: content.length })
    }).catch((error) => rWarn('studio.plan', 'plan export failed', { path: filePath, error: String(error) }))
  }, [])

  useEffect(() => {
    closeMenu()
    if (!planFilePath) {
      rDebug('studio.plan', 'no plan resolved for active conversation')
      setPlan({ kind: 'empty' })
      return
    }
    if (reserved) {
      rDebug('studio.plan', 'reserved plan awaits authored file', { path: planFilePath })
      setPlan({ kind: 'reserved', filePath: planFilePath })
      return
    }

    let alive = true
    rDebug('studio.plan', 'loading authored plan', { path: planFilePath })
    setPlan({ kind: 'loading', filePath: planFilePath })

    const load = (): void => {
      void window.ion
        .fsReadFile(planFilePath)
        .then((res) => {
          if (!alive) return
          if (res.content !== null) {
            rDebug('studio.plan', 'loaded resolved plan', { path: planFilePath, content_length: res.content.length })
            setPlan({ kind: 'ready', filePath: planFilePath, content: res.content })
          } else {
            const message = res.error ?? 'file unreadable'
            rWarn('studio.plan', 'resolved plan unreadable', { path: planFilePath, error: message })
            setPlan({ kind: 'error', filePath: planFilePath, message })
          }
        })
        .catch((err) => {
          if (!alive) return
          const message = String(err)
          rWarn('studio.plan', 'resolved plan load failed', { path: planFilePath, error: message })
          setPlan({ kind: 'error', filePath: planFilePath, message })
        })
    }
    load()

    // Live updates: re-plan rewrites the file; the watcher pushes changes.
    void window.ion
      .fsWatchFile(planFilePath)
      .then((res) => {
        if (!res.ok) rWarn('studio.plan', 'plan watch failed', { path: planFilePath, error: res.error ?? '' })
      })
      .catch((err) => rWarn('studio.plan', 'plan watch failed', { path: planFilePath, error: String(err) }))
    const off = window.ion.onFileChanged((changed) => {
      if (changed === planFilePath) {
        rDebug('studio.plan', 'plan file changed, reloading', { path: planFilePath })
        load()
      }
    })

    return () => {
      alive = false
      off()
      void window.ion.fsUnwatchFile(planFilePath).catch((err) => rDebug('studio.plan', 'unwatch failed', { error: String(err) }))
    }
  }, [closeMenu, planFilePath, reserved])

  if (plan.kind === 'empty') {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: colors.textTertiary,
          fontSize: 12,
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        No plan for this conversation.
      </div>
    )
  }
  if (plan.kind === 'reserved') {
    return (
      <div
        data-testid="plan-reserved-state"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          padding: 24,
          color: colors.textTertiary,
          fontSize: 12,
          fontFamily: 'system-ui, sans-serif',
          textAlign: 'center',
        }}
      >
        <FileText size={22} style={{ color: colors.textSecondary }} />
        <strong style={{ color: colors.textSecondary }}>Plan reserved</strong>
        <span>Agent has reserved this plan and has not authored it yet.</span>
      </div>
    )
  }
  if (plan.kind === 'error') {
    return (
      <div style={{ flex: 1, padding: 16, color: colors.textTertiary, fontSize: 12, fontFamily: 'system-ui, sans-serif' }}>
        Plan could not be read: {plan.message}
      </div>
    )
  }
  if (plan.kind === 'loading') {
    // Distinct from the zero-state per the view-readiness rule.
    return <div style={{ flex: 1 }} />
  }
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        data-testid="plan-implementation-status"
        aria-label={implemented ? 'Plan implemented' : 'Plan not implemented'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          minHeight: 31,
          padding: '4px 7px 4px 12px',
          borderBottom: `1px solid ${colors.containerBorder}`,
          color: implemented ? colors.statusComplete : colors.textTertiary,
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        {implemented ? <CheckCircle size={13} weight="fill" /> : <Circle size={13} />}
        <span>{implemented ? 'Implemented' : 'Not implemented'}</span>
        <span
          data-testid="plan-file-path"
          style={{
            flex: 1,
            minWidth: 0,
            marginLeft: 7,
            overflow: 'hidden',
            color: colors.textTertiary,
            fontFamily: 'Menlo, Monaco, monospace',
            fontSize: 10,
            fontWeight: 400,
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {plan.filePath}
        </span>
        <Tooltip text="Plan actions">
          <button
            ref={actionButtonRef}
            type="button"
            aria-label="Plan actions"
            aria-haspopup="menu"
            aria-expanded={menuAnchor !== null}
            className="ion-focusable"
            onClick={() => {
              if (menuAnchor) {
                closeMenu()
                return
              }
              const rect = actionButtonRef.current?.getBoundingClientRect()
              if (rect) setMenuAnchor({ x: rect.right, y: rect.bottom })
            }}
            {...actionButtonState.handlers}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 22,
              flexShrink: 0,
              border: 'none',
              borderRadius: 5,
              background: interactiveBg(colors, actionButtonState),
              color: colors.textSecondary,
              cursor: 'pointer',
            }}
          >
            <DotsThree size={16} weight="bold" />
          </button>
        </Tooltip>
      </div>
      {menuAnchor && (
        <PlanActionsMenu
          anchor={menuAnchor}
          trigger={actionButtonRef.current}
          onClose={closeMenu}
          onCopyPath={() => copyPlanValue(plan.filePath, 'path')}
          onCopyContents={() => copyPlanValue(plan.content, 'contents')}
          onDownload={() => downloadPlan(plan.filePath, plan.content)}
        />
      )}
      <PlanContent content={plan.content} />
    </div>
  )
}
