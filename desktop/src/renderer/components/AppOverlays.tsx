import React from 'react'
import { UpdateDialog } from './UpdateDialog'
import { RemoteDirectoryPicker } from './RemoteDirectoryPicker'
import { NewConversationPickerHost } from './NewConversationPickerHost'
import { DeepLinkConfirmDialog } from './DeepLinkConfirmDialog'

/**
 * App-level singleton overlays.
 *
 * Each of these is mounted once for the whole application, renders nothing until
 * it has something to show, and is deliberately NOT tied to the active
 * conversation:
 *
 *   - UpdateDialog — the app is updating, not a conversation.
 *   - RemoteDirectoryPicker — used while choosing a directory on a remote engine
 *     host, before any tab exists for it.
 *   - DeepLinkConfirmDialog — an untrusted ion:// link needs approval, and the
 *     link may be what launched the app.
 *
 * Grouped into one component so App.tsx stays under the 600-line cap. The
 * grouping is the pre-existing shape of that tail block, not a new abstraction:
 * every member was already an unconditional app-level mount.
 *
 * None is gated on `tabsReady`. Each answers a question that can arise before
 * tabs have finished restoring, and each decides for itself when to appear.
 */
export function AppOverlays(): React.JSX.Element {
  return (
    <>
      <DeepLinkConfirmDialog />
      <UpdateDialog />
      <RemoteDirectoryPicker />
      <NewConversationPickerHost />
    </>
  )
}
