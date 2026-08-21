import React from 'react'
import { AnimatePresence, motion } from 'framer-motion'

interface Props {
  visible: boolean
  border: string
  text: string
  hasAttachments: boolean
}

/** Explains that image models use only the current prompt. */
export function ImageModelNotice({ visible, border, text, hasAttachments }: Props): React.JSX.Element {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="image-model-banner"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.15 }}
          style={{ overflow: 'hidden' }}
        >
          <div style={{
            fontSize: 10, color: text, borderLeft: `2px solid ${border}`,
            paddingLeft: 6, paddingTop: 4, paddingBottom: 2,
            marginTop: hasAttachments ? 4 : 6,
          }}>
            Image model — only your current message is sent (no conversation history)
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
