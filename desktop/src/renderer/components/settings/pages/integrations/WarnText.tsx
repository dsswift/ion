/** WarnText — a warning line inside the automation editor: a read-only construct or an unmet action target. */
import React from 'react'
import { useColors } from '../../../../theme'
import { KIT } from '../../kit'

export function WarnText({ children }: { children: React.ReactNode }): React.JSX.Element {
  const colors = useColors()
  return <span style={{ fontSize: KIT.fontTiny, color: colors.statusWarning, lineHeight: 1.4 }}>{children}</span>
}
