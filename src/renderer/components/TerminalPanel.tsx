import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useColors, useThemeStore } from '../theme'
import '@xterm/xterm/css/xterm.css'

interface TerminalEntry {
  terminal: Terminal
  fitAddon: FitAddon
  created: boolean
  cwd: string
  hostEl: HTMLDivElement
  unsubData: () => void
  unsubExit: () => void
}

// Module-level pool: one xterm instance per tab, survives React re-renders
const terminalInstances = new Map<string, TerminalEntry>()

export function destroyTerminalInstance(tabId: string): void {
  const entry = terminalInstances.get(tabId)
  if (entry) {
    entry.unsubData()
    entry.unsubExit()
    entry.hostEl.remove()
    entry.terminal.dispose()
    terminalInstances.delete(tabId)
  }
}

interface Props {
  tabId: string
  cwd: string
}

export function TerminalPanel({ tabId, cwd }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const colors = useColors()
  const terminalFontFamily = useThemeStore((s) => s.terminalFontFamily)
  const terminalFontSize = useThemeStore((s) => s.terminalFontSize)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let entry = terminalInstances.get(tabId)
    const isNew = !entry

    if (!entry) {
      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: terminalFontSize,
        fontFamily: terminalFontFamily,
        macOptionIsMeta: true,
        theme: {
          background: 'transparent',
          foreground: colors.textPrimary,
          cursor: colors.accent,
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

      // Create persistent host element that xterm renders into.
      // terminal.open() is a one-shot call -- the host element must survive
      // across React mount/unmount cycles.
      const hostEl = document.createElement('div')
      hostEl.setAttribute('data-coda-ui', '')
      hostEl.style.height = '100%'
      hostEl.style.background = 'transparent'
      terminal.open(hostEl)

      // Module-level IPC listeners -- stay active even when component is unmounted
      // so PTY output is always captured in the xterm buffer
      const unsubData = window.coda.onTerminalData((tid, data) => {
        if (tid === tabId) terminal.write(data)
      })
      const unsubExit = window.coda.onTerminalExit((tid, _exitCode) => {
        if (tid !== tabId) return
        const e = terminalInstances.get(tabId)
        if (!e) return
        terminal.reset()
        window.coda.terminalCreate(tabId, e.cwd).then(() => {
          const dims = e.fitAddon.proposeDimensions()
          if (dims) window.coda.terminalResize(tabId, dims.cols, dims.rows)
        })
      })

      entry = { terminal, fitAddon, created: false, cwd, hostEl, unsubData, unsubExit }
      terminalInstances.set(tabId, entry)
    }

    // Move persistent host element into the React container
    container.appendChild(entry.hostEl)

    requestAnimationFrame(() => {
      entry!.fitAddon.fit()

      // Create PTY on first open
      if (isNew && !entry!.created) {
        entry!.created = true
        const dims = entry!.fitAddon.proposeDimensions()
        window.coda.terminalCreate(tabId, cwd).then(() => {
          if (dims) {
            window.coda.terminalResize(tabId, dims.cols, dims.rows)
          }
        })
      }
    })

    // Wire keystrokes -> PTY (only while mounted/visible)
    const disposeOnData = entry.terminal.onData((data) => {
      window.coda.terminalWrite(tabId, data)
    })

    // Resize observer
    const ro = new ResizeObserver(() => {
      if (!entry) return
      entry.fitAddon.fit()
      const dims = entry.fitAddon.proposeDimensions()
      if (dims) {
        window.coda.terminalResize(tabId, dims.cols, dims.rows)
      }
    })
    ro.observe(container)

    entry.terminal.focus()

    return () => {
      disposeOnData.dispose()
      ro.disconnect()
      // Remove host element from DOM but keep it alive in the module-level map
      entry!.hostEl.remove()
    }
  }, [tabId]) // eslint-disable-line react-hooks/exhaustive-deps

  // React to font setting changes on existing instances
  useEffect(() => {
    const entry = terminalInstances.get(tabId)
    if (!entry) return
    entry.terminal.options.fontFamily = terminalFontFamily
    entry.terminal.options.fontSize = terminalFontSize
    entry.fitAddon.fit()
    const dims = entry.fitAddon.proposeDimensions()
    if (dims) {
      window.coda.terminalResize(tabId, dims.cols, dims.rows)
    }
  }, [tabId, terminalFontFamily, terminalFontSize])

  return (
    <div
      ref={containerRef}
      data-coda-ui
      style={{
        height: '100%',
        padding: '12px 12px 0 12px',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    />
  )
}
