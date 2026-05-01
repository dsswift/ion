import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { FolderOpen, Plus, X } from '@phosphor-icons/react'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { compactPath } from './StatusBarShared'

/* ─── Directory Picker (button + popover for base/additional dirs) ─── */

export function DirectoryPicker() {
  const tab = useSessionStore(
    useShallow((s) => {
      const t = s.tabs.find((t) => t.id === s.activeTabId)
      return t
        ? {
            status: t.status,
            additionalDirs: t.additionalDirs,
            hasChosenDirectory: t.hasChosenDirectory,
            workingDirectory: t.workingDirectory,
            messages: t.messages,
          }
        : undefined
    }),
  )
  const addDirectory = useSessionStore((s) => s.addDirectory)
  const removeDirectory = useSessionStore((s) => s.removeDirectory)
  const setBaseDirectory = useSessionStore((s) => s.setBaseDirectory)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const [dirOpen, setDirOpen] = useState(false)
  const dirRef = useRef<HTMLButtonElement>(null)
  const dirPopRef = useRef<HTMLDivElement>(null)
  const [dirPos, setDirPos] = useState({ bottom: 0, left: 0 })

  // Close popover on tab change
  useEffect(() => { setDirOpen(false) }, [activeTabId])

  // Close popover on outside click
  useEffect(() => {
    if (!dirOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (dirRef.current?.contains(target)) return
      if (dirPopRef.current?.contains(target)) return
      setDirOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dirOpen])

  if (!tab) return null

  const isRunning = tab.status === 'running' || tab.status === 'connecting'
  const isEmpty = tab.messages.length === 0
  const hasExtraDirs = tab.additionalDirs.length > 0
  const baseLocked = !isEmpty

  const handleDirClick = () => {
    if (isRunning) return
    if (!dirOpen && dirRef.current) {
      const rect = dirRef.current.getBoundingClientRect()
      setDirPos({
        bottom: window.innerHeight - rect.top + 6,
        left: rect.left,
      })
    }
    setDirOpen((o) => !o)
  }

  const handleAddDir = async () => {
    const dir = await window.ion.selectDirectory()
    if (dir) {
      if (!tab.hasChosenDirectory && !baseLocked) {
        setBaseDirectory(dir)
      } else {
        addDirectory(dir)
      }
    }
  }

  const handleChangeBaseDir = async () => {
    if (isRunning || baseLocked) return
    const dir = await window.ion.selectDirectory()
    if (dir) {
      setBaseDirectory(dir)
    }
  }

  const dirTooltip = tab.hasChosenDirectory
    ? [tab.workingDirectory, ...tab.additionalDirs].join('\n')
    : 'Using home directory by default — click to choose a folder'

  return (
    <>
      {/* Directory button */}
      <button
        ref={dirRef}
        onClick={handleDirClick}
        className="flex items-center gap-1 rounded-full px-1.5 py-0.5 transition-colors flex-shrink-0"
        style={{
          color: colors.textTertiary,
          cursor: isRunning ? 'not-allowed' : 'pointer',
          maxWidth: 140,
        }}
        title={dirTooltip}
        disabled={isRunning}
      >
        <FolderOpen size={11} className="flex-shrink-0" />
        <span className="truncate">{tab.hasChosenDirectory ? compactPath(tab.workingDirectory) : '—'}</span>
        {hasExtraDirs && (
          <span style={{ color: colors.textTertiary, fontWeight: 600 }}>+{tab.additionalDirs.length}</span>
        )}
      </button>

      {/* Directory popover */}
      {popoverLayer && dirOpen && createPortal(
        <motion.div
          ref={dirPopRef}
          data-ion-ui
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl"
          style={{
            position: 'fixed',
            bottom: dirPos.bottom,
            left: dirPos.left,
            width: 'auto',
            minWidth: 220,
            maxWidth: 500,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
          }}
        >
          <div className="py-1.5 px-1">
            {/* Base directory */}
            <button
              onClick={handleChangeBaseDir}
              disabled={isRunning || baseLocked}
              className="w-full text-left px-2 py-1 rounded-lg transition-colors hover:bg-white/5"
              style={{ cursor: isRunning || baseLocked ? 'default' : 'pointer', opacity: baseLocked ? 0.7 : 1 }}
              title={baseLocked ? 'Base directory is locked after the conversation starts' : tab.hasChosenDirectory ? `${tab.workingDirectory} — click to change` : 'Click to choose a base directory'}
            >
              <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: colors.textTertiary }}>
                Base directory
              </div>
              <div className="flex items-center gap-1.5 text-[11px]" style={{ color: tab.hasChosenDirectory ? colors.textSecondary : colors.textMuted, whiteSpace: 'nowrap' }}>
                <FolderOpen size={13} className="flex-shrink-0" style={{ color: colors.accent }} />
                {tab.hasChosenDirectory ? tab.workingDirectory : 'None (defaults to ~)'}
              </div>
            </button>

            {/* Additional directories */}
            {hasExtraDirs && (
              <>
                <div className="mx-2 my-1" style={{ height: 1, background: colors.popoverBorder }} />
                <div className="px-2 py-1">
                  <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: colors.textTertiary }}>
                    Added directories
                  </div>
                  {tab.additionalDirs.map((dir) => (
                    <div key={dir} className="flex items-center justify-between py-0.5 group">
                      <span className="text-[11px] truncate mr-2" style={{ color: colors.textSecondary }} title={dir}>
                        {compactPath(dir)}
                      </span>
                      <button
                        onClick={() => removeDirectory(dir)}
                        className="flex-shrink-0 opacity-50 hover:opacity-100 transition-opacity"
                        style={{ color: colors.textTertiary }}
                        title="Remove directory"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="mx-2 my-1" style={{ height: 1, background: colors.popoverBorder }} />

            {/* Add directory button */}
            <button
              onClick={handleAddDir}
              className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] transition-colors rounded-lg"
              style={{ color: colors.accent }}
            >
              <Plus size={10} />
              Add directory...
            </button>
          </div>
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}
