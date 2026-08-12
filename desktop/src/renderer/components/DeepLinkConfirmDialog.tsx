import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { rInfo } from '../rendererLogger'
import { useSessionStore } from '../stores/sessionStore'
import { isMirrorWindow } from '../lib/window-role'
import type { DeepLinkConfirmRequest } from '../../shared/types'

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
  const owner = isMirrorWindow() ? 'atv' : 'overlay'
  const tabs = useSessionStore((s) => s.tabs)
  const [queue, setQueue] = useState<DeepLinkConfirmRequest[]>([])
  const [selectedTabs, setSelectedTabs] = useState<Record<string, string>>({})

  useEffect(() => {
    window.ion.setDeepLinkConfirmAvailability(owner, true)
    const removeSettled = window.ion.onDeepLinkConfirmSettled((id) => {
      setQueue((q) => q.filter((request) => request.id !== id))
    })
    const receive = window.ion.onDeepLinkConfirmRequest((request) => {
      if (request.owner !== owner) return
      rInfo('deeplink', 'confirmation requested', { id: request.id, action: request.action })
      setQueue((q) => [...q, request])
    })
    return () => {
      window.ion.setDeepLinkConfirmAvailability(owner, false)
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
    window.ion.resolveDeepLinkConfirm({ id, owner, approved, tabId })
    setQueue((q) => q.filter((r) => r.id !== id))
  }

  if (!popoverLayer || !current) return null

  const isTerminal = current.action === 'terminal'
  const title = isTerminal ? 'Run a command from a link?' : 'Start a conversation from a link?'
  const verb = isTerminal ? 'Run command' : (current.submit ? 'Send prompt' : 'Open conversation')

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
      }}
      onClick={() => answer(current.id, false)}
    >
      <motion.div
        initial={{ scale: 0.97 }}
        animate={{ scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: '90vw',
          maxHeight: '80vh',
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
              {tabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.title || tab.id}</option>)}
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

        {!isTerminal && current.text ? (
          <Field label={current.submit ? 'Prompt (will be sent immediately)' : 'Prompt (will wait in the composer)'} colors={colors} mono>
            {current.text}
          </Field>
        ) : null}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: colors.textSecondary }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 12,
          color: colors.textPrimary,
          fontFamily: mono ? 'Menlo, Monaco, monospace' : undefined,
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
