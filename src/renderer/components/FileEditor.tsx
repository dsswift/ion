import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion, Reorder } from 'framer-motion'
import { X, Plus, Eye, PencilSimple, TextAlignLeft } from '@phosphor-icons/react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
// Editor portals to document.body (not PopoverLayer) so z-index can go behind main UI
import { useColors, useThemeStore } from '../theme'
import { useSessionStore, FileEditorTab } from '../stores/sessionStore'

import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars } from '@codemirror/view'
import { EditorState, Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { go } from '@codemirror/lang-go'
import { rust } from '@codemirror/lang-rust'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'

const REMARK_PLUGINS = [remarkGfm]

interface FileEditorProps {
  dir: string
  tabId: string
}

/** Map file extension to CodeMirror language extension */
function getLanguageExtension(fileName: string): Extension | null {
  const ext = fileName.includes('.') ? '.' + fileName.split('.').pop()!.toLowerCase() : ''
  switch (ext) {
    case '.ts':
    case '.tsx':
      return javascript({ typescript: true, jsx: ext === '.tsx' })
    case '.js':
    case '.jsx':
      return javascript({ jsx: ext === '.jsx' })
    case '.json':
      return json()
    case '.css':
    case '.scss':
      return css()
    case '.html':
      return html()
    case '.md':
      return markdown()
    case '.py':
      return python()
    case '.go':
      return go()
    case '.rs':
      return rust()
    case '.sql':
      return sql()
    case '.xml':
    case '.svg':
      return xml()
    default:
      return null
  }
}

function isMarkdownFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.md')
}

export function FileEditor({ dir, tabId }: FileEditorProps) {
  // no popoverLayer needed — portal to document.body
  const colors = useColors()

  // Panel position and size — use refs + direct DOM mutation during drag to avoid
  // re-renders that interfere with framer-motion Reorder layout animations
  const posRef = useRef({ x: 60, y: 80 })
  const [size, setSize] = useState({ w: 680, h: 480 })
  const minWidth = 400
  const minHeight = 280
  const panelRef = useRef<HTMLDivElement>(null)

  // Drag and resize refs
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)
  const resizeRef = useRef<{ startX: number; startY: number; originW: number; originH: number } | null>(null)

  // CodeMirror refs
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const activeFileIdRef = useRef<string | null>(null)

  // Store selectors
  const editorState = useSessionStore((s) => s.fileEditorStates.get(dir))
  const toggleFileEditor = useSessionStore((s) => s.toggleFileEditor)
  const closeFileEditorTab = useSessionStore((s) => s.closeFileEditorTab)
  const setActiveEditorFile = useSessionStore((s) => s.setActiveEditorFile)
  const createScratchFile = useSessionStore((s) => s.createScratchFile)
  const updateEditorContent = useSessionStore((s) => s.updateEditorContent)
  const markEditorSaved = useSessionStore((s) => s.markEditorSaved)
  const toggleEditorPreview = useSessionStore((s) => s.toggleEditorPreview)
  const toggleEditorReadOnly = useSessionStore((s) => s.toggleEditorReadOnly)
  const reorderEditorFiles = useSessionStore((s) => s.reorderEditorFiles)

  const files = editorState?.files ?? []
  const activeFileId = editorState?.activeFileId ?? null
  const activeFile = files.find((f) => f.id === activeFileId) ?? null

  const handleClose = useCallback(() => toggleFileEditor(tabId), [toggleFileEditor, tabId])

  // ---- Drag logic ----
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: posRef.current.x, originY: posRef.current.y }
  }, [])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = { startX: e.clientX, startY: e.clientY, originW: size.w, originH: size.h }
  }, [size])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const dx = e.clientX - dragRef.current.startX
        const dy = e.clientY - dragRef.current.startY
        const newX = Math.max(-200, Math.min(window.innerWidth - 100, dragRef.current.originX + dx))
        const newY = Math.max(0, Math.min(window.innerHeight - 32, dragRef.current.originY + dy))
        posRef.current = { x: newX, y: newY }
        // Direct DOM mutation — no React re-render, no layout thrash
        if (panelRef.current) {
          panelRef.current.style.left = `${newX}px`
          panelRef.current.style.top = `${newY}px`
        }
      }
      if (resizeRef.current) {
        const dx = e.clientX - resizeRef.current.startX
        const dy = e.clientY - resizeRef.current.startY
        setSize({
          w: Math.max(minWidth, resizeRef.current.originW + dx),
          h: Math.max(minHeight, resizeRef.current.originH + dy),
        })
      }
    }
    const handleMouseUp = () => {
      dragRef.current = null
      resizeRef.current = null
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // ---- File loading ----
  useEffect(() => {
    if (!activeFile) return
    if (activeFile.filePath && activeFile.content === '' && activeFile.savedContent === '') {
      window.coda.fsReadFile(activeFile.filePath).then((result) => {
        if (result.content !== null) {
          // Set both content and savedContent so isDirty starts false
          useSessionStore.setState((s) => {
            const states = new Map(s.fileEditorStates)
            const current = states.get(dir)
            if (!current) return {}
            states.set(dir, {
              ...current,
              files: current.files.map((f) =>
                f.id === activeFile.id
                  ? { ...f, content: result.content!, savedContent: result.content!, isDirty: false }
                  : f
              ),
            })
            return { fileEditorStates: states }
          })
        }
      })
    }
  }, [activeFile?.id, activeFile?.filePath, dir])

  // ---- Save handler ----
  const handleSave = useCallback(async () => {
    if (!activeFile || activeFile.isReadOnly) return
    if (activeFile.filePath) {
      const result = await window.coda.fsWriteFile(activeFile.filePath, activeFile.content)
      if (result.ok) {
        markEditorSaved(dir, activeFile.id, activeFile.filePath)
      }
    } else {
      const dialog = await window.coda.fsSaveDialog()
      if (dialog.filePath) {
        const result = await window.coda.fsWriteFile(dialog.filePath, activeFile.content)
        if (result.ok) {
          markEditorSaved(dir, activeFile.id, dialog.filePath)
        }
      }
    }
  }, [activeFile, dir, markEditorSaved])

  // Keep save handler ref current for CodeMirror keybinding
  const saveHandlerRef = useRef(handleSave)
  saveHandlerRef.current = handleSave

  // ---- CodeMirror theme ----
  const codaTheme = useMemo(() => EditorView.theme({
    '&': {
      backgroundColor: colors.containerBg,
      color: colors.textPrimary,
      fontSize: '12px',
      fontFamily: 'monospace',
      height: '100%',
    },
    '.cm-scroller': {
      overflow: 'auto',
    },
    '.cm-content': {
      caretColor: colors.accent,
    },
    '&.cm-focused .cm-cursor': {
      borderLeftColor: colors.accent,
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: `${colors.surfaceActive} !important`,
    },
    '.cm-gutters': {
      backgroundColor: colors.surfacePrimary,
      color: colors.textTertiary,
      borderRight: `1px solid ${colors.containerBorder}`,
    },
    '.cm-activeLineGutter': {
      backgroundColor: colors.surfaceSecondary,
    },
    '.cm-activeLine': {
      backgroundColor: colors.surfaceHover,
    },
  }), [colors])

  const editorWordWrap = useThemeStore((s) => s.editorWordWrap)
  const setEditorWordWrap = useThemeStore((s) => s.setEditorWordWrap)

  // ---- Build extensions for active file ----
  const buildExtensions = useCallback((file: FileEditorTab): Extension[] => {
    const exts: Extension[] = [
      oneDark,
      codaTheme,
      lineNumbers(),
      highlightActiveLine(),
      highlightSpecialChars(),
      bracketMatching(),
      highlightSelectionMatches(),
      history(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        {
          key: 'Mod-s',
          run: () => {
            saveHandlerRef.current()
            return true
          },
        },
      ]),
    ]

    if (editorWordWrap) exts.push(EditorView.lineWrapping)

    const langExt = getLanguageExtension(file.fileName)
    if (langExt) exts.push(langExt)

    if (file.isReadOnly) {
      exts.push(EditorState.readOnly.of(true))
      exts.push(EditorView.editable.of(false))
    }

    // Update content on change (non-readOnly)
    if (!file.isReadOnly) {
      exts.push(EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const newContent = update.state.doc.toString()
          updateEditorContent(dir, file.id, newContent)
        }
      }))
    }

    return exts
  }, [codaTheme, dir, updateEditorContent, editorWordWrap])

  // ---- CodeMirror lifecycle ----
  useEffect(() => {
    if (!editorContainerRef.current || !activeFile || activeFile.isPreview) {
      // Destroy view if switching to preview or no file
      if (viewRef.current) {
        viewRef.current.destroy()
        viewRef.current = null
        activeFileIdRef.current = null
      }
      return
    }

    const container = editorContainerRef.current
    const stateKey = `${activeFile.id}:${activeFile.isReadOnly}:${editorWordWrap}`

    // If same file with same config, skip recreation
    if (viewRef.current && activeFileIdRef.current === stateKey) {
      return
    }

    // Destroy previous view
    if (viewRef.current) {
      viewRef.current.destroy()
      viewRef.current = null
    }

    const state = EditorState.create({
      doc: activeFile.content,
      extensions: buildExtensions(activeFile),
    })

    const view = new EditorView({ state, parent: container })
    viewRef.current = view
    activeFileIdRef.current = stateKey

    return () => {
      // Only destroy if switching away or unmounting
      // The next effect run will handle re-creation
    }
  }, [activeFile?.id, activeFile?.isPreview, activeFile?.isReadOnly, buildExtensions])

  // Sync external content changes into the editor (e.g., after file load)
  useEffect(() => {
    if (!viewRef.current || !activeFile || activeFile.isPreview) return
    const stateKey = `${activeFile.id}:${activeFile.isReadOnly}:${editorWordWrap}`
    if (activeFileIdRef.current !== stateKey) return

    const currentDoc = viewRef.current.state.doc.toString()
    if (currentDoc !== activeFile.content) {
      viewRef.current.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: activeFile.content },
      })
    }
  }, [activeFile?.content, activeFile?.id, activeFile?.isPreview])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (viewRef.current) {
        viewRef.current.destroy()
        viewRef.current = null
      }
    }
  }, [])

  // ---- Markdown preview components ----
  const markdownComponents = useMemo(() => ({
    a: ({ href, children }: any) => (
      <button
        type="button"
        className="underline decoration-dotted underline-offset-2 cursor-pointer"
        style={{ color: colors.accent }}
        onClick={() => {
          if (href) window.coda.openExternal(String(href))
        }}
      >
        {children}
      </button>
    ),
  }), [colors])

  if (typeof document === 'undefined') return null

  const tabTitle = useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.id === tabId)
    return tab?.customTitle || tab?.title || ''
  })
  const isFocused = useSessionStore((s) => s.fileEditorFocused)
  const focusFileEditor = useSessionStore((s) => s.focusFileEditor)

  const baseDirName = dir.split('/').pop() || dir
  const headerTitle = [
    baseDirName,
    tabTitle,
    activeFile?.fileName,
  ].filter(Boolean).join(' - ') || 'File Editor'

  const panel = (
    <motion.div
      ref={panelRef}
      data-coda-ui
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.15 }}
      className="glass-surface rounded-xl"
      onMouseDown={focusFileEditor}
      style={{
        position: 'fixed',
        left: posRef.current.x,
        top: posRef.current.y,
        width: size.w,
        height: size.h,
        display: 'flex',
        flexDirection: 'column',
        background: colors.containerBg,
        border: `1px solid ${colors.containerBorder}`,
        boxShadow: isFocused ? '0 16px 48px rgba(0, 0, 0, 0.4)' : '0 4px 12px rgba(0, 0, 0, 0.2)',
        overflow: 'hidden',
        pointerEvents: 'auto',
        zIndex: isFocused ? 10000 : 5,
        opacity: isFocused ? 1 : 0.85,
        transition: 'box-shadow 0.15s, opacity 0.15s',
      }}
    >
      {/* Draggable header */}
      <div
        data-coda-ui
        className="flex items-center px-3"
        style={{
          height: 32,
          minHeight: 32,
          borderBottom: `1px solid ${colors.containerBorder}`,
          background: colors.surfacePrimary,
          cursor: 'grab',
          userSelect: 'none',
        }}
        onMouseDown={handleDragStart}
      >
        <button
          onClick={handleClose}
          className="flex-shrink-0 p-0.5 rounded transition-colors"
          style={{ color: colors.textTertiary, cursor: 'pointer' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <X size={12} />
        </button>
        <span
          className="text-[11px] truncate"
          style={{ color: colors.textSecondary, fontFamily: 'monospace', flex: 1, textAlign: 'center' }}
        >
          {headerTitle}
        </span>
      </div>

      {/* Tab strip */}
      <div
        data-coda-ui
        className="flex items-center"
        style={{
          height: 30,
          minHeight: 30,
          background: colors.surfacePrimary,
          borderBottom: `1px solid ${colors.containerBorder}`,
          userSelect: 'none',
        }}
      >
        {/* Scrollable tabs (draggable reorder) */}
        <Reorder.Group
          as="div"
          axis="x"
          values={files}
          onReorder={(reordered) => reorderEditorFiles(dir, reordered)}
          className="flex items-center gap-0 flex-1 overflow-x-auto"
          style={{ scrollbarWidth: 'none' }}
        >
          {files.map((file) => (
            <Reorder.Item
              key={file.id}
              value={file}
              as="div"
              dragListener={true}
              dragConstraints={{ top: 0, bottom: 0 }}
              style={{ cursor: 'grab' }}
            >
              <TabItem
                file={file}
                isActive={file.id === activeFileId}
                colors={colors}
                onSelect={() => setActiveEditorFile(dir, file.id)}
                onClose={(e) => {
                  e.stopPropagation()
                  closeFileEditorTab(dir, file.id)
                }}
              />
            </Reorder.Item>
          ))}
          <button
            className="flex items-center justify-center px-2 rounded transition-colors"
            style={{
              height: 30,
              color: colors.textTertiary,
              cursor: 'pointer',
            }}
            onClick={() => createScratchFile(dir)}
            title="New scratch file"
          >
            <Plus size={12} weight="bold" />
          </button>
        </Reorder.Group>

        {/* Right-side actions */}
        <div className="flex items-center gap-1 px-2">
          {activeFile && isMarkdownFile(activeFile.fileName) && (
            <button
              className="flex items-center justify-center rounded p-1 transition-colors"
              style={{
                color: activeFile.isPreview ? colors.accent : colors.textTertiary,
                cursor: 'pointer',
                background: activeFile.isPreview ? colors.accentLight : 'transparent',
              }}
              onClick={() => toggleEditorPreview(dir, activeFile.id)}
              title="Toggle preview"
            >
              <Eye size={13} />
            </button>
          )}
          {activeFile && activeFile.isReadOnly && (
            <button
              className="flex items-center justify-center rounded p-1 transition-colors"
              style={{
                color: colors.textTertiary,
                cursor: 'pointer',
              }}
              onClick={() => toggleEditorReadOnly(dir, activeFile.id)}
              title="Enable editing"
            >
              <PencilSimple size={13} />
            </button>
          )}
          <button
            className="flex items-center justify-center rounded p-1 transition-colors"
            style={{
              color: editorWordWrap ? colors.accent : colors.textTertiary,
              cursor: 'pointer',
            }}
            onClick={() => setEditorWordWrap(!editorWordWrap)}
            title={editorWordWrap ? 'Disable word wrap' : 'Enable word wrap'}
          >
            <TextAlignLeft size={13} />
          </button>
        </div>
      </div>

      {/* Editor / Preview area */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {activeFile ? (
          activeFile.isPreview && isMarkdownFile(activeFile.fileName) ? (
            /* Markdown preview */
            <div
              style={{
                overflowY: 'auto',
                flex: 1,
                padding: '12px 16px',
              }}
            >
              <div className="text-[13px] leading-[1.6] prose-cloud" style={{ color: colors.textSecondary }}>
                <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
                  {activeFile.content}
                </Markdown>
              </div>
            </div>
          ) : (
            /* CodeMirror editor */
            <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
              <div
                ref={editorContainerRef}
                style={{ position: 'absolute', inset: 0 }}
              />
              {activeFile.isReadOnly && (
                <div
                  style={{
                    position: 'absolute',
                    top: 6,
                    right: 12,
                    fontSize: 9,
                    fontFamily: 'monospace',
                    color: colors.textTertiary,
                    background: colors.surfacePrimary,
                    padding: '1px 6px',
                    borderRadius: 3,
                    opacity: 0.7,
                    pointerEvents: 'none',
                  }}
                >
                  READ-ONLY
                </div>
              )}
            </div>
          )
        ) : (
          /* No file open */
          <div
            className="flex items-center justify-center"
            style={{ flex: 1, color: colors.textTertiary, fontSize: 12, fontFamily: 'monospace' }}
          >
            No file open
          </div>
        )}
      </div>

      {/* Resize handle */}
      <div
        data-coda-ui
        onMouseDown={handleResizeStart}
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 16,
          height: 16,
          cursor: 'nwse-resize',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" style={{ opacity: 0.25 }}>
          <line x1="14" y1="6" x2="6" y2="14" stroke={colors.textTertiary} strokeWidth="1.5" />
          <line x1="14" y1="10" x2="10" y2="14" stroke={colors.textTertiary} strokeWidth="1.5" />
        </svg>
      </div>
    </motion.div>
  )

  return createPortal(panel, document.body)
}

// ---- Tab item sub-component ----

interface TabItemProps {
  file: FileEditorTab
  isActive: boolean
  colors: ReturnType<typeof useColors>
  onSelect: () => void
  onClose: (e: React.MouseEvent) => void
}

function TabItem({ file, isActive, colors, onSelect, onClose }: TabItemProps) {
  return (
    <div
      className="flex items-center gap-1.5 px-2 cursor-pointer transition-colors"
      style={{
        height: 30,
        background: isActive ? colors.surfaceSecondary : 'transparent',
        borderBottom: isActive ? `2px solid ${colors.accent}` : '2px solid transparent',
        fontFamily: 'monospace',
        fontSize: 11,
        color: isActive ? colors.textPrimary : colors.textTertiary,
        whiteSpace: 'nowrap',
      }}
      onClick={onSelect}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(e) } }}
    >
      <span style={{ fontStyle: file.filePath === null ? 'italic' : 'normal' }}>
        {file.fileName}
      </span>
      {file.isDirty && (
        <span
          style={{
            display: 'inline-block',
            width: 5,
            height: 5,
            borderRadius: '50%',
            backgroundColor: colors.accent,
            flexShrink: 0,
          }}
        />
      )}
      <button
        className="flex items-center justify-center rounded p-0.5 transition-colors"
        style={{
          color: colors.textTertiary,
          cursor: 'pointer',
          opacity: 0.6,
          flexShrink: 0,
        }}
        onClick={onClose}
      >
        <X size={10} />
      </button>
    </div>
  )
}
