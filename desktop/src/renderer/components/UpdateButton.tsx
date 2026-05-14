import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowCircleUp } from '@phosphor-icons/react'
import { useUpdateStore } from '../stores/update-store'
import { useColors } from '../theme'

/**
 * Small accent-colored button shown in the InputBar button group when
 * a new version has been downloaded. Clicking opens the install dialog.
 */
export function UpdateButton(): React.ReactElement | null {
  const version = useUpdateStore((s) => s.version)
  const colors = useColors()

  if (!version) return null

  return (
    <AnimatePresence>
      <motion.div
        key="update"
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.8 }}
        transition={{ duration: 0.15 }}
      >
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => useUpdateStore.getState().showDialog()}
          className="w-9 h-9 rounded-full flex items-center justify-center transition-colors"
          style={{ background: colors.micBg, color: colors.accent }}
          title={`Ion ${version} ready to install`}
        >
          <ArrowCircleUp size={18} weight="fill" />
        </button>
      </motion.div>
    </AnimatePresence>
  )
}
