import React, { useLayoutEffect, useRef } from 'react'
import type { useColors } from '../../theme'

/**
 * AutoGrowTextarea — the guided-questions text input primitive.
 *
 * Starts at ONE row, grows with content to a maximum of four rows, then
 * scrolls vertically. Wrapping is forced (no horizontal scroll, ever): long
 * unbroken strings break mid-word rather than widening the field. Growth is
 * measured from scrollHeight in a layout effect, so it tracks paste,
 * programmatic resets, and font metrics without a guessed line height.
 */
export function AutoGrowTextarea({
  value,
  onChange,
  placeholder,
  colors,
  emphasized,
}: {
  value: string
  onChange: (text: string) => void
  placeholder: string
  colors: ReturnType<typeof useColors>
  /** Text-mode answer fields carry the info border; Other inputs are subdued. */
  emphasized?: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Measure natural content height at auto, then clamp to four rows. The
    // one-row minimum comes from rows={1}; maxHeight is measured from the
    // computed line height (never a hardcoded pixel guess).
    el.style.height = 'auto'
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 16
    const padding = el.offsetHeight - el.clientHeight // border box extras
    const maxHeight = lineHeight * 4 + padding + 12 // 12 = vertical padding (py-1.5)
    const next = Math.min(el.scrollHeight, maxHeight)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [value])

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={1}
      wrap="soft"
      className="w-full text-[12px] px-2.5 py-1.5 rounded-lg outline-none resize-none"
      style={{
        background: colors.surfaceHover,
        color: colors.textPrimary,
        border: `1px solid ${emphasized ? colors.infoBorder : colors.surfaceSecondary}`,
        overflowX: 'hidden',
        wordBreak: 'break-word',
      }}
    />
  )
}
