import React, { useEffect, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { NewConversationPicker } from './NewConversationPicker'
import type { NewConversationPickerTarget } from './new-conversation-picker-target'

/** Owns the one application-level conversation picker for either presentation. */
export function NewConversationPickerHost(): React.JSX.Element {
  const [picker, setPicker] = useState<{ key: number; target: NewConversationPickerTarget | null } | null>(null)

  useEffect(() => {
    const open = (event: Event): void => {
      const target = (event as CustomEvent<NewConversationPickerTarget>).detail
      setPicker({ key: Date.now(), target: target ?? null })
    }
    const openRecent = (): void => setPicker({ key: Date.now(), target: null })
    window.addEventListener('ion:open-new-conversation-picker', open)
    window.addEventListener('ion:open-recent-dirs', openRecent)
    return () => {
      window.removeEventListener('ion:open-new-conversation-picker', open)
      window.removeEventListener('ion:open-recent-dirs', openRecent)
    }
  }, [])

  return (
    <AnimatePresence>
      {picker && (
        <NewConversationPicker
          key={`new-conversation-picker-${picker.key}`}
          {...(picker.target ?? {})}
          onClose={() => setPicker(null)}
        />
      )}
    </AnimatePresence>
  )
}
