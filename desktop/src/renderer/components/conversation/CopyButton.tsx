import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { Copy, Check } from '@phosphor-icons/react'
import { useColors } from '../../theme'

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const colors = useColors()

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  return (
    <motion.button
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
      onClick={handleCopy}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] cursor-pointer flex-shrink-0"
      style={{
        background: copied ? colors.statusCompleteBg : 'transparent',
        color: copied ? colors.statusComplete : colors.textTertiary,
        border: 'none',
      }}
      title="Copy response"
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </motion.button>
  )
}
