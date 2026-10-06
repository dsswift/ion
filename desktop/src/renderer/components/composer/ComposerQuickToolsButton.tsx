/**
 * ComposerQuickToolsButton — the lightning button beside the composer's `+`.
 *
 * It renders only when at least one Quick Tool applies to the active
 * conversation, so an operator with no tools never sees a dead control. It
 * also owns the trust dialog for Project Quick Tools, because the tray closes
 * on any outside click and the dialog has to outlive it.
 */
import React, { useEffect, useRef, useState } from 'react'
import { Lightning } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { Tooltip } from '../git/Tooltip'
import { QuickToolsTray } from '../QuickToolsTray'
import { useActiveQuickTools } from './useActiveQuickTools'
import { useActiveTerminalAccess } from '../../studio/connection/terminal-access'
import { COMPOSER_QUICK_TOOLS_EVENT } from './composer-events'
import { useSessionStore } from '@ion/server/store/sessionStore'
import type { ProjectQuickTool } from '@ion/shared/project-studio-config'
import { ConfirmDialog } from '../git/ConfirmDialog'
import { rError, rInfo } from '../../rendererLogger'
import { projectToolsTrustMessage, runProjectQuickTool, trustThenRunProjectQuickTool } from './project-quick-tool-run'

export function ComposerQuickToolsButton(): React.JSX.Element | null {
  const colors = useColors()
  const { user, project, projectTrusted, projectToolsHash, projectDirectory } = useActiveQuickTools()
  const activeTabId = useSessionStore((st) => st.activeTabId)
  // A project tool chosen before the project's tools were trusted. It runs
  // only if the operator approves the list; every other outcome drops it.
  const [pendingTool, setPendingTool] = useState<ProjectQuickTool | null>(null)
  // A Quick Tool runs a shell command on the server, which refuses it without terminal access.
  const terminalAccess = useActiveTerminalAccess()
  const hasTools = terminalAccess && user.length + project.length > 0
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const state = useInteractiveState()

  useEffect(() => {
    if (!hasTools) return
    const toggle = (): void => setOpen((o) => !o)
    window.addEventListener(COMPOSER_QUICK_TOOLS_EVENT, toggle)
    return () => window.removeEventListener(COMPOSER_QUICK_TOOLS_EVENT, toggle)
  }, [hasTools])

  if (!hasTools) return null

  return (
    <>
      <Tooltip text="Quick Tools">
        <button
          ref={buttonRef}
          type="button"
          aria-label="Quick Tools"
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid="composer-quick-tools-button"
          {...state.handlers}
          onClick={() => setOpen((o) => !o)}
          className="flex items-center justify-center rounded-full ion-focusable"
          style={{
            width: 24,
            height: 24,
            color: open ? colors.accent : colors.textSecondary,
            background: interactiveBg(colors, { ...state, selected: open }),
            border: `1px solid ${colors.containerBorder}`,
          }}
        >
          <Lightning size={13} weight="fill" />
        </button>
      </Tooltip>
      {open && (
        <QuickToolsTray
          anchorRef={buttonRef}
          onClose={() => setOpen(false)}
          onProjectTool={(tool) => {
            if (!activeTabId) return
            if (projectTrusted) runProjectQuickTool(activeTabId, tool)
            else setPendingTool(tool)
          }}
        />
      )}
      {pendingTool && activeTabId && (
        <ConfirmDialog
          title="Trust this project's Quick Tools?"
          message={projectToolsTrustMessage(project)}
          confirmLabel={`Trust and run "${pendingTool.name}"`}
          cancelLabel="Not now"
          initialFocus="cancel"
          danger
          onConfirm={() => {
            const tool = pendingTool
            setPendingTool(null)
            void trustThenRunProjectQuickTool(activeTabId, projectDirectory, projectToolsHash, tool)
              .catch((err) => rError('composer', 'trusting project quick tools failed', { error: String(err) }))
          }}
          onCancel={() => {
            rInfo('composer', 'operator declined to trust project quick tools', { directory: projectDirectory })
            setPendingTool(null)
          }}
        />
      )}
    </>
  )
}
