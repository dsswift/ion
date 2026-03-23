import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { X, Circle, MagnifyingGlass } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import type { GitBranchInfo } from '../../shared/types'

const TRANSITION = { duration: 0.26, ease: [0.4, 0, 0.1, 1] as const }

interface BranchPickerDialogProps {
  repoPath: string
  onSelect: (branch: string, setAsDefault: boolean) => void
  onCancel: () => void
}

function abbreviatePath(p: string): string {
  const home = '/Users/'
  if (p.startsWith(home)) {
    const afterUsers = p.slice(home.length)
    const slashIdx = afterUsers.indexOf('/')
    if (slashIdx !== -1) return '~' + afterUsers.slice(slashIdx)
  }
  return p
}

export function BranchPickerDialog({ repoPath, onSelect, onCancel }: BranchPickerDialogProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()

  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [currentBranch, setCurrentBranch] = useState('')
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [highlightIndex, setHighlightIndex] = useState(0)
  const [setAsDefault, setSetAsDefault] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Load branches on mount; fire-and-forget fetch
  useEffect(() => {
    window.coda.gitFetch(repoPath)
    window.coda.gitBranches(repoPath).then((result) => {
      setBranches(result.branches)
      setCurrentBranch(result.current)
      setLoading(false)
    })
  }, [repoPath])

  // Focus the search input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [loading])

  const filtered = useMemo(() => {
    if (!filter) return branches
    const lower = filter.toLowerCase()
    return branches.filter((b) => b.name.toLowerCase().includes(lower))
  }, [branches, filter])

  // Reset highlight when filter changes
  useEffect(() => {
    setHighlightIndex(0)
  }, [filter])

  const selectBranch = useCallback(
    (name: string) => {
      onSelect(name, setAsDefault)
    },
    [onSelect, setAsDefault],
  )

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlightIndex((i) => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlightIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (filtered.length > 0) {
          selectBranch(filtered[highlightIndex].name)
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel, filtered, highlightIndex, selectBranch])

  // Scroll highlighted item into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const item = list.children[highlightIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  if (!popoverLayer) return null

  return createPortal(
    <motion.div
      data-coda-ui
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.4)',
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <motion.div
        data-coda-ui
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={TRANSITION}
        onClick={(e) => e.stopPropagation()}
        className="glass-surface"
        style={{
          width: 340,
          maxHeight: 400,
          borderRadius: 16,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 16px 0',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span style={{ color: colors.textPrimary, fontSize: 14, fontWeight: 600 }}>
              Select Source Branch
            </span>
            <span
              style={{
                color: colors.textTertiary,
                fontSize: 11,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {abbreviatePath(repoPath)}
            </span>
          </div>
          <button
            onClick={onCancel}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: colors.textTertiary,
              padding: 4,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              flexShrink: 0,
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div style={{ padding: '12px 16px 8px', position: 'relative' }}>
          <MagnifyingGlass
            size={14}
            style={{
              position: 'absolute',
              left: 26,
              top: '50%',
              transform: 'translateY(-50%)',
              color: colors.textTertiary,
              pointerEvents: 'none',
            }}
          />
          <input
            ref={inputRef}
            data-coda-ui
            type="text"
            placeholder="Filter branches..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{
              width: '100%',
              padding: '7px 10px 7px 30px',
              fontSize: 13,
              background: 'transparent',
              border: `1px solid ${colors.inputBorder}`,
              borderRadius: 8,
              color: colors.textPrimary,
              outline: 'none',
              boxSizing: 'border-box',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = colors.inputFocusBorder
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = colors.inputBorder
            }}
          />
        </div>

        {/* Branch list */}
        <div
          ref={listRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '0 8px',
            minHeight: 0,
          }}
        >
          {loading ? (
            <div
              style={{
                padding: '24px 16px',
                textAlign: 'center',
                color: colors.textTertiary,
                fontSize: 13,
              }}
            >
              Loading branches...
            </div>
          ) : filtered.length === 0 ? (
            <div
              style={{
                padding: '24px 16px',
                textAlign: 'center',
                color: colors.textTertiary,
                fontSize: 13,
              }}
            >
              No branches found
            </div>
          ) : (
            filtered.map((branch, idx) => {
              const isHighlighted = idx === highlightIndex
              const isCurrent = branch.name === currentBranch
              return (
                <button
                  key={branch.name}
                  data-coda-ui
                  onClick={() => selectBranch(branch.name)}
                  onMouseEnter={() => setHighlightIndex(idx)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '6px 8px',
                    fontSize: 13,
                    fontFamily: 'inherit',
                    background: isHighlighted ? colors.surfaceHover : 'transparent',
                    border: 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                    color: branch.isRemote ? colors.textTertiary : colors.textPrimary,
                    textAlign: 'left',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {isCurrent && (
                    <Circle size={8} weight="fill" color={colors.accent} style={{ flexShrink: 0 }} />
                  )}
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      marginLeft: isCurrent ? 0 : 16,
                    }}
                  >
                    {branch.name}
                  </span>
                </button>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '8px 16px 12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTop: `1px solid ${colors.containerBorder}`,
          }}
        >
          <label
            data-coda-ui
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              cursor: 'pointer',
              fontSize: 12,
              color: colors.textSecondary,
              userSelect: 'none',
            }}
          >
            <input
              data-coda-ui
              type="checkbox"
              checked={setAsDefault}
              onChange={(e) => setSetAsDefault(e.target.checked)}
              style={{ accentColor: colors.accent }}
            />
            Set as default for this directory
          </label>
          <button
            data-coda-ui
            onClick={onCancel}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: colors.textTertiary,
              fontSize: 12,
              padding: '4px 8px',
              borderRadius: 6,
            }}
          >
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>,
    popoverLayer,
  )
}
