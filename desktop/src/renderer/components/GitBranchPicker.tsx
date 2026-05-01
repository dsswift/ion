import React, { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { CaretDown, Plus, GitBranch, Trash, Check } from '@phosphor-icons/react'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import type { GitBranchInfo } from '../../shared/types'

export function BranchPicker({
  directory,
  currentBranch,
  onRefresh,
  worktree,
}: {
  directory: string
  currentBranch: string
  onRefresh: () => void
  worktree?: { branchName: string; sourceBranch: string; worktreePath: string; repoPath: string } | null
}) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

  const loadBranches = useCallback(async () => {
    try {
      const result = await window.ion.gitBranches(directory)
      setBranches(result.branches)
      setError(null)
    } catch {}
  }, [directory])

  useEffect(() => {
    if (open) loadBranches()
  }, [open, loadBranches])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleToggle = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      setPos({ bottom: window.innerHeight - rect.bottom - rect.height + 6, left: rect.left })
    }
    setOpen((o) => !o)
    setCreating(false)
    setNewName('')
    setError(null)
  }

  const handleCheckout = async (branch: string) => {
    const result = await window.ion.gitCheckout(directory, branch)
    if (result.ok) {
      setOpen(false)
      onRefresh()
    } else {
      setError(result.error || 'Checkout failed')
    }
  }

  const handleCreate = async () => {
    if (!newName.trim()) return
    const result = await window.ion.gitCreateBranch(directory, newName.trim())
    if (result.ok) {
      setOpen(false)
      setCreating(false)
      setNewName('')
      onRefresh()
    } else {
      setError(result.error || 'Create failed')
    }
  }

  const handleDelete = async (branch: string) => {
    const result = await window.ion.gitDeleteBranch(directory, branch)
    if (result.ok) {
      loadBranches()
    } else {
      setError(result.error || 'Delete failed')
    }
  }

  const localBranches = branches.filter((b) => !b.isRemote)
  const remoteBranches = branches.filter((b) => b.isRemote)

  return (
    <>
      <button
        ref={triggerRef}
        onClick={worktree ? undefined : handleToggle}
        className="flex items-center gap-0.5 text-[10px] rounded px-1 py-0.5 truncate"
        style={{
          color: colors.textSecondary,
          maxWidth: 100,
          ...(worktree ? { pointerEvents: 'none' as const, opacity: 0.6 } : {}),
        }}
        title={worktree ? 'Branch is managed by worktree mode' : currentBranch}
      >
        <GitBranch size={10} style={{ flexShrink: 0 }} />
        <span className="truncate">{currentBranch || 'detached'}</span>
        {!worktree && <CaretDown size={8} style={{ flexShrink: 0, opacity: 0.6 }} />}
      </button>

      {popoverLayer && open && createPortal(
        <motion.div
          ref={popoverRef}
          data-ion-ui
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl"
          style={{
            position: 'fixed',
            bottom: pos.bottom,
            left: Math.min(pos.left, window.innerWidth - 220),
            width: 210,
            maxHeight: 320,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div className="overflow-y-auto py-1" style={{ flex: 1 }}>
            {/* Local branches */}
            {localBranches.map((b) => (
              <div
                key={b.name}
                className="flex items-center justify-between px-2 py-1 text-[11px] group"
                style={{ color: b.isCurrent ? colors.textPrimary : colors.textSecondary }}
              >
                <button
                  onClick={() => !b.isCurrent && handleCheckout(b.name)}
                  className="flex items-center gap-1 truncate flex-1 text-left"
                  style={{ cursor: b.isCurrent ? 'default' : 'pointer' }}
                >
                  {b.isCurrent && <Check size={10} style={{ color: colors.accent, flexShrink: 0 }} />}
                  <span className="truncate">{b.name}</span>
                </button>
                {!b.isCurrent && !(worktree && (b.name === worktree.branchName || b.name === worktree.sourceBranch)) && (
                  <button
                    onClick={() => handleDelete(b.name)}
                    className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5 transition-opacity"
                    style={{ color: colors.textTertiary }}
                    title="Delete branch"
                  >
                    <Trash size={10} />
                  </button>
                )}
              </div>
            ))}

            {/* Remote branches */}
            {remoteBranches.length > 0 && (
              <>
                <div className="mx-2 my-1" style={{ height: 1, background: colors.popoverBorder }} />
                <div className="px-2 py-0.5 text-[9px] uppercase tracking-wider" style={{ color: colors.textTertiary }}>
                  Remotes
                </div>
                {remoteBranches.map((b) => (
                  <button
                    key={b.name}
                    onClick={() => handleCheckout(b.name)}
                    className="w-full text-left px-2 py-1 text-[11px] truncate"
                    style={{ color: colors.textTertiary }}
                  >
                    {b.name}
                  </button>
                ))}
              </>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="px-2 py-1.5 text-[10px]" style={{ color: '#c47060', borderTop: `1px solid ${colors.popoverBorder}` }}>
              {error}
            </div>
          )}

          {/* Create branch */}
          {!worktree && <div style={{ borderTop: `1px solid ${colors.popoverBorder}` }}>
            {creating ? (
              <div className="flex items-center gap-1 px-2 py-1.5">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false) }}
                  placeholder="branch-name"
                  className="flex-1 text-[11px] bg-transparent outline-none"
                  style={{ color: colors.textPrimary }}
                />
                <button onClick={handleCreate} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: colors.accent }}>
                  Create
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full flex items-center gap-1 px-2 py-1.5 text-[11px]"
                style={{ color: colors.accent }}
              >
                <Plus size={10} />
                New branch...
              </button>
            )}
          </div>}
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}
