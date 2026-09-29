/**
 * FindBar — the floating find field for a pane searched by `useDomFind`: the
 * conversation transcript and the canvas's rendered views. The pane owns the
 * state and decides when the bar opens; the bar only renders it.
 */
import React, { useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CaretUp, CaretDown, X } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { Tooltip } from './git/Tooltip'
import { FIND_SKIP_ATTR, type DomFindState, type DomFindActions } from '../hooks/useDomFind'

interface Props {
  state: DomFindState
  actions: DomFindActions
}

export function FindBar({ state, actions }: Props) {
  const colors = useColors()
  const inputRef = useRef<HTMLInputElement>(null)

  const { active, query, matchCount, currentIndex, focusRequest } = state
  const { close, setQuery, next, prev } = actions

  const hasQuery = query.length > 0
  const noMatch = hasQuery && matchCount === 0
  const displayIndex = matchCount === 0 ? 0 : currentIndex + 1

  // Every open request focuses the field and selects its text, including a
  // repeat press while the bar is already showing.
  useEffect(() => {
    if (!active) return
    // Small delay so the entry animation has started and the input exists.
    const id = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 60)
    return () => clearTimeout(id)
  }, [active, focusRequest])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) prev()
      else next()
    }
  }, [close, next, prev])

  const inputBorderColor = noMatch ? colors.statusError : colors.toolBorder

  const inputStyle: React.CSSProperties = {
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: colors.textPrimary,
    fontSize: 12,
    width: 160,
    caretColor: noMatch ? colors.statusError : colors.accent,
  }

  const countStyle: React.CSSProperties = {
    fontSize: 11,
    color: noMatch ? colors.statusError : colors.textTertiary,
    minWidth: 44,
    textAlign: 'right',
    flexShrink: 0,
    userSelect: 'none',
  }

  const iconButtonStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 3,
    borderRadius: 4,
    color: colors.textTertiary,
    flexShrink: 0,
  }

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          {...{ [FIND_SKIP_ATTR]: '' }}
          initial={{ opacity: 0, y: -6, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.97 }}
          transition={{ duration: 0.15 }}
          style={{
            position: 'absolute',
            top: 8,
            right: 12,
            zIndex: 20,
            background: colors.containerBg,
            border: `1px solid ${colors.toolBorder}`,
            borderRadius: 10,
            boxShadow: colors.popoverShadow,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '5px 6px 5px 10px',
            minWidth: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              border: `1px solid ${inputBorderColor}`,
              borderRadius: 6,
              padding: '2px 6px',
              background: colors.surfacePrimary,
              transition: 'border-color 0.15s',
            }}
          >
            <input
              ref={inputRef}
              type="text"
              placeholder="Find…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              style={inputStyle}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
            />
          </div>

          <span style={countStyle}>
            {hasQuery ? `${displayIndex} / ${matchCount}` : ''}
          </span>

          <Tooltip text="Previous match (Shift+Enter)">
            <button style={iconButtonStyle} onClick={prev} tabIndex={-1} disabled={matchCount === 0}>
              <CaretUp size={13} />
            </button>
          </Tooltip>

          <Tooltip text="Next match (Enter)">
            <button style={iconButtonStyle} onClick={next} tabIndex={-1} disabled={matchCount === 0}>
              <CaretDown size={13} />
            </button>
          </Tooltip>

          <Tooltip text="Close (Esc)">
            <button style={{ ...iconButtonStyle, marginLeft: 2 }} onClick={close} tabIndex={-1}>
              <X size={13} />
            </button>
          </Tooltip>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
