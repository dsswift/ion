import React, { useState, useRef, useEffect, useCallback } from 'react'

interface InlineRenameInputProps {
  value: string
  onCommit: (newValue: string) => void
  onCancel: () => void
  color: string
  fontWeight: number
}

/** Auto-sizing inline text input used to rename a tab in place. */
export function InlineRenameInput({
  value,
  onCommit,
  onCancel,
  color,
  fontWeight,
}: InlineRenameInputProps) {
  const [editValue, setEditValue] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const [inputWidth, setInputWidth] = useState(0)
  const committedRef = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    if (measureRef.current) {
      setInputWidth(measureRef.current.offsetWidth + 4)
    }
  }, [editValue])

  const commit = useCallback(() => {
    if (committedRef.current) return
    committedRef.current = true
    const trimmed = editValue.trim()
    onCommit(trimmed)
  }, [editValue, onCommit])

  return (
    <>
      {/* Hidden measuring span */}
      <span
        ref={measureRef}
        style={{
          position: 'absolute',
          visibility: 'hidden',
          whiteSpace: 'pre',
          fontSize: 12,
          fontWeight,
        }}
      >
        {editValue || ' '}
      </span>
      <input
        ref={inputRef}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
          e.stopPropagation()
        }}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: Math.max(inputWidth, 20),
          background: 'transparent',
          border: 'none',
          outline: 'none',
          padding: 0,
          margin: 0,
          fontSize: 12,
          fontWeight,
          color,
          fontFamily: 'inherit',
        }}
      />
    </>
  )
}
