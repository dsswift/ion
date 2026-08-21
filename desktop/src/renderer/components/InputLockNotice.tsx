import React from 'react'
import type { TabState } from '../../shared/types'
import { useSessionStore } from '../stores/sessionStore'

/** Recovery actions for conversations the operator can no longer extend. */
export function InputLockNotice({ tab, accent }: { tab: TabState; accent: string }): React.JSX.Element {
  const createTab = useSessionStore((s) => s.createTab)

  if (tab.inputLockReason === 'settled') {
    return (
      <>
        Conversation settled. Input is disabled.
        <button onClick={() => { void useSessionStore.getState().unsettleTab(tab.id, 'user') }} style={{ marginLeft: 8, border: 'none', background: 'transparent', color: accent, cursor: 'pointer', fontSize: 12 }}>Un-settle</button>
      </>
    )
  }
  if (tab.inputLockReason === 'landed-worktree') {
    return <>Landed worktree review. Input is disabled. Retire this worktree when review is complete.</>
  }
  return (
    <>
      Automated conversation. Input is disabled.
      <button onClick={() => { void createTab() }} style={{ marginLeft: 8, border: 'none', background: 'transparent', color: accent, cursor: 'pointer', fontSize: 12 }}>New conversation</button>
    </>
  )
}
