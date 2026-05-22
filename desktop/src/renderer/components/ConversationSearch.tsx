import React, { useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CaretUp, CaretDown, X } from '@phosphor-icons/react'
import { useColors } from '../theme'
import type { ConversationSearchState, ConversationSearchActions } from '../hooks/useConversationSearch'

// ─── Types ───

interface Props {
  state: ConversationSearchState
  actions: ConversationSearchActions
  hiddenCount: number
  onLoadAllOlder: () => void
}

// ─── Component ───

export function ConversationSearch({ state, actions, hiddenCount, onLoadAllOlder }: Props) {
  const colors = useColors()
  const inputRef = useRef<HTMLInputElement>(null)

  const { active, query, matches, currentIndex } = state
  const { open, close, setQuery, next, prev } = actions

  const hasQuery = query.length > 0
  const matchCount = matches.length
  const noMatch = hasQuery && matchCount === 0
  const displayIndex = matchCount === 0 ? 0 : currentIndex + 1

  // ── Open / focus via CustomEvent ────────────────────────────────────────

  useEffect(() => {
    const handler = () => {
      if (active) {
        // Already open — re-focus and select all
        inputRef.current?.focus()
        inputRef.current?.select()
      } else {
        open()
      }
    }
    window.addEventListener('ion:open-conversation-search', handler)
    return () => window.removeEventListener('ion:open-conversation-search', handler)
  }, [active, open])

  // Focus input when bar opens
  useEffect(() => {
    if (active) {
      // Small delay so the animation has started
      const id = setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 60)
      return () => clearTimeout(id)
    }
  }, [active])

  // ── Next / prev via CustomEvent (Cmd+G / Cmd+Shift+G) ──────────────────

  useEffect(() => {
    const handleNext = () => { if (active) next() }
    const handlePrev = () => { if (active) prev() }
    window.addEventListener('ion:search-next', handleNext)
    window.addEventListener('ion:search-prev', handlePrev)
    return () => {
      window.removeEventListener('ion:search-next', handleNext)
      window.removeEventListener('ion:search-prev', handlePrev)
    }
  }, [active, next, prev])

  // ── Input key handlers ───────────────────────────────────────────────────

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) {
        prev()
      } else {
        next()
      }
    }
  }, [close, next, prev])

  // ── Derived styles ───────────────────────────────────────────────────────

  const inputBorderColor = noMatch
    ? colors.statusError
    : colors.toolBorder

  const inputStyle: React.CSSProperties = {
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: colors.textPrimary,
    fontSize: 12,
    width: 160,
    // Tint text red on no-match
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
          data-ion-search-ui
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
            boxShadow: `0 4px 16px rgba(0,0,0,0.18)`,
            display: 'flex',
            flexDirection: 'column',
            gap: 0,
            minWidth: 0,
          }}
        >
          {/* Main row: input + count + nav buttons + close */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '5px 6px 5px 10px',
              borderBottom: hiddenCount > 0 ? `1px solid ${colors.toolBorder}` : 'none',
            }}
          >
            {/* Input with tinted border on no-match */}
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

            {/* Match count */}
            <span style={countStyle}>
              {hasQuery ? `${displayIndex} / ${matchCount}` : ''}
            </span>

            {/* Prev */}
            <button
              style={iconButtonStyle}
              onClick={prev}
              title="Previous match (Shift+Enter)"
              tabIndex={-1}
              disabled={matchCount === 0}
            >
              <CaretUp size={13} />
            </button>

            {/* Next */}
            <button
              style={iconButtonStyle}
              onClick={next}
              title="Next match (Enter)"
              tabIndex={-1}
              disabled={matchCount === 0}
            >
              <CaretDown size={13} />
            </button>

            {/* Close */}
            <button
              style={{ ...iconButtonStyle, marginLeft: 2 }}
              onClick={close}
              title="Close (Esc)"
              tabIndex={-1}
            >
              <X size={13} />
            </button>
          </div>

          {/* Older messages hint */}
          {hiddenCount > 0 && (
            <div
              style={{
                padding: '4px 10px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <span style={{ fontSize: 10, color: colors.textTertiary }}>
                +{hiddenCount} older messages not searched
              </span>
              <button
                style={{
                  fontSize: 10,
                  color: colors.accent,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  flexShrink: 0,
                }}
                onClick={onLoadAllOlder}
              >
                Load all
              </button>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
