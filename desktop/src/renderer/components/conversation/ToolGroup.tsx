import React, { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { CaretRight, CaretDown, SpinnerGap, CheckCircle, Warning, XCircle } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { ToolIcon } from './ToolIcon'
import { ToolRow } from './ToolRow'
import { ToolImagesStrip } from './ToolImagesStrip'
import { getToolDescription, toolSummary, toolFailureSummary } from './tool-helpers'
import type { Message } from '../../../shared/types'

interface ToolGroupProps {
  tools: Message[]
  skipMotion?: boolean
  /**
   * When true, the group is hosted inside AgentTurnGroup, which already owns
   * the "Used N tools" collapse header, the expand/collapse state, and the
   * left timeline border. In embedded mode ToolGroup renders only the timeline
   * rail + tool rows (always open, no own header, no collapsed summary) so the
   * turn shows a single header instead of two stacked ones.
   */
  embedded?: boolean
}

export const ToolGroup = React.memo(function ToolGroup({ tools, skipMotion, embedded }: ToolGroupProps) {
  const hasRunning = tools.some((t) => t.toolStatus === 'running')
  const hasUserExecuted = tools.some((t) => t.userExecuted)
  const expandToolResults = usePreferencesStore((s) => s.expandToolResults)
  const hasExpandableTools = expandToolResults && tools.some((t) =>
    ['Edit', 'Write'].includes(t.toolName || '')
  )
  const [expanded, setExpanded] = useState(hasUserExecuted || hasExpandableTools)
  // Track whether the user has explicitly toggled this group, so we never
  // override their intent with auto-expand/collapse logic.
  const userToggledRef = useRef(false)
  const prevHasRunning = useRef(hasRunning)
  const colors = useColors()

  useEffect(() => {
    // Auto-expand when a run completes, but only when:
    // 1. expandToolResults is on, AND
    // 2. the user hasn't manually chosen a state for this group.
    if (prevHasRunning.current && !hasRunning && expandToolResults && !userToggledRef.current) {
      setExpanded(true)
    }
    prevHasRunning.current = hasRunning
  }, [hasRunning, expandToolResults])

  // When expandToolResults is OFF and the group hasn't been explicitly opened by
  // the user, keep it collapsed even while tools are running. A spinner badge on
  // the collapsed row signals that work is in progress without causing the
  // expand → add → collapse flash for every tool that fires in sequence.
  const forceOpen = expandToolResults && hasRunning && !userToggledRef.current
  // When embedded inside AgentTurnGroup the parent owns the collapse header and
  // only mounts this group when its own row is expanded, so the embedded group
  // is always open — it never renders its own header or collapsed summary.
  const isOpen = embedded || expanded || forceOpen

  const handleExpand = () => {
    userToggledRef.current = true
    setExpanded(true)
  }

  const handleCollapse = () => {
    userToggledRef.current = true
    setExpanded(false)
  }

  if (isOpen) {
    const inner = (
      <div className="py-1">
        {!embedded && !hasRunning && (
          <div
            className="flex items-center gap-1 cursor-pointer mb-1.5"
            data-ion-ui
            onClick={handleCollapse}
          >
            <CaretDown size={10} style={{ color: colors.textMuted }} />
            <span className="text-[11px]" style={{ color: colors.textMuted }}>
              Used {tools.length} tool{tools.length !== 1 ? 's' : ''}
            </span>
          </div>
        )}

        <div className="relative pl-6">
          <div
            className="absolute left-[10px] top-1 bottom-1 w-px"
            style={{ background: colors.timelineLine }}
          />

          <div className="space-y-1.5">
            {tools.map((tool) => {
              const running = tool.toolStatus === 'running'
              const toolName = tool.toolName || 'Tool'
              const desc = getToolDescription(toolName, tool.toolInput)

              return (
                <div key={tool.id} className="relative">
                  <div className="absolute -left-6 top-[5px] w-[20px] flex items-center justify-center">
                    {running
                      ? <SpinnerGap size={10} className="animate-spin" style={{ color: colors.statusRunning }} />
                      : <ToolIcon name={toolName} size={10} status={tool.toolStatus} />
                    }
                  </div>
                  <div className="min-w-0">
                    <ToolRow tool={tool} desc={desc} isRunning={running} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        {/* Tool images: always visible, outside the collapsible text rows. */}
        <ToolImagesStrip tools={tools} />
      </div>
    )

    if (skipMotion) return inner

    return (
      <motion.div
        key="expanded"
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        transition={{ duration: 0.15 }}
      >
        {inner}
      </motion.div>
    )
  }

  // Collapsed — show a spinner badge when any tool inside is still running so
  // the user knows something is happening even though the group is collapsed.
  // Lead with a `(N)` count badge when there are 2+ tools so the magnitude of
  // the collapsed group is obvious at a glance without having to expand it.
  //
  // Three-state status icon (rendered BEFORE the count badge):
  //   running   → spinner (existing treatment, suppresses failure suffix)
  //   mixed     → amber Warning  + ", M failed" suffix
  //   all-failed → red XCircle   + ", all failed" suffix
  //   all-ok    → green CheckCircle (no suffix)
  const summary = toolSummary(tools)
  const showCount = tools.length > 1
  const { failed, total, running: isRunning } = toolFailureSummary(tools)
  const settled = total - tools.filter((t) => t.toolStatus === 'running').length
  const isMixed = !isRunning && failed > 0 && failed < settled
  const isAllFailed = !isRunning && failed > 0 && failed === settled

  const failureSuffix = isMixed
    ? `, ${failed} failed`
    : isAllFailed
      ? ', all failed'
      : ''

  const statusIcon = isRunning
    ? null
    : isAllFailed
      ? <XCircle size={10} className="flex-shrink-0 mt-[2px]" style={{ color: colors.statusError }} />
      : isMixed
        ? <Warning size={10} className="flex-shrink-0 mt-[2px]" style={{ color: colors.statusWarning }} />
        : <CheckCircle size={10} className="flex-shrink-0 mt-[2px]" style={{ color: colors.statusComplete }} />

  const inner = (
    <div
      className="flex items-start gap-1 cursor-pointer py-[2px]"
      data-ion-ui
      onClick={handleExpand}
    >
      {isRunning
        ? <SpinnerGap size={10} className="animate-spin flex-shrink-0 mt-[2px]" style={{ color: colors.statusRunning }} />
        : <CaretRight size={10} className="flex-shrink-0 mt-[2px]" style={{ color: colors.textTertiary }} />
      }
      {statusIcon}
      {showCount && (
        <span
          className="text-[11px] leading-[1.4] tabular-nums flex-shrink-0"
          style={{ color: colors.textMuted }}
        >
          ({tools.length})
        </span>
      )}
      <span className="text-[11px] leading-[1.4]" style={{ color: isRunning ? colors.textSecondary : colors.textTertiary }}>
        {summary}{failureSuffix}
      </span>
    </div>
  )

  if (skipMotion) return (
    <div className="py-0.5">
      {inner}
      {/* Tool images stay visible even while the tool text is collapsed. */}
      <ToolImagesStrip tools={tools} />
    </div>
  )

  return (
    <motion.div
      key="collapsed"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.12 }}
      className="py-0.5"
    >
      {inner}
      {/* Tool images stay visible even while the tool text is collapsed. */}
      <ToolImagesStrip tools={tools} />
    </motion.div>
  )
})
