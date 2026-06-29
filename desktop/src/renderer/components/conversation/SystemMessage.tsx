import React, { useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import { useColors } from '../../theme'
import { CopyButton } from './CopyButton'
import { isPlanCreatedDivider, isPlanUpdatedDivider, isImplementDivider } from '../../../shared/clear-divider'
import { PlanViewer } from '../PlanViewer'
import type { Message } from '../../../shared/types'

interface SystemMessageProps {
  message: Message
  skipMotion?: boolean
}

export function SystemMessage({ message, skipMotion }: SystemMessageProps) {
  const content = message.content || ''
  const isError = content.startsWith('Error:') || content.includes('unexpectedly')
  // All session-boundary dividers (clear, implement, session-start, plan-created)
  // use the `──` prefix by convention — see clear-divider.ts. Detect generically
  // so new divider types render automatically without updating this component.
  const isDivider = content.startsWith('──')
  const colors = useColors()

  // Plan-created, plan-updated, and implement dividers carry a planFilePath so
  // the slug can be clickable (opens the plan preview). All three lifecycle
  // dividers refer to the same plan file; the only difference is the label.
  const hasPlanLink =
    isDivider &&
    (isPlanCreatedDivider(content) || isPlanUpdatedDivider(content) || isImplementDivider(content)) &&
    !!message.planFilePath
  const [planData, setPlanData] = useState<{ content: string; fileName: string; filePath: string } | null>(null)

  const handlePlanClick = useCallback(async () => {
    if (!message.planFilePath) return
    try {
      const result = await window.ion.readPlan(message.planFilePath)
      if (result.content && result.fileName) {
        setPlanData({ content: result.content, fileName: result.fileName, filePath: message.planFilePath! })
      }
    } catch (err) {
      console.warn('[SystemMessage] Failed to read plan file:', err)
    }
  }, [message.planFilePath])

  // Session-boundary divider: render as a full-width horizontal rule with
  // centered label, distinct from the normal system-message bubble. Signals
  // a structural break in the conversation (e.g. LLM context reset on /clear,
  // or plan-to-implement transition) rather than a chat turn or status message.
  if (isDivider) {
    // For plan-created dividers with a slug, split the content so we can
    // make the slug portion clickable (opens plan preview). The slug is
    // the text after the ` · ` separator before the closing ` ──`.
    let labelNode: React.ReactNode = content
    if (hasPlanLink && content.includes(' · ')) {
      const sepIdx = content.indexOf(' · ')
      const prefix = content.slice(0, sepIdx)
      // Strip trailing ` ──` from slug
      const rest = content.slice(sepIdx + 3)
      const slug = rest.endsWith(' ──') ? rest.slice(0, -3) : rest
      const suffix = rest.endsWith(' ──') ? ' ──' : ''
      labelNode = (
        <>
          {prefix}{' · '}
          <span
            style={{ textDecoration: 'underline', cursor: 'pointer' }}
            onClick={handlePlanClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') handlePlanClick() }}
          >
            {slug}
          </span>
          {suffix}
        </>
      )
    }

    const inner = (
      <div
        className="flex items-center w-full text-[11px] select-none"
        style={{ color: colors.textTertiary, userSelect: 'text' }}
        aria-label="Session lifecycle divider"
      >
        <div className="flex-1 h-px" style={{ background: colors.textTertiary, opacity: 0.4 }} />
        <span className="px-2 whitespace-nowrap">{labelNode}</span>
        <div className="flex-1 h-px" style={{ background: colors.textTertiary, opacity: 0.4 }} />
      </div>
    )

    const divider = skipMotion
      ? <div className="py-2">{inner}</div>
      : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15 }}
          className="py-2"
        >
          {inner}
        </motion.div>
      )

    return (
      <>
        {divider}
        {planData && (
          <PlanViewer
            content={planData.content}
            fileName={planData.fileName}
            filePath={planData.filePath}
            onClose={() => setPlanData(null)}
          />
        )}
      </>
    )
  }

  const inner = (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
      <div
        className="text-[11px] leading-[1.5] px-2.5 py-1 rounded-lg inline-block whitespace-pre-wrap"
        style={{
          background: isError ? colors.statusErrorBg : colors.surfaceHover,
          color: isError ? colors.statusError : colors.textTertiary,
          userSelect: 'text',
        }}
      >
        {content}
      </div>
      {isError && <CopyButton text={content} />}
    </div>
  )

  if (skipMotion) return <div className="py-0.5">{inner}</div>

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="py-0.5"
    >
      {inner}
    </motion.div>
  )
}
