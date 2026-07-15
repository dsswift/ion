import React, { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CaretRight, CaretDown, SpinnerGap, CheckCircle, Warning, XCircle } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { ToolGroup } from './ToolGroup'
import { ToolImagesStrip } from './ToolImagesStrip'
import { AssistantMessage } from './AssistantMessage'
import { ThinkingBlock } from './ThinkingBlock'
import { CopyButton } from './CopyButton'
import { toolFailureSummary } from './tool-helpers'
import type { Message } from '../../../shared/types'

const TASK_NOTIFICATION_RE = /<task-notification>[\s\S]*?<\/task-notification>\s*(?:Read the output file to retrieve the result:[^\n]*)?\n?/g

interface AgentTurnGroupProps {
  tools: Message[]
  assistantMessages: Message[]
  isActive: boolean
  /**
   * Optional extended-thinking row for this turn (issue #158). Rendered as
   * the turn's top group, ABOVE the collapsible tool row. undefined when
   * the model did not reason this turn (the common case).
   */
  thinking?: Message
  skipMotion?: boolean
}

export const AgentTurnGroup = React.memo(function AgentTurnGroup({
  tools,
  assistantMessages,
  isActive,
  thinking,
  skipMotion,
}: AgentTurnGroupProps) {
  const colors = useColors()
  const expandToolResults = usePreferencesStore((s) => s.expandToolResults)
  const [expanded, setExpanded] = useState(false)

  const toolCount = tools.length

  // Failure summary for the activity header three-state icon (only when !isActive).
  const { failed, total, running: hasRunningTool } = toolFailureSummary(tools)
  const settled = total - tools.filter((t) => t.toolStatus === 'running').length
  const isMixed = !isActive && !hasRunningTool && failed > 0 && failed < settled
  const isAllFailed = !isActive && !hasRunningTool && failed > 0 && failed === settled

  const headerFailureSuffix = isMixed
    ? ` (${failed} failed)`
    : isAllFailed
      ? ' (all failed)'
      : ''

  const headerStatusIcon = isActive
    ? null
    : isAllFailed
      ? <XCircle size={12} className="flex-shrink-0" style={{ color: colors.statusError }} />
      : isMixed
        ? <Warning size={12} className="flex-shrink-0" style={{ color: colors.statusWarning }} />
        : <CheckCircle size={12} className="flex-shrink-0" style={{ color: colors.statusComplete }} />

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
      {headerStatusIcon}
      <span
        className="text-[11px] leading-[1.4]"
        style={{ color: isActive ? colors.textSecondary : colors.textTertiary }}
      >
        {isActive
          ? `Running tools…`
          : `Used ${toolCount} tool${toolCount !== 1 ? 's' : ''}${headerFailureSuffix}`}
      </span>
    </div>
  )

  const inner = (
    <div className="group/turn relative">
      {/* Extended-thinking row — top of the turn, above assistant text. */}
      {thinking && <ThinkingBlock message={thinking} skipMotion={skipMotion} />}

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

      {/* Collapsible activity panel — rendered below assistant text */}
      {activityHeader}

      {/* Tool images: always visible, hoisted OUT of the collapsible tool
          panel below. A tool-generated image (icon, logo, screenshot, diagram)
          is a visual deliverable, not collapsible tool text, so it must paint
          whether or not the user expands "Used N tools". Without this the
          #224 conversation's 20 images stayed buried behind the collapsed
          panel and never rendered. See ToolImagesStrip. */}
      <ToolImagesStrip tools={tools} />

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
              <ToolGroup tools={tools} skipMotion embedded />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
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
})
