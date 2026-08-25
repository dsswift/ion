import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Question, X } from '@phosphor-icons/react'
import { usePopoverLayer } from '../PopoverLayer'
import { useColors } from '../../theme'
import { useSessionStore } from '../../stores/sessionStore'
import { useQuestionsStore, openWorkflowsForTab } from '../../stores/questions-store'
import { QuestionsWizard } from './QuestionsWizard'

/**
 * Overlay host for the guided-questions wizard: a compact question-colored
 * card pinned above the input area for the ACTIVE conversation, expanding
 * into a large centered modal on click. Mounted once from App.tsx —
 * deliberately outside the shared ConversationView so the Studio shell's
 * center-mounted ConversationView never double-renders it (Studio mounts the
 * same QuestionsWizard through its own QuestionsSurface).
 *
 * Closing the modal only closes this presentation: the draft and the active
 * call survive (the engine wait is indefinite), and the card remains as the
 * re-entry point. Cancelling the workflow is an explicit wizard action, not
 * a modal dismissal.
 */
export function QuestionsOverlayHost(): React.JSX.Element | null {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const workflows = useQuestionsStore((s) => s.workflows)
  const [modalOpen, setModalOpen] = useState(false)

  const open = activeTabId ? openWorkflowsForTab(workflows, activeTabId) : []
  const current = open[0]
  if (!current) return null

  return (
    <>
      <AnimatePresence>
        <motion.div
          key={current.workflowId}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2 }}
          className="mx-4 mb-2"
        >
          <button
            onClick={() => setModalOpen(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-[14px] text-left cursor-pointer transition-colors"
            style={{
              background: colors.infoBg,
              border: `1px solid ${colors.infoBorder}`,
              boxShadow: `0 2px 12px ${colors.infoShadow}`,
            }}
          >
            <Question size={14} style={{ color: colors.infoText }} />
            <span className="flex-1 text-[12px] font-semibold truncate" style={{ color: colors.infoText }}>
              {current.request.title}
            </span>
            <span className="text-[11px]" style={{ color: colors.infoText }}>
              {current.phase === 'submitting' || current.phase === 'awaiting_next'
                ? 'Working…'
                : `${current.request.questions.length} question${current.request.questions.length === 1 ? '' : 's'} — answer`}
            </span>
            {open.length > 1 && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full"
                style={{ background: colors.infoText, color: colors.containerBg }}
              >
                +{open.length - 1}
              </span>
            )}
          </button>
        </motion.div>
      </AnimatePresence>
      {modalOpen && popoverLayer && createPortal(
        <div
          className="fixed inset-0 flex items-center justify-center"
          // PopoverLayer is pointerEvents:'none'; an interactive child must
          // opt back in or every click passes through to the page beneath.
          // scrim is the themed modal-backdrop token; never a literal, so a
          // theme pack controls the dim like every other surface.
          style={{ pointerEvents: 'auto', background: colors.scrim, zIndex: 60 }}
          onClick={() => setModalOpen(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className="w-[560px] max-w-[92vw] max-h-[80vh] overflow-y-auto rounded-[16px]"
            style={{
              background: colors.containerBg,
              border: `1px solid ${colors.infoBorder}`,
              boxShadow: `0 8px 40px ${colors.infoShadow}`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-center gap-2 px-4 py-2.5 sticky top-0"
              style={{ background: colors.infoBg, borderBottom: `1px solid ${colors.infoBorder}` }}
            >
              <Question size={15} style={{ color: colors.infoText }} />
              <span className="flex-1 text-[13px] font-semibold" style={{ color: colors.infoText }}>
                {current.request.title}
              </span>
              <button
                onClick={() => setModalOpen(false)}
                className="cursor-pointer rounded-md p-0.5 transition-colors"
                style={{ color: colors.infoText }}
                aria-label="Close (keeps your draft)"
              >
                <X size={14} />
              </button>
            </div>
            <QuestionsWizard workflow={current} />
          </motion.div>
        </div>,
        popoverLayer,
      )}
    </>
  )
}
