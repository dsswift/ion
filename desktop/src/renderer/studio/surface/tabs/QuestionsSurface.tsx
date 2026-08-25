import React from 'react'
import { useColors } from '../../../theme'
import { useSessionStore } from '../../../stores/sessionStore'
import { useQuestionsStore, openWorkflowsForTab } from '../../../stores/questions-store'
import { QuestionsWizard } from '../../../components/questions/QuestionsWizard'

/**
 * QuestionsSurface — the Studio Canvas host for the guided-questions wizard.
 * A thin shell over the SAME QuestionsWizard body the Overlay modal mounts
 * (parity by construction: one component, one window-local cache). Keys off
 * the mirrored active conversation; the surface synchronizer guarantees this
 * only mounts while that conversation has an open workflow, but the
 * empty-state guard keeps a race from rendering a blank hole.
 */
export function QuestionsSurface(): React.JSX.Element {
  const colors = useColors()
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const workflows = useQuestionsStore((s) => s.workflows)
  const open = activeTabId ? openWorkflowsForTab(workflows, activeTabId) : []
  const current = open[0]

  if (!current) {
    return (
      <div
        style={{
          flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: colors.textTertiary, fontSize: 12, fontFamily: 'system-ui, sans-serif',
        }}
      >
        No questions waiting.
      </div>
    )
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div className="px-4 pt-3">
        <p className="text-[14px] font-semibold" style={{ color: colors.textPrimary }}>
          {current.request.title}
        </p>
        {open.length > 1 && (
          <p className="text-[11px] mt-0.5" style={{ color: colors.textTertiary }}>
            {open.length - 1} more question round{open.length === 2 ? '' : 's'} queued after this one.
          </p>
        )}
      </div>
      <QuestionsWizard workflow={current} />
    </div>
  )
}
