import React, { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowCounterClockwise, GitFork } from '@phosphor-icons/react'
import { useSessionStore } from '../../stores/sessionStore'
import { activeInstance } from '../../stores/conversation-instance'
import { MAIN_INSTANCE_ID } from '../../../shared/session-key'
import { useColors } from '../../theme'
import { CopyButton } from './CopyButton'
import type { Message } from '../../../shared/types'
import { rError } from '../../rendererLogger'

interface Props {
  message: Message
  variant: 'user' | 'assistant'
  /** Optional explicit instance context; Plain tabs use MAIN_INSTANCE_ID. */
  engineContext?: { tabId: string; instanceId: string }
}

/** Hover overlay actions (copy / rewind / fork) for a user or assistant message. */
export function MessageActions({ message, variant, engineContext }: Props) {
  const colors = useColors()
  const tab = useSessionStore((s) => s.tabs.find((t) => t.id === (engineContext?.tabId ?? s.activeTabId)))
  const rewindEngineInstance = useSessionStore((s) => s.rewindEngineInstance)
  const forkFromMessage = useSessionStore((s) => s.forkFromMessage)
  const isIdle = tab != null && tab.status !== 'running' && tab.status !== 'connecting'
  const [confirmRewind, setConfirmRewind] = useState(false)

  // Reset confirmation after timeout
  useEffect(() => {
    if (!confirmRewind) return
    const timer = setTimeout(() => setConfirmRewind(false), 2500)
    return () => clearTimeout(timer)
  }, [confirmRewind])

  const handleRewind = () => {
    if (!tab || !isIdle) return
    if (!confirmRewind) {
      setConfirmRewind(true)
      return
    }
    setConfirmRewind(false)
    // User-turn ordinal fallback: message ids are WINDOW-LOCAL (the Studio
    // mirror hydrates history rows with canonical 8-hex ids while the owner
    // holds its own optimistic msg-N ids), so a forwarded rewind by id alone
    // misses in the owner's store. The ordinal is identity-free — both
    // windows count the same user rows — and is also what the engine itself
    // rewinds by.
    const state = useSessionStore.getState()
    const pane = state.conversationPanes.get(engineContext?.tabId ?? tab.id)
    const inst = engineContext
      ? pane?.instances.find((i) => i.id === engineContext.instanceId)
      : activeInstance(state.conversationPanes, tab.id)
    const msgs = inst?.messages ?? []
    let userTurnIndex = -1
    for (const m of msgs) {
      if (m.role === 'user') userTurnIndex++
      if (m.id === message.id) break
    }
    // One transactional rewind implementation for every conversation. Plain
    // tabs have the same one active ConversationPane instance as extension
    // tabs; their identity is the stable MAIN_INSTANCE_ID sentinel.
    const targetTabId = engineContext?.tabId ?? tab.id
    const targetInstanceId = engineContext?.instanceId ?? MAIN_INSTANCE_ID
    void rewindEngineInstance(targetTabId, targetInstanceId, message.id, userTurnIndex >= 0 ? userTurnIndex : undefined)
      .then((result) => {
        if (!result.ok) {
          rError('conversation', 'rewind rejected by engine', { tab_id: targetTabId, error: result.error ?? 'unknown' })
        }
      })
      .catch((err) => rError('conversation', 'rewind failed', { error: String(err) }))
  }

  return (
    <div className="flex items-center gap-0.5">
      <CopyButton text={message.content} />
      {variant === 'user' && (
        <>
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            onClick={handleRewind}
            disabled={!isIdle}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] cursor-pointer flex-shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
            style={{
              background: confirmRewind ? colors.permissionDenyHoverBg : 'transparent',
              color: confirmRewind ? colors.dangerFg : colors.textTertiary,
              border: 'none',
            }}
            title="Rewind conversation to this message"
          >
            <ArrowCounterClockwise size={11} />
            <span>{confirmRewind ? 'Sure?' : 'Rewind'}</span>
          </motion.button>
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            onClick={() => { if (tab) void forkFromMessage(tab.id, message.id).catch((err) => rError('conversation', 'fork from message failed', { error: String(err) })) }}
            disabled={!tab}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] cursor-pointer flex-shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
            style={{
              background: 'transparent',
              color: colors.textTertiary,
              border: 'none',
            }}
            title="Fork conversation from this message"
          >
            <GitFork size={11} />
            <span>Fork</span>
          </motion.button>
        </>
      )}
    </div>
  )
}
