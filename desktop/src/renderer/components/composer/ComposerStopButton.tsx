/**
 * ComposerStopButton — stops the active conversation's run from the composer.
 *
 * It sits beside the send button so that while a run is in flight the operator
 * has both choices in one place: queue another message, or stop. It stops the
 * orchestrator run only; the conversation view's interrupt row remains the
 * place that also offers "stop all work" for child agents and background tasks.
 */
import React from 'react'
import { Stop } from '@phosphor-icons/react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { useColors } from '../../theme'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { Tooltip } from '../git/Tooltip'
import { rInfo } from '../../rendererLogger'

export function ComposerStopButton(): React.JSX.Element | null {
  const colors = useColors()
  const state = useInteractiveState()
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const running = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.status === 'running')
  const interrupt = useSessionStore((s) => s.interrupt)

  if (!running || !activeTabId) return null

  return (
    <Tooltip text="Stop">
      <button
        type="button"
        aria-label="Stop"
        data-testid="composer-stop-button"
        {...state.handlers}
        // Keep the editor focused: the operator usually types right after.
        onMouseDown={(e) => { e.preventDefault(); state.handlers.onMouseDown() }}
        onClick={() => {
          rInfo('composer', 'stop requested from composer', { tab_id: activeTabId })
          interrupt(activeTabId, 'orchestrator')
        }}
        className="ion-focusable w-9 h-9 rounded-full flex items-center justify-center"
        style={{
          color: colors.dangerFg,
          background: interactiveBg(colors, state),
          border: `1px solid ${colors.containerBorder}`,
        }}
      >
        <Stop size={14} weight="fill" />
      </button>
    </Tooltip>
  )
}
