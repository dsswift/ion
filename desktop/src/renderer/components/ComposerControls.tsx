import React from 'react'
import { ContextIndicator } from './StatusBarContextIndicator'
import { ModelPicker } from './StatusBarModelPicker'
import { PermissionModePicker } from './StatusBarPermissionModePicker'
import { ThinkingPicker } from './StatusBarThinkingPicker'
import { AttachmentsButton } from './StatusBarAttachmentsButton'
import { StatusBarEngineState } from './StatusBarEngineState'
import { ComposerPlusMenu } from './composer/ComposerPlusMenu'
import { useComposerActions } from './composer/useComposerActions'
import { ComposerQuickToolsButton } from './composer/ComposerQuickToolsButton'
import { ComposerCollapsedPickers } from './composer/ComposerCollapsedPickers'
import { useComposerRowLayout } from './composer/useComposerRowLayout'
import { useColors } from '../theme'

interface ComposerControlsProps {
  /** The send-side buttons (update, voice, stop, send), owned by InputBar
   *  because they read its draft and voice state. */
  actions?: React.ReactNode
}

/**
 * The composer's one control row, anchored under the prompt text.
 *
 * The row reads as two halves, and which half a control belongs to is decided
 * by who it serves. Everything a person working IN the conversation reads or
 * reaches for is packed together on the left: what shapes the prompt (`+`,
 * Quick Tools, model, thinking, mode) and then what reports on what the
 * conversation holds (attachments, context radial). Attachments comes BEFORE
 * the radial so the icon whose width never changes anchors the cluster.
 *
 * Those two readouts sat on the right until they were moved here: parked
 * beside the microphone they were a long reach from everything they describe,
 * and the one gap separating them from the send buttons was doing all the work
 * of saying they were a different kind of thing. The flex spacer says it
 * better.
 *
 * Run activity is the exception, and it stays on the right. It does not
 * report on the prompt's contents — it reports on the RUN, which is what the
 * send button starts and the stop button ends. It belongs beside the verbs it
 * describes, so it sits immediately left of them.
 *
 * When the row is too narrow the three pickers fold into one menu; nothing
 * else moves.
 */
export function ComposerControls({ actions }: ComposerControlsProps): React.JSX.Element {
  const colors = useColors()
  // Rows extensions added through the Studio SDK.
  const plusMenuItems = useComposerActions()
  const { rowRef, expandedRef, leadingRef, readoutsRef, trailingRef, collapsed } = useComposerRowLayout()
  const pickers = (
    <>
      <ModelPicker />
      <ThinkingPicker />
      <PermissionModePicker />
    </>
  )
  return (
    <div
      ref={rowRef}
      data-ion-ui
      data-testid="composer-controls"
      data-collapsed={collapsed ? 'true' : 'false'}
      className="flex items-center gap-2"
      style={{ minHeight: 40, minWidth: 0, padding: '2px 0 4px', color: colors.textTertiary }}
    >
      <div ref={leadingRef} className="flex items-center gap-1.5 shrink-0">
        <ComposerPlusMenu extraItems={plusMenuItems} />
        <ComposerQuickToolsButton />
      </div>
      {collapsed ? (
        <ComposerCollapsedPickers>{pickers}</ComposerCollapsedPickers>
      ) : (
        <div ref={expandedRef} data-testid="composer-pickers-expanded" className="flex items-center gap-2 shrink-0">
          {pickers}
        </div>
      )}
      <div ref={readoutsRef} data-testid="composer-readouts" className="flex items-center gap-1.5 shrink-0">
        <AttachmentsButton />
        <ContextIndicator />
      </div>
      <span data-testid="composer-row-spacer" style={{ flex: '1 1 0', minWidth: 0 }} />
      <div ref={trailingRef} className="flex items-center gap-1.5 shrink-0">
        <span data-testid="composer-activity-status-inset" style={{ display: 'inline-flex', alignItems: 'center' }}>
          <StatusBarEngineState />
        </span>
        <div data-testid="composer-send-cluster" className="flex items-center gap-1.5">
          {actions}
        </div>
      </div>
    </div>
  )
}
