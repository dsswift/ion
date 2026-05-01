import React, { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowCounterClockwise, GitFork } from '@phosphor-icons/react'
import { useSessionStore } from '../../stores/sessionStore'
import { useColors } from '../../theme'
import { CopyButton } from './CopyButton'
import type { Message } from '../../../shared/types'

/** Hover overlay actions (copy / rewind / fork) for a user or assistant message. */
export function MessageActions({ message, variant }: { message: Message; variant: 'user' | 'assistant' }) {
  const colors = useColors()
  const tab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const rewindToMessage = useSessionStore((s) => s.rewindToMessage)
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
    rewindToMessage(tab.id, message.id)
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
              background: confirmRewind ? 'rgba(239, 68, 68, 0.15)' : 'transparent',
              color: confirmRewind ? '#ef4444' : colors.textTertiary,
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
            onClick={() => tab && forkFromMessage(tab.id, message.id)}
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
