import React from 'react'
import { ContextIndicator } from './StatusBarContextIndicator'
import { ModelPicker } from './StatusBarModelPicker'
import { PermissionModePicker } from './StatusBarPermissionModePicker'
import { ThinkingPicker } from './StatusBarThinkingPicker'
import { AttachmentsButton } from './StatusBarAttachmentsButton'
import { StatusBarEngineState } from './StatusBarEngineState'
import { useColors } from '../theme'

/** Conversation-scoped controls anchored directly above InputBar's textarea. */
export function ComposerControls(): React.JSX.Element {
  const colors = useColors()
  return (
    <div
      data-ion-ui
      data-testid="composer-controls"
      className="flex items-center gap-2"
      style={{ minHeight: 28, minWidth: 0, padding: '4px 0 0', color: colors.textTertiary, flexWrap: 'wrap' }}
    >
      <ModelPicker />
      <ContextIndicator />
      <PermissionModePicker />
      <ThinkingPicker />
      <AttachmentsButton />
      <span style={{ flex: '1 1 20px' }} />
      <span
        data-testid="composer-activity-status-inset"
        style={{
          height: 20, paddingRight: 10, display: 'inline-flex', alignItems: 'center',
          alignSelf: 'center', transform: 'translateY(-5px)',
        }}
      >
        <StatusBarEngineState />
      </span>
    </div>
  )
}
