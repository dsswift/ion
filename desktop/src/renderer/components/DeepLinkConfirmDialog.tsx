import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { rInfo } from '../rendererLogger'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { isMirrorWindow } from '@ion/server/lib/window-role'
import type { DeepLinkConfirmRequest } from '@ion/shared/types'
import { DEFAULT_MONO_FONT } from '../typography'
import { host } from '../host/host-instance'
import { tabListKey } from '../studio/connection/tab-environment'
import { answerRemoteDeepLink, onRemoteDeepLinkConfirm } from '../deeplink-client'
import { rWarn } from '../rendererLogger'

/**
 * Approval gate for an untrusted `ion://` deep link.
 *
 * A deep link that carries no valid capability token could have come from a web
 * page or a chat message, so nothing runs until the operator says so. This
 * dialog is what they read before deciding.
 *
 * ── Why the full command and full prompt are shown verbatim ──────────────────
 * A dialog that says "a link wants to run a command" and hides the command
 * trains people to click Approve, which manufactures consent rather than
 * informing it — worse than no dialog. So the command is shown in a monospace
 * block, and the prompt is shown in full (scrollable when long). The operator
 * approves the specific thing, or nothing.
 *
 * ── Fail-closed ──────────────────────────────────────────────────────────────
 * Dismissing by backdrop or Escape DECLINES. There is no "close without
 * answering": main is holding a promise, and an ambiguous dismissal must resolve
 * to the safe direction. Refusing is always safe; running is not.
 */
export function DeepLinkConfirmDialog(): React.JSX.Element | null {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const owner = isMirrorWindow() ? 'studio' : 'overlay'
  const tabs = useSessionStore((s) => s.tabs)
  const [queue, setQueue] = useState<DeepLinkConfirmRequest[]>([])
  const [selectedTabs, setSelectedTabs] = useState<Record<string, string>>({})

  // A link this client opened itself (a browser `/open/...` path) comes back
  // as a confirmation for this window alone, with no OS registration involved.
  useEffect(() => onRemoteDeepLinkConfirm((request) => {
    rInfo('deeplink', 'remote confirmation queued', { id: request.id, action: request.action })
    setQueue((q) => [...q, request])
  }), [])

  useEffect(() => {
    // ion:// deep links are an OS URL-scheme registration -- Electron-only,
    // no wire equivalent, and BrowserStudioHost already omits 'deeplink'
    // from capabilities() for exactly this reason.
    if (!host.capabilities().includes('deeplink')) return
    host.shell.setDeepLinkConfirmAvailability(owner, true)
    const removeSettled = host.shell.onDeepLinkConfirmSettled((id) => {
      setQueue((q) => q.filter((request) => request.id !== id))
    })
    const receive = host.shell.onDeepLinkConfirmRequest((request) => {
      if (request.owner !== owner) return
      rInfo('deeplink', 'confirmation requested', { id: request.id, action: request.action })
      setQueue((q) => [...q, request])
    })
    return () => {
      host.shell.setDeepLinkConfirmAvailability(owner, false)
      removeSettled()
      receive()
    }
  }, [owner])

  const current = queue[0]

  // Escape declines. Registered while a request is showing, and depends on
  // `current` so it always answers the request actually on screen.
  useEffect(() => {
    if (!current) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      answer(current.id, false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `answer` is stable (module-scope behaviour via setQueue); keying on the id is what matters
  }, [current?.id])

  function answer(id: string, approved: boolean): void {
    const currentRequest = queue.find((request) => request.id === id)
    const tabId = currentRequest?.selectTab ? selectedTabs[id] : undefined
    rInfo('deeplink', 'confirmation answered', { id, approved, tab_id: tabId ?? '' })
    if (currentRequest?.owner === 'remote') {
      answerRemoteDeepLink(id, approved).catch((err: unknown) => rWarn('deeplink', 'remote confirmation answer failed', { id, error: String(err) }))
    } else {
      host.shell.resolveDeepLinkConfirm({ id, owner, approved, tabId })
    }
    setQueue((q) => q.filter((r) => r.id !== id))
  }

  if (!popoverLayer || !current) return null

  const isTerminal = current.action === 'terminal'
  const isExt = current.action === 'ext'
  const title = isTerminal ? 'Run a command from a link?' : isExt ? 'Run an extension command from a link?' : 'Start a conversation from a link?'
  const verb = isTerminal ? 'Run command' : isExt ? 'Run' : (current.submit ? 'Send prompt' : 'Open conversation')

  return createPortal(
    <motion.div
      data-ion-ui
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      // PopoverLayer is pointerEvents:'none'; an interactive child must opt back
      // in or every click passes straight through it.
      style={{
        pointerEvents: 'auto',
        position: 'fixed',
        inset: 0,
        background: colors.scrim,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
        padding: 16,
        boxSizing: 'border-box',
      }}
      onClick={() => answer(current.id, false)}
    >
      <motion.div
        initial={{ scale: 0.97 }}
        animate={{ scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: '100%',
          maxHeight: '100%',
          minWidth: 0,
          boxSizing: 'border-box',
          overflow: 'auto',
          background: colors.surfacePrimary,
          border: `1px solid ${colors.borderSubtle}`,
          borderRadius: 12,
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: colors.textPrimary }}>{title}</div>

        <div style={{ fontSize: 12, color: colors.textSecondary, lineHeight: 1.5 }}>
          This request did not come from a program on this Mac, so Ion is asking first.
          Approve it only if you recognise where the link came from.
        </div>

        {current.dir ? (
          <Field label="Directory" colors={colors}>{current.dir}</Field>
        ) : null}

        {isTerminal && current.selectTab ? (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: colors.textSecondary }}>
            Conversation
            <select
              value={selectedTabs[current.id] ?? ''}
              onChange={(event) => setSelectedTabs((prior) => ({ ...prior, [current.id]: event.target.value }))}
              style={{ color: colors.textPrimary, background: colors.surfaceSecondary, border: `1px solid ${colors.borderSubtle}`, borderRadius: 6, padding: '8px 10px' }}
            >
              <option value="">Choose a conversation</option>
              {tabs.map((tab) => <option key={tabListKey(tab)} value={tab.id}>{tab.title || tab.id}</option>)}
            </select>
          </label>
        ) : isTerminal && current.tabId ? (
          <Field label="Conversation" colors={colors}>{current.tabId}</Field>
        ) : null}

        {isTerminal && current.title ? (
          <Field label="Pane name" colors={colors}>{current.title}</Field>
        ) : null}

        {isTerminal && current.cmd ? (
          <Field label="Command" colors={colors} mono>{current.cmd}</Field>
        ) : null}

        {isTerminal && current.key ? (
          <Field label="Launch key (a pane holding it is stopped and reused)" colors={colors} mono>{current.key}</Field>
        ) : null}

        {isExt && current.label ? (
          <Field label="Extension route" colors={colors}>{current.label}</Field>
        ) : null}

        {isExt && current.command ? (
          <Field label="Command (sent to the conversation)" colors={colors} mono>{current.command}</Field>
        ) : null}

        {isExt ? (
          <Field label="Conversation" colors={colors}>{current.conversationId ?? 'A new conversation in the directory above'}</Field>
        ) : null}

        {!isTerminal && !isExt && current.text ? (
          <Field label={current.submit ? 'Prompt (will be sent immediately)' : 'Prompt (will wait in the composer)'} colors={colors} mono>
            {current.text}
          </Field>
        ) : null}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 4 }}>
          <button
            data-ion-ui
            onClick={() => answer(current.id, false)}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: `1px solid ${colors.borderSubtle}`,
              background: 'transparent',
              color: colors.textPrimary,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            data-ion-ui
            onClick={() => answer(current.id, true)}
            disabled={current.selectTab && !selectedTabs[current.id]}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: `1px solid ${colors.accent}`,
              background: colors.accent,
              color: colors.textOnAccent,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {verb}
          </button>
        </div>

        {queue.length > 1 ? (
          <div style={{ fontSize: 11, color: colors.textSecondary }}>
            {queue.length - 1} more request{queue.length - 1 === 1 ? '' : 's'} waiting.
          </div>
        ) : null}
      </motion.div>
    </motion.div>,
    popoverLayer,
  )
}

/** One labelled, selectable value. `mono` for anything that is literal text. */
function Field({
  label, children, colors, mono = false,
}: {
  label: string
  children: React.ReactNode
  colors: ReturnType<typeof useColors>
  mono?: boolean
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: colors.textSecondary }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 12,
          color: colors.textPrimary,
          fontFamily: mono ? DEFAULT_MONO_FONT : undefined,
          background: mono ? colors.surfaceSecondary : undefined,
          border: mono ? `1px solid ${colors.borderSubtle}` : undefined,
          borderRadius: mono ? 6 : undefined,
          padding: mono ? '8px 10px' : undefined,
          maxHeight: 220,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          // Selectable: the operator may want to inspect or copy the command
          // before deciding.
          userSelect: 'text',
        }}
      >
        {children}
      </div>
    </div>
  )
}
