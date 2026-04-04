import React, { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ShieldWarning, ShieldCheck, Terminal, ArrowSquareOut, RocketLaunch, ListChecks, Eye, Question } from '@phosphor-icons/react'
import { useColors, useThemeStore } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import { PlanViewer } from './PlanViewer'
import type { Message } from '../../shared/types'

interface Props {
  tools: Array<{ toolName: string; toolUseId: string }>
  tabId: string
  sessionId: string | null
  projectPath: string
  messages: Message[]
  onDismiss: () => void
  onImplement?: (clearContext: boolean) => void
  onAnswer?: (answer: string) => void
  onApprove?: (toolNames: string[]) => void
}

interface AskOption {
  label: string
  description?: string
}

interface AskData {
  question: string
  header?: string
  options: AskOption[]
}

export function PermissionDeniedCard({ tools, tabId, sessionId, projectPath, messages, onDismiss, onImplement, onAnswer, onApprove }: Props) {
  const colors = useColors()
  const showClearContext = useThemeStore((s) => s.showImplementClearContext)
  const allowSettingsEdits = useThemeStore((s) => s.allowSettingsEdits)
  const openCliInTerminal = useSessionStore((s) => s.openCliInTerminal)
  const [planData, setPlanData] = useState<{ content: string; fileName: string } | null>(null)

  // Extract planFilePath from ExitPlanMode input, or fall back to last Write to .claude/plans/
  const planFilePath = useMemo(() => {
    const exitMsg = [...messages].reverse().find((m) => m.toolName === 'ExitPlanMode' && m.toolInput)
    if (exitMsg?.toolInput) {
      try {
        const input = JSON.parse(exitMsg.toolInput)
        if (input.planFilePath) return input.planFilePath as string
      } catch {}
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.toolName === 'Write' && m.toolInput) {
        try {
          const input = JSON.parse(m.toolInput)
          const fp = input.file_path as string
          if (fp && /\/\.claude\/plans\/[^/]+\.md$/.test(fp)) return fp
        } catch {}
      }
    }
    return null
  }, [messages])

  const handleViewPlan = async () => {
    if (!planFilePath) return
    const result = await window.coda.readPlan(planFilePath)
    if (result.content && result.fileName) {
      setPlanData({ content: result.content, fileName: result.fileName })
    }
  }

  const handleOpenInCli = () => {
    if (sessionId) {
      openCliInTerminal(tabId, sessionId, projectPath)
    }
    onDismiss()
  }

  const toolNames = [...new Set(tools.map((t) => t.toolName))]
  const isPlanExit = toolNames.includes('ExitPlanMode')
  const isAskQuestion = !isPlanExit && toolNames.includes('AskUserQuestion')

  // Extract question data from the last AskUserQuestion message
  const askData = useMemo<AskData | null>(() => {
    if (!isAskQuestion) return null
    const askMsg = [...messages].reverse().find((m) => m.toolName === 'AskUserQuestion' && m.toolInput)
    if (!askMsg?.toolInput) return null
    try {
      const input = JSON.parse(askMsg.toolInput)
      const q = input.questions?.[0]
      if (!q?.question || !q?.options?.length) return null
      return { question: q.question, header: q.header, options: q.options }
    } catch { return null }
  }, [messages, isAskQuestion])

  // Extract context about what was denied (file path, command, etc.)
  const deniedContext = useMemo(() => {
    if (isPlanExit || isAskQuestion) return null
    const deniedIds = new Set(tools.map((t) => t.toolUseId))
    const deniedNames = new Set(tools.map((t) => t.toolName))
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (!m.toolInput) continue
      if ((m.toolId && deniedIds.has(m.toolId)) || (m.toolName && deniedNames.has(m.toolName))) {
        try {
          const input = JSON.parse(m.toolInput)
          if (input.file_path) return input.file_path as string
          if (input.command) return input.command as string
        } catch { /* ignore */ }
      }
    }
    return null
  }, [messages, tools, isPlanExit, isAskQuestion])

  // ─── ExitPlanMode: "Plan Ready" card ───

  if (isPlanExit && onImplement) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -4, scale: 0.97 }}
        transition={{ duration: 0.2 }}
        className="mx-4 mb-2"
      >
        <div
          style={{
            background: colors.containerBg,
            border: `1px solid ${colors.permissionAllowBorder}`,
            borderRadius: 14,
            boxShadow: `0 2px 12px rgba(34, 197, 94, 0.06)`,
          }}
          className="overflow-hidden"
        >
          {/* Header */}
          <div
            className="flex items-center gap-2 px-3 py-2"
            style={{
              background: colors.permissionAllowBg,
              borderBottom: `1px solid ${colors.permissionAllowBorder}`,
            }}
          >
            <ListChecks size={14} style={{ color: 'rgba(34, 197, 94, 0.85)' }} />
            <span className="text-[12px] font-semibold" style={{ color: 'rgba(34, 197, 94, 0.85)' }}>
              Plan Ready
            </span>
          </div>

          {/* Body */}
          <div className="px-3 py-2">
            <p className="text-[11px] leading-[1.5] mb-2" style={{ color: colors.textSecondary }}>
              Planning complete. Continue to implementation or keep chatting in plan mode.
            </p>

            {/* Actions */}
            <div className="flex gap-1.5 flex-wrap">
              {showClearContext && <button
                onClick={() => onImplement(true)}
                className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer flex items-center gap-1.5"
                style={{
                  background: colors.permissionAllowBg,
                  color: 'rgba(34, 197, 94, 0.85)',
                  border: `1px solid ${colors.permissionAllowBorder}`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = colors.permissionAllowHoverBg
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = colors.permissionAllowBg
                }}
              >
                <RocketLaunch size={12} />
                Implement, clear context
              </button>}
              <button
                onClick={() => onImplement(false)}
                className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer flex items-center gap-1.5"
                style={{
                  background: colors.permissionAllowBg,
                  color: 'rgba(34, 197, 94, 0.85)',
                  border: `1px solid ${colors.permissionAllowBorder}`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = colors.permissionAllowHoverBg
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = colors.permissionAllowBg
                }}
              >
                Implement
              </button>
              {planFilePath && <button
                onClick={handleViewPlan}
                className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer flex items-center gap-1.5"
                style={{
                  background: colors.surfaceHover,
                  color: colors.textTertiary,
                  border: `1px solid ${colors.surfaceSecondary}`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = colors.surfaceActive
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = colors.surfaceHover
                }}
              >
                <Eye size={12} />
                View Plan
              </button>}
            </div>
          </div>
        </div>
        <AnimatePresence>
          {planData && (
            <PlanViewer
              content={planData.content}
              fileName={planData.fileName}
              onClose={() => setPlanData(null)}
            />
          )}
        </AnimatePresence>
      </motion.div>
    )
  }

  // ─── AskUserQuestion: interactive question card ───

  if (isAskQuestion && askData && onAnswer) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -4, scale: 0.97 }}
        transition={{ duration: 0.2 }}
        className="mx-4 mb-2"
      >
        <div
          style={{
            background: colors.containerBg,
            border: `1px solid ${colors.infoBorder}`,
            borderRadius: 14,
            boxShadow: `0 2px 12px ${colors.infoShadow}`,
          }}
          className="overflow-hidden"
        >
          {/* Header */}
          <div
            className="flex items-center gap-2 px-3 py-2"
            style={{
              background: colors.infoBg,
              borderBottom: `1px solid ${colors.infoBorder}`,
            }}
          >
            <Question size={14} style={{ color: colors.infoText }} />
            <span className="text-[12px] font-semibold" style={{ color: colors.infoText }}>
              {askData.header || 'Input Required'}
            </span>
          </div>

          {/* Body */}
          <div className="px-3 py-2">
            <p className="text-[11px] leading-[1.5] mb-2" style={{ color: colors.textSecondary }}>
              {askData.question}
            </p>

            {/* Option buttons */}
            <div className="flex gap-1.5 flex-wrap">
              {askData.options.map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => onAnswer(opt.label)}
                  className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer"
                  style={{
                    background: colors.infoBg,
                    color: colors.infoText,
                    border: `1px solid ${colors.infoBorder}`,
                  }}
                  title={opt.description || undefined}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = colors.infoHoverBg
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = colors.infoBg
                  }}
                >
                  {opt.label}
                </button>
              ))}
              <button
                onClick={onDismiss}
                className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer"
                style={{
                  background: colors.surfaceHover,
                  color: colors.textTertiary,
                  border: `1px solid ${colors.surfaceSecondary}`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = colors.surfaceActive
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = colors.surfaceHover
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    )
  }

  // ─── Interactive approval card (when allowSettingsEdits is on) ───

  if (allowSettingsEdits && onApprove && !isPlanExit && !isAskQuestion) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -4, scale: 0.97 }}
        transition={{ duration: 0.2 }}
        className="mx-4 mb-2"
      >
        <div
          style={{
            background: colors.containerBg,
            border: `1px solid ${colors.infoBorder}`,
            borderRadius: 14,
            boxShadow: `0 2px 12px ${colors.infoShadow}`,
          }}
          className="overflow-hidden"
        >
          {/* Header */}
          <div
            className="flex items-center gap-2 px-3 py-2"
            style={{
              background: colors.infoBg,
              borderBottom: `1px solid ${colors.infoBorder}`,
            }}
          >
            <ShieldCheck size={14} style={{ color: colors.infoText }} />
            <span className="text-[12px] font-semibold" style={{ color: colors.infoText }}>
              Permission Required
            </span>
          </div>

          {/* Body */}
          <div className="px-3 py-2">
            <p className="text-[11px] leading-[1.5] mb-1" style={{ color: colors.textSecondary }}>
              The agent needs permission to use{' '}
              <span style={{ color: colors.textPrimary, fontWeight: 500 }}>{toolNames.join(', ')}</span>.
            </p>
            {deniedContext && (
              <p
                className="text-[10px] font-mono leading-[1.4] mb-2 px-2 py-1 rounded-md"
                style={{
                  background: colors.surfacePrimary,
                  color: colors.textTertiary,
                  border: `1px solid ${colors.surfaceSecondary}`,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {deniedContext}
              </p>
            )}

            {/* Actions */}
            <div className="flex gap-1.5">
              <button
                onClick={() => onApprove(toolNames)}
                className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer flex items-center gap-1.5"
                style={{
                  background: colors.permissionAllowBg,
                  color: 'rgba(34, 197, 94, 0.85)',
                  border: `1px solid ${colors.permissionAllowBorder}`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = colors.permissionAllowHoverBg
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = colors.permissionAllowBg
                }}
              >
                <ShieldCheck size={12} />
                Approve
              </button>
              <button
                onClick={onDismiss}
                className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer"
                style={{
                  background: colors.surfaceHover,
                  color: colors.textTertiary,
                  border: `1px solid ${colors.permissionDeniedBorder}`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = colors.surfaceActive
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = colors.surfaceHover
                }}
              >
                Block
              </button>
              {sessionId && (
                <button
                  onClick={handleOpenInCli}
                  className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer flex items-center gap-1.5"
                  style={{
                    background: colors.surfaceHover,
                    color: colors.textTertiary,
                    border: `1px solid ${colors.surfaceSecondary}`,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = colors.surfaceActive
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = colors.surfaceHover
                  }}
                >
                  <ArrowSquareOut size={12} />
                  Open in CLI
                </button>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    )
  }

  // ─── Generic: "Tools Denied" error card ───

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.97 }}
      transition={{ duration: 0.2 }}
      className="mx-4 mb-2"
    >
      <div
        style={{
          background: colors.containerBg,
          border: `1px solid ${colors.permissionDeniedBorder}`,
          borderRadius: 14,
          boxShadow: `0 2px 12px ${colors.statusErrorBg}`,
        }}
        className="overflow-hidden"
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{
            background: colors.statusErrorBg,
            borderBottom: `1px solid ${colors.permissionDeniedHeaderBorder}`,
          }}
        >
          <ShieldWarning size={14} style={{ color: colors.statusError }} />
          <span className="text-[12px] font-semibold" style={{ color: colors.statusError }}>
            Tools Denied by Permission Settings
          </span>
        </div>

        {/* Body */}
        <div className="px-3 py-2">
          <p className="text-[11px] leading-[1.5] mb-2" style={{ color: colors.textSecondary }}>
            Interactive approvals are not supported in the current CLI mode.
            {toolNames.length > 0 && (
              <> Denied: <span style={{ color: colors.textPrimary }}>{toolNames.join(', ')}</span>.</>
            )}
          </p>

          {/* Tool list */}
          {tools.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {toolNames.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-md"
                  style={{
                    background: colors.surfacePrimary,
                    color: colors.textTertiary,
                    border: `1px solid ${colors.surfaceSecondary}`,
                  }}
                >
                  <Terminal size={10} />
                  {name}
                </span>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-1.5">
            {sessionId && (
              <button
                onClick={handleOpenInCli}
                className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer flex items-center gap-1.5"
                style={{
                  background: colors.accentLight,
                  color: colors.accent,
                  border: `1px solid ${colors.accentBorderMedium}`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = colors.accentSoft
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = colors.accentLight
                }}
              >
                <ArrowSquareOut size={12} />
                Open in CLI
              </button>
            )}
            <button
              onClick={onDismiss}
              className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer"
              style={{
                background: colors.surfaceHover,
                color: colors.textTertiary,
                border: `1px solid ${colors.surfaceSecondary}`,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = colors.surfaceActive
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = colors.surfaceHover
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
