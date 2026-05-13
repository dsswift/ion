import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { CaretRight, CaretDown, ArrowsInSimple } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import type { Message } from '../../../shared/types'

interface CompactionRowProps {
  message: Message
  skipMotion?: boolean
}

/**
 * Parses the structured [Compaction] system message content.
 * Format: "[Compaction] · strategy · N → M messages · K blocks cleared\n\nSummary..."
 */
function parseCompaction(content: string): { headline: string; summary: string } {
  const lines = content.split('\n\n')
  const headline = (lines[0] || '').replace(/^\[Compaction\]\s*/, '').trim()
  const summary = lines.slice(1).join('\n\n').trim()
  return { headline, summary }
}

/**
 * Renders a compaction summary section (## heading with bullet items).
 */
function SummarySection({ text }: { text: string }) {
  const colors = useColors()
  const sections = text.split(/^## /m).filter(Boolean)

  return (
    <div className="space-y-2">
      {sections.map((section, i) => {
        const [title, ...items] = section.split('\n').filter(Boolean)
        return (
          <div key={i}>
            <div className="text-[10px] font-medium uppercase tracking-wide mb-0.5" style={{ color: colors.infoText }}>
              {title}
            </div>
            <div className="space-y-0.5">
              {items.map((item, j) => (
                <div key={j} className="text-[11px] leading-[1.4]" style={{ color: colors.textTertiary }}>
                  {item}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function CompactionRow({ message, skipMotion }: CompactionRowProps) {
  const [expanded, setExpanded] = useState(false)
  const colors = useColors()
  const { headline, summary } = parseCompaction(message.content || '')

  const ts = message.timestamp
    ? new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : ''

  if (expanded) {
    const inner = (
      <div className="py-1">
        <div
          className="flex items-center gap-1.5 cursor-pointer mb-1.5"
          data-ion-ui
          onClick={() => setExpanded(false)}
        >
          <CaretDown size={10} style={{ color: colors.infoText }} />
          <ArrowsInSimple size={11} style={{ color: colors.infoText }} />
          <span className="text-[11px] font-medium" style={{ color: colors.infoText }}>
            Context compacted
          </span>
          {headline && (
            <span className="text-[10px]" style={{ color: colors.textTertiary }}>
              — {headline}
            </span>
          )}
          {ts && (
            <span className="text-[10px] ml-auto" style={{ color: colors.textMuted }}>
              {ts}
            </span>
          )}
        </div>
        <div
          className="ml-4 pl-3 py-2 rounded"
          style={{
            background: colors.statusCompactingBg,
            borderLeft: `2px solid ${colors.statusCompacting}`,
          }}
        >
          {summary ? (
            <SummarySection text={summary} />
          ) : (
            <span className="text-[11px]" style={{ color: colors.textTertiary }}>
              Older context was compacted to free up space.
            </span>
          )}
        </div>
      </div>
    )

    if (skipMotion) return inner

    return (
      <motion.div
        key="compaction-expanded"
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        transition={{ duration: 0.15 }}
      >
        {inner}
      </motion.div>
    )
  }

  // Collapsed view
  const inner = (
    <div
      className="flex items-center gap-1.5 cursor-pointer py-[2px]"
      data-ion-ui
      onClick={() => setExpanded(true)}
    >
      <CaretRight size={10} style={{ color: colors.infoText }} />
      <ArrowsInSimple size={11} style={{ color: colors.infoText }} />
      <span className="text-[11px]" style={{ color: colors.infoText }}>
        Context compacted
      </span>
      {headline && (
        <span className="text-[10px]" style={{ color: colors.textTertiary }}>
          — {headline}
        </span>
      )}
      {ts && (
        <span className="text-[10px] ml-auto" style={{ color: colors.textMuted }}>
          {ts}
        </span>
      )}
    </div>
  )

  if (skipMotion) return <div className="py-0.5">{inner}</div>

  return (
    <motion.div
      key="compaction-collapsed"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.12 }}
      className="py-0.5"
    >
      {inner}
    </motion.div>
  )
}
