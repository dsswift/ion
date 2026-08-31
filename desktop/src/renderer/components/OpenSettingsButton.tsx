import React from 'react'
import { Gear } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { Tooltip } from './git/Tooltip'

export function OpenSettingsButton(): React.JSX.Element {
  const colors = useColors()
  return (
    <Tooltip text="Settings">
      <button
        type="button"
        aria-label="Open settings"
        onClick={() => useSessionStore.getState().openSettings()}
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full ion-focusable"
        style={{ border: 'none', background: 'transparent', color: colors.textTertiary, cursor: 'pointer' }}
      >
        <Gear size={14} />
      </button>
    </Tooltip>
  )
}
