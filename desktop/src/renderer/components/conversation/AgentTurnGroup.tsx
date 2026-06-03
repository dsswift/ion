import React, { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CaretRight, CaretDown, SpinnerGap } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { ToolGroup } from './ToolGroup'
import { AssistantMessage } from './AssistantMessage'
import { CopyButton } from './CopyButton'
import type { Message } from '../../../shared/types'

const TASK_NOTIFICATION_RE = /<task-notification>[\s\S]*?<\/task-notification>\s*(?:Read the output file to retrieve the result:[^\n]*)?\n?/g

interface AgentTurnGroupProps {
  tools: Message[]
  assistantMessages: Message[]
  isActive: boolean
  skipMotion?: boolean
}

export function AgentTurnGroup({
  tools,
  assistantMessages,
  isActive,
  skipMotion,
}: AgentTurnGroupProps) {
  const colors = useColors()
  const expandToolResults = usePreferencesStore((s) => s.expandToolResults)
  const [expanded, setExpanded] = useState(false)

  const toolCount = tools.length

  // Concatenated assistant text for the copy button
  const concatenatedText = useMemo(() => {
    return assistantMessages
      .map((m) => (m.content || '').replace(TASK_NOTIFICATION_RE, '').trim())
      .filter(Boolean)
      .join('\n\n')
  }, [assistantMessages])

  const activityHeader = (
    <div
      className="flex items-center gap-1.5 cursor-pointer py-1 select-none"
      data-ion-ui
      onClick={() => setExpanded((v) => !v)}
    >
      {isActive ? (
        <SpinnerGap
          size={12}
          className="animate-spin flex-shrink-0"
          style={{ color: colors.statusRunning }}
        />
      ) : expanded ? (
        <CaretDown size={12} className="flex-shrink-0" style={{ color: colors.textMuted }} />
      ) : (
        <CaretRight size={12} className="flex-shrink-0" style={{ color: colors.textTertiary }} />
      )}
      <span
        className="text-[11px] leading-[1.4]"
        style={{ color: isActive ? colors.textSecondary : colors.textTertiary }}
      >
        {isActive
          ? `Running tools…`
          : `Used ${toolCount} tool${toolCount !== 1 ? 's' : ''}`}
      </span>
    </div>
  )

  const inner = (
    <div className="group/turn relative">
      {/* Collapsible activity panel */}
      {activityHeader}

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="tools-panel"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            style={{ overflow: 'hidden' }}
          >
            <div
              className="ml-1 pl-3 mb-1"
              style={{ borderLeft: `1px solid ${colors.timelineLine}` }}
            >
              <ToolGroup tools={tools} skipMotion />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Assistant text (always visible, rendered sequentially) */}
      {assistantMessages.length > 0 && (
        <div className="relative">
          {assistantMessages.map((msg) => (
            <AssistantMessage
              key={msg.id}
              message={msg}
              skipMotion={skipMotion}
              actions={<span />}
            />
          ))}
          {/* Unified copy button on hover over the turn block */}
          {concatenatedText && (
            <div className="absolute bottom-0 right-0 opacity-0 group-hover/turn:opacity-100 transition-opacity duration-100">
              <CopyButton text={concatenatedText} />
            </div>
          )}
        </div>
      )}
    </div>
  )

  if (skipMotion) return inner

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
    >
      {inner}
    </motion.div>
  )
}
