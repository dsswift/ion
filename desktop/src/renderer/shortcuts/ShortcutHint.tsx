/**
 * ShortcutHint — the small chord badge rendered beside a panel or tab label.
 *
 * Two callers, one look: the dock tabs render it permanently, while the
 * title-bar pane toggles and canvas tabs render it only while the matching
 * modifier is held. The component itself is presentational — whether a hint is
 * visible is decided by the caller through `useRevealedShortcuts`.
 */

import React from 'react'
import { useColors } from '../theme'

export function ShortcutHint({
  chord,
  dimmed = false,
}: {
  chord: string
  /** A hint on an inactive row reads quieter than one on the active row. */
  dimmed?: boolean
}): React.JSX.Element {
  const colors = useColors()
  return (
    <span
      data-testid="shortcut-hint"
      aria-hidden="true"
      style={{
        fontSize: 9,
        lineHeight: 1,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: 0.2,
        color: colors.textTertiary,
        opacity: dimmed ? 0.65 : 0.9,
        border: `1px solid ${colors.containerBorder}`,
        borderRadius: 3,
        padding: '1px 3px',
        flexShrink: 0,
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
      }}
    >
      {chord}
    </span>
  )
}
