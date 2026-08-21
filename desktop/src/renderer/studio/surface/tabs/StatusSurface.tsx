import React from 'react'
import { StatusDrawer } from '../../../components/StatusDrawer'

/** Current-conversation status, cost, dispatch, and context-breakdown surface. */
export function StatusSurface(): React.JSX.Element {
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
      <StatusDrawer embedded />
    </div>
  )
}
