import React, { useState, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ShieldWarning, Terminal, ListChecks, Eye } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { PlanViewer } from './PlanViewer'
import { surfaceRouter } from '../lib/file-open-router'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { AskQuestionCard } from './AskQuestionCard'
import type { AskData, AskOption } from './AskQuestionCard'
import type { Message } from '@ion/shared/types'
import { rDebug, rError } from '../rendererLogger'
import { host } from '../host/host-instance'

interface Props {
  tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }>
  tabId: string
  sessionId: string | null
  projectPath: string
  messages: Message[]
  tabPlanFilePath?: string | null
  onDismiss: () => void
  /**
   * Called when the user clicks Implement (or "Implement, clear context").
   * `clearContext` defaults to false — the regular Implement button
   * preserves the engine conversation across the plan→implement boundary.
   * When `clearContext = true`, the handler runs the reset-and-archive
   * path. See implementPlan in implement-slice.ts.
   */
  onImplement?: (clearContext?: boolean) => void
  onAnswer?: (answer: string) => void
}

export function PermissionDeniedCard({ tools, tabId, sessionId: _sessionId, projectPath: _projectPath, messages, tabPlanFilePath, onDismiss, onImplement, onAnswer }: Props) {
  const colors = useColors()
  // Reveals the secondary "Implement, clear context" action on the
  // plan-approval card. Default off — only users who explicitly want
  // per-plan opt-in to a fresh conversation enable this. See
  // preferences-types.ts for the field comment.
  const showImplementClearContext = usePreferencesStore((s) => s.showImplementClearContext)
  const [planData, setPlanData] = useState<{ content: string; fileName: string; filePath: string } | null>(null)
  const closePlan = useCallback(() => setPlanData(null), [])

  // Extract planFilePath: tab state (from engine event), denial toolInput, messages
  const planFilePath = useMemo(() => {
    // Primary: tab-level planFilePath set by engine_plan_mode_changed event
    if (tabPlanFilePath) return tabPlanFilePath

    // Fallback: check denial toolInput (engine API path)
    const exitDenial = tools.find((t) => t.toolName === 'ExitPlanMode' && t.toolInput)
    if (exitDenial?.toolInput?.planFilePath) return exitDenial.toolInput.planFilePath as string

    // Fallback: ExitPlanMode message toolInput (CLI path)
    const exitMsg = [...messages].reverse().find((m) => m.toolName === 'ExitPlanMode' && m.toolInput)
    if (exitMsg?.toolInput) {
      try {
        const input = JSON.parse(exitMsg.toolInput)
        if (input.planFilePath) return input.planFilePath as string
      } catch (err) {
        rDebug('permission-denied-card', 'ExitPlanMode toolInput parse failed', { error: String(err) })
      }
    }
    // Fallback: last Write to .ion/plans/*.md
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.toolName === 'Write' && m.toolInput) {
        try {
          const input = JSON.parse(m.toolInput)
          const fp = input.file_path as string
          if (fp && /\/\.ion\/plans\/[^/]+\.md$/.test(fp)) return fp
        } catch (err) {
          rDebug('permission-denied-card', 'Write toolInput parse failed', { error: String(err) })
        }
      }
    }
    return null
  }, [tabPlanFilePath, messages, tools])

  const handleViewPlan = async () => {
    if (!planFilePath) return
    // Studio: plan opens as a surface editor tab (unclipped, markdown
    // preview default); overlay: the floating PlanViewer.
    const router = surfaceRouter()
    if (router) {
      const st = useSessionStore.getState()
      const tab = st.tabs.find((t) => t.id === tabId)
      if (tab) {
        if (router.openPlan) router.openPlan(tab.workingDirectory, tab.id, planFilePath)
        else router.openTextFile(tab.workingDirectory, tab.id, planFilePath)
        return
      }
    }
    const result = await host.shell.readPlan(planFilePath)
    if (result.content && result.fileName) {
      setPlanData({ content: result.content, fileName: result.fileName, filePath: planFilePath })
    }
  }

  const toolNames = [...new Set(tools.map((t) => t.toolName))]
  const isPlanExit = toolNames.includes('ExitPlanMode')
  const isAskQuestion = !isPlanExit && toolNames.includes('AskUserQuestion')

  // Extract question data from the AskUserQuestion denial.
  // Primary source: tools[].toolInput (always present — set directly from the
  // engine's PermissionDenial which carries block.Input). The message-scan
  // fallback is kept for safety but will almost never fire because the engine
  // intercepts AskUserQuestion before emitting engine_tool_start, so no
  // role:'tool' message ever lands in tab.messages for this tool.
  const askData = useMemo<AskData | null>(() => {
    if (!isAskQuestion) return null

    // Primary: read from the denial record itself
    const denial = tools.find((t) => t.toolName === 'AskUserQuestion' && t.toolInput)
    const rawInput: Record<string, unknown> | null = denial?.toolInput ?? null

    // Fallback: scan messages (handles old persisted sessions)
    const fallbackInput: Record<string, unknown> | null = (() => {
      const askMsg = [...messages].reverse().find((m) => m.toolName === 'AskUserQuestion' && m.toolInput)
      if (!askMsg?.toolInput) return null
      try { return JSON.parse(askMsg.toolInput) } catch { return null }
    })()

    const input = rawInput ?? fallbackInput
    if (!input?.question) return null

    const opts: AskOption[] = Array.isArray(input.options)
      ? (input.options as (string | AskOption)[]).map((o) => typeof o === 'string' ? { label: o } : o)
      : []
    return { question: input.question as string, header: input.header as string | undefined, options: opts }
  }, [tools, messages, isAskQuestion])

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
            boxShadow: `0 2px 12px ${colors.permissionAllowBg}`,
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
            <ListChecks size={14} style={{ color: colors.successFg }} />
            <span className="text-[12px] font-semibold" style={{ color: colors.successFg }}>
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
              <button
                onClick={() => onImplement()}
                className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer flex items-center gap-1.5"
                style={{
                  background: colors.permissionAllowBg,
                  color: colors.successFg,
                  border: `1px solid ${colors.permissionAllowBorder}`,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = colors.permissionAllowHoverBg }}
                onMouseLeave={(e) => { e.currentTarget.style.background = colors.permissionAllowBg }}
              >
                Implement
              </button>
              {showImplementClearContext && (
                <button
                  onClick={() => onImplement(true)}
                  title="Start a fresh conversation for the implementation phase — the model will not see the planning conversation."
                  className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer flex items-center gap-1.5"
                  style={{
                    background: colors.surfaceHover,
                    color: colors.textTertiary,
                    border: `1px solid ${colors.surfaceSecondary}`,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = colors.surfaceActive }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = colors.surfaceHover }}
                >
                  Implement, clear context
                </button>
              )}
              {planFilePath && <button
                onClick={() => { void handleViewPlan().catch((err) => rError('permission-denied-card', 'view plan failed', { error: String(err) })) }}
                className="text-[11px] font-medium px-3 py-1.5 rounded-full transition-colors cursor-pointer flex items-center gap-1.5"
                style={{
                  background: colors.surfaceHover,
                  color: colors.textTertiary,
                  border: `1px solid ${colors.surfaceSecondary}`,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = colors.surfaceActive }}
                onMouseLeave={(e) => { e.currentTarget.style.background = colors.surfaceHover }}
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
              onClose={closePlan}
            />
          )}
        </AnimatePresence>
      </motion.div>
    )
  }

  // ─── AskUserQuestion: interactive question card ───

  if (isAskQuestion && askData && onAnswer) {
    return (
      <AskQuestionCard
        askData={askData}
        onAnswer={onAnswer}
        onDismiss={onDismiss}
        colors={colors}
      />
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

// AskQuestionCard is in ./AskQuestionCard.tsx — extracted to stay under the
// 600-line file-size cap. It owns the AskData/AskOption types too.
