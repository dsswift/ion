import React from 'react'
import { ConfirmDialog } from '../../components/git/ConfirmDialog'
import { useSurfaceStore } from './surface-store'

/** Global discard gate for the one Scratch Document awaiting confirmation. */
export function ScratchCloseDialog(): React.JSX.Element | null {
  const pendingId = useSurfaceStore((state) => state.pendingScratchCloseId)
  const document = useSurfaceStore((state) => {
    if (!state.pendingScratchCloseId) return null
    for (const project of Object.values(state.scratchProjects)) {
      const match = project.documents.find((item) => item.id === state.pendingScratchCloseId)
      if (match) return match
    }
    return null
  })
  const cancel = useSurfaceStore((state) => state.cancelScratchClose)
  const confirm = useSurfaceStore((state) => state.confirmScratchClose)

  if (!pendingId || !document) return null
  return (
    <ConfirmDialog
      title="Discard Scratch Document?"
      message={`${document.fileName} has unsaved content. This removes it from every conversation for this project.`}
      confirmLabel="Discard"
      initialFocus="cancel"
      danger
      onConfirm={confirm}
      onCancel={cancel}
    />
  )
}
