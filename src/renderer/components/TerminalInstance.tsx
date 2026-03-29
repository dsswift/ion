import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { useColors, useThemeStore } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import '@xterm/xterm/css/xterm.css'

interface TerminalEntry {
  terminal: Terminal
  fitAddon: FitAddon
  serializeAddon: SerializeAddon
  created: boolean
  cwd: string
  hostEl: HTMLDivElement
  unsubData: () => void
  unsubExit: () => void
}

// Module-level pool: one xterm instance per compound key, survives React re-renders
const terminalInstances = new Map<string, TerminalEntry>()

export function destroyTerminalInstance(key: string): void {
  const entry = terminalInstances.get(key)
  if (entry) {
    entry.unsubData()
    entry.unsubExit()
    entry.hostEl.remove()
    entry.terminal.dispose()
    terminalInstances.delete(key)
  }
}

/** Get the xterm Terminal entry for a compound key (used for serialization) */
export function getTerminalEntry(key: string): TerminalEntry | undefined {
  return terminalInstances.get(key)
}

// Saved buffers for restoration -- consumed on first mount of each terminal
const savedBuffers = new Map<string, string>()

/** Store a saved buffer for a terminal key (used during tab restoration) */
export function setSavedBuffer(key: string, buffer: string): void {
  savedBuffers.set(key, buffer)
}

/** Consume a saved buffer (one-shot: returns and deletes) */
export function consumeSavedBuffer(key: string): string | undefined {
  const buf = savedBuffers.get(key)
  if (buf) savedBuffers.delete(key)
  return buf
}

/** Serialize a terminal's buffer for persistence */
export function serializeTerminalBuffer(key: string): string | undefined {
  const entry = terminalInstances.get(key)
  if (!entry) return undefined
  try {
    return entry.serializeAddon.serialize()
  } catch {
    return undefined
  }
}

interface Props {
  tabId: string
  instanceId: string
  cwd: string
  readOnly: boolean
}

export function TerminalInstanceView({ tabId, instanceId, cwd, readOnly }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const colors = useColors()
  const terminalFontFamily = useThemeStore((s) => s.terminalFontFamily)
  const terminalFontSize = useThemeStore((s) => s.terminalFontSize)
  const key = `${tabId}:${instanceId}`

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let entry = terminalInstances.get(key)
    const isNew = !entry

    if (!entry) {
      const terminal = new Terminal({
        cursorBlink: !readOnly,
        fontSize: terminalFontSize,
        fontFamily: terminalFontFamily,
        macOptionIsMeta: true,
        disableStdin: readOnly,
        theme: {
          background: 'transparent',
          foreground: colors.textPrimary,
          cursor: readOnly ? 'transparent' : colors.accent,
          selectionBackground: colors.textSecondary + '40',
        },
        allowTransparency: true,
        scrollback: 5000,
      })

      // Keyboard handling: Cmd+C, Cmd+V, Cmd+A
      terminal.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true
        const isMeta = ev.metaKey

        if (isMeta && ev.key === 'v') {
          return true // let Electron menu role handle paste
        }

        if (isMeta && ev.key === 'c') {
          if (terminal.hasSelection()) {
            navigator.clipboard.writeText(terminal.getSelection())
            terminal.clearSelection()
          }
          return false
        }

        if (isMeta && ev.key === 'a') {
          terminal.selectAll()
          return false
        }

        return true
      })

      const fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)

      const serializeAddon = new SerializeAddon()
      terminal.loadAddon(serializeAddon)

      // Create persistent host element that xterm renders into.
      const hostEl = document.createElement('div')
      hostEl.setAttribute('data-coda-ui', '')
      hostEl.style.height = '100%'
      hostEl.style.background = 'transparent'
      terminal.open(hostEl)

      // Restore saved buffer if available (history restore)
      const restoredBuffer = consumeSavedBuffer(key)
      if (restoredBuffer) {
        terminal.write(restoredBuffer)
      }

      // Module-level IPC listeners -- stay active even when component is unmounted
      const unsubData = window.coda.onTerminalData((k, data) => {
        if (k === key) terminal.write(data)
      })
      const unsubExit = window.coda.onTerminalExit((k, _exitCode) => {
        if (k !== key) return
        const e = terminalInstances.get(key)
        if (!e) return
        terminal.reset()
        window.coda.terminalCreate(key, e.cwd).then(() => {
          const dims = e.fitAddon.proposeDimensions()
          if (dims) window.coda.terminalResize(key, dims.cols, dims.rows)
        })
      })

      entry = { terminal, fitAddon, serializeAddon, created: false, cwd, hostEl, unsubData, unsubExit }
      terminalInstances.set(key, entry)
    }

    // Move persistent host element into the React container
    container.appendChild(entry.hostEl)

    requestAnimationFrame(() => {
      entry!.fitAddon.fit()

      // Create PTY on first open
      if (isNew && !entry!.created) {
        entry!.created = true
        const dims = entry!.fitAddon.proposeDimensions()
        window.coda.terminalCreate(key, cwd).then(() => {
          if (dims) {
            window.coda.terminalResize(key, dims.cols, dims.rows)
          }
          // Execute any pending command
          const pendingCmd = useSessionStore.getState().consumeTerminalPendingCommand(key)
          if (pendingCmd) {
            setTimeout(() => window.coda.terminalWrite(key, pendingCmd + '\n'), 100)
          }
        })
      }
    })

    // Wire keystrokes -> PTY (only while mounted/visible)
    const disposeOnData = entry.terminal.onData((data) => {
      window.coda.terminalWrite(key, data)
    })

    // Resize observer
    const ro = new ResizeObserver(() => {
      if (!entry) return
      entry.fitAddon.fit()
      const dims = entry.fitAddon.proposeDimensions()
      if (dims) {
        window.coda.terminalResize(key, dims.cols, dims.rows)
      }
    })
    ro.observe(container)

    entry.terminal.focus()

    return () => {
      disposeOnData.dispose()
      ro.disconnect()
      // Only remove if hostEl is still in this container (not stolen by a new mount)
      if (entry!.hostEl.parentElement === container) {
        entry!.hostEl.remove()
      }
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  // React to readOnly changes
  useEffect(() => {
    const entry = terminalInstances.get(key)
    if (!entry) return
    entry.terminal.options.disableStdin = readOnly
    entry.terminal.options.cursorBlink = !readOnly
    // Update cursor color based on read-only state
    entry.terminal.options.theme = {
      ...entry.terminal.options.theme,
      cursor: readOnly ? 'transparent' : colors.accent,
    }
  }, [key, readOnly, colors.accent])

  // React to font setting changes
  useEffect(() => {
    const entry = terminalInstances.get(key)
    if (!entry) return
    entry.terminal.options.fontFamily = terminalFontFamily
    entry.terminal.options.fontSize = terminalFontSize
    entry.fitAddon.fit()
    const dims = entry.fitAddon.proposeDimensions()
    if (dims) {
      window.coda.terminalResize(key, dims.cols, dims.rows)
    }
  }, [key, terminalFontFamily, terminalFontSize])

  return (
    <div
      ref={containerRef}
      data-coda-ui
      style={{
        height: '100%',
        padding: '8px 12px 0 12px',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    />
  )
}
