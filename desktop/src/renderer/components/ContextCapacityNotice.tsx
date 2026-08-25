import React from 'react'
import { motion } from 'framer-motion'
import type { ColorPalette } from '../theme'

/** Capacity warning. The engine owns prompt admission and automatic compaction. */
export function ContextCapacityNotice({
  state,
  colors,
  onNewConversation,
}: {
  state: 'normal' | 'warning' | 'full'
  colors: ColorPalette
  onNewConversation: () => void
}): React.JSX.Element | null {
  if (state !== 'full') return null
  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} style={{ overflow: 'hidden', fontSize: 10, color: colors.dangerFg, padding: '4px 6px 0' }}>
      Context is full. The engine will compact before the next request when automatic compaction is enabled. You can also send /compact or /clear, or <button onClick={onNewConversation} style={{ border: 'none', background: 'transparent', color: colors.accent, cursor: 'pointer', fontSize: 10, padding: 0 }}>start a new conversation</button>.
    </motion.div>
  )
}
