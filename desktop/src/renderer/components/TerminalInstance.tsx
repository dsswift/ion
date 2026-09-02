import React, { useEffect, useRef } from 'react'
import { Terminal, ILinkProvider, ILink } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { useSessionStore } from '../stores/sessionStore'
import { LINK_RE, isCmdHeld, EDITABLE_EXTS } from '../hooks/useNavigableLinks'
import { rDebug, rWarn } from '../rendererLogger'
import { openClickedLink } from '../lib/open-link'
import { fileOpenIntent, isRenderableHtml, type FileClickModifiers } from '../lib/open-file-intent'
import { surfaceRouter } from '../lib/file-open-router'
import '@xterm/xterm/css/xterm.css'

interface TerminalEntry {
  terminal: Terminal
  fitAddon: FitAddon
  serializeAddon: SerializeAddon
  attached: boolean
  cwd: string
  hostEl: HTMLDivElement
  historyPending: boolean
  pendingChunks: string[]
  unsubLinks: () => void
}

// Module-level pool: one xterm instance per compound key, survives React re-renders.
// One IPC listener pair routes by that key. Per-instance listeners hit Electron's
// EventEmitter warning threshold when users keep many shells across conversations.
const terminalInstances = new Map<string, TerminalEntry>()
let terminalListenersInstalled = false

function installTerminalListeners(): void {
  if (terminalListenersInstalled) return
  terminalListenersInstalled = true
  window.ion.onTerminalData((key, data) => {
    const entry = terminalInstances.get(key)
    if (!entry) return
    if (entry.historyPending) entry.pendingChunks.push(data)
    else entry.terminal.write(data)
  })
  window.ion.onTerminalExit((key, _exitCode) => {
    const entry = terminalInstances.get(key)
    if (!entry) return
    entry.terminal.reset()
    void window.ion.terminalCreate(key, entry.cwd).then(() => {
      const dims = entry.fitAddon.proposeDimensions()
      if (dims) window.ion.terminalResize(key, dims.cols, dims.rows)
    }).catch((err) => rWarn('terminal', 'terminal recreate failed', { key, error: String(err) }))
  })
}

export function destroyTerminalInstance(key: string): void {
  const entry = terminalInstances.get(key)
  if (entry) {
    entry.unsubLinks()
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

// ─── Cmd+Click link provider for file paths & URLs in terminal output ───

function registerTerminalLinks(terminal: Terminal, cwd: string, tabId: string): () => void {
  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1)
      if (!line) { callback(undefined); return }
      const text = line.translateToString()
      if (!text.trim()) { callback(undefined); return }

      const links: ILink[] = []
      // Reset lastIndex since LINK_RE is a global regex
      const re = new RegExp(LINK_RE.source, 'g')
      let match: RegExpExecArray | null
      while ((match = re.exec(text)) !== null) {
        const raw = match[0]
        const trimmed = raw.replace(/[.,;:!?)]+$/, '')
        const isUrl = trimmed.startsWith('http')
        const startX = match.index + 1 // 1-based
        const endX = match.index + trimmed.length

        const decorations = { pointerCursor: isCmdHeld(), underline: isCmdHeld() }
        links.push({
          range: {
            start: { x: startX, y: bufferLineNumber },
            end: { x: endX, y: bufferLineNumber },
          },
          text: trimmed,
          decorations,
          activate(event: MouseEvent, linkText: string) {
            if (!event.metaKey) return
            if (isUrl) {
              // The real event is forwarded, not a synthesized one: the ⌘ gate
              // above satisfies the surface route, and ⌥ still reaches the
              // dispatcher as the escape to the operator's own browser.
              openClickedLink(linkText, event, 'terminal')
            } else {
              void openTerminalFile(linkText, cwd, tabId, event).catch((err) => rWarn('terminal', 'open file failed', { error: String(err) }))
            }
          },
          hover() {
            decorations.pointerCursor = isCmdHeld()
            decorations.underline = isCmdHeld()
          },
          leave() {
            decorations.pointerCursor = false
            decorations.underline = false
          },
        })
      }

      callback(links.length > 0 ? links : undefined)
    },
  }

  const disposable = terminal.registerLinkProvider(provider)
  return () => disposable.dispose()
}

async function openTerminalFile(path: string, cwd: string, tabId: string, event?: FileClickModifiers): Promise<void> {
  const homeDir = useSessionStore.getState().staticInfo?.homePath
    || '/Users/' + (process.env.USER || 'user')
  const expanded = path.startsWith('~/') ? homeDir + path.slice(1) : path
  const resolved = expanded.startsWith('/') ? expanded : cwd + '/' + expanded
  const { exists } = await window.ion.fsExists(resolved)
  if (!exists) {
    rDebug('terminal.link', 'file does not exist, ignoring cmd-click', { raw_path: path, resolved })
    return
  }
  rDebug('terminal.link', 'opening file', { resolved })
  const ext = resolved.includes('.') ? '.' + resolved.split('.').pop()!.toLowerCase() : ''
  const intent = fileOpenIntent(event)

  // Same three gestures as every other surface: ⌘ views, ⇧⌘ reads source,
  // ⌥⌘ hands it to the operating system. A terminal path used to always open
  // the editor, so an .html file behaved differently here than in the file
  // explorer.
  if (intent === 'native') {
    void window.ion.fsOpenNative(resolved).catch((err) => rWarn('terminal', 'open native failed', { error: String(err) }))
    return
  }
  if (intent === 'view' && isRenderableHtml(resolved)) {
    const router = surfaceRouter()
    if (router) {
      router.openHtml(resolved)
      return
    }
    rDebug('terminal.link', 'no surface router; opening html as source', { resolved })
  }
  if (EDITABLE_EXTS.has(ext)) {
    const router = surfaceRouter()
    if (router) router.openTextFile(cwd, tabId, resolved)
    else useSessionStore.getState().openFileInEditor(cwd, tabId, resolved)
  } else {
    void window.ion.fsOpenNative(resolved).catch((err) => rWarn('terminal', 'open native failed', { error: String(err) }))
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
  const terminalFontFamily = usePreferencesStore((s) => s.terminalFontFamily)
  const terminalFontSize = usePreferencesStore((s) => s.terminalFontSize)
  const uiZoom = usePreferencesStore((s) => s.uiZoom)
  const key = `${tabId}:${instanceId}`

  useEffect(() => {
    installTerminalListeners()
    const container = containerRef.current
    if (!container) return

    let entry = terminalInstances.get(key)
    const isNew = !entry
    let restoredBuffer: string | undefined

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
          selectionBackground: colors.focusRing,
        },
        allowTransparency: true,
        scrollback: 5000,
      })

      // Keyboard handling: Cmd+C, Cmd+V, Cmd+A, Alt/Cmd+Arrow navigation
      terminal.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true
        const isMeta = ev.metaKey

        if (isMeta && ev.key === 'v') {
          return true // let Electron menu role handle paste
        }

        if (isMeta && ev.key === 'c') {
          if (terminal.hasSelection()) {
            void navigator.clipboard.writeText(terminal.getSelection()).catch((err) => rWarn('terminal', 'copy failed', { error: String(err) }))
            terminal.clearSelection()
          }
          return false
        }

        if (isMeta && ev.key === 'a') {
          terminal.selectAll()
          return false
        }

        // xterm.js v6 removed the Alt+Arrow → word-navigation hack (#4538).
        // Translate Alt+Arrow to ESC b / ESC f (word back/forward) and
        // Cmd+Arrow to Ctrl-A / Ctrl-E (beginning/end of line) ourselves.
        if (ev.altKey && ev.key === 'ArrowLeft') {
          window.ion.terminalWrite(key, '\x1bb')
          return false
        }
        if (ev.altKey && ev.key === 'ArrowRight') {
          window.ion.terminalWrite(key, '\x1bf')
          return false
        }
        if (isMeta && ev.key === 'ArrowLeft') {
          window.ion.terminalWrite(key, '\x01')
          return false
        }
        if (isMeta && ev.key === 'ArrowRight') {
          window.ion.terminalWrite(key, '\x05')
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
      hostEl.setAttribute('data-ion-ui', '')
      hostEl.style.height = '100%'
      hostEl.style.background = 'transparent'
      terminal.open(hostEl)

      // Attach returns the authoritative main-process history. Live chunks queue
      // until it resolves so history is always written first. A disk-restored
      // buffer is the fallback after app restart, when main has no scrollback.
      restoredBuffer = consumeSavedBuffer(key)
      const historyPending = true
      const pendingChunks: string[] = []
      const unsubLinks = registerTerminalLinks(terminal, cwd, tabId)
      entry = {
        terminal,
        fitAddon,
        serializeAddon,
        attached: false,
        cwd,
        hostEl,
        historyPending,
        pendingChunks,
        unsubLinks,
      }
      terminalInstances.set(key, entry)
    }

    // Move persistent host element into the React container
    container.appendChild(entry.hostEl)

    requestAnimationFrame(() => {
      entry!.fitAddon.fit()

      if (isNew && !entry!.attached) {
        entry!.attached = true
        const dims = entry!.fitAddon.proposeDimensions()
        void window.ion.terminalAttach(key, { restartIfNotRunning: true, cwd }).then((info) => {
          const history = info.history || restoredBuffer || ''
          if (history) entry!.terminal.write(history)
          entry!.historyPending = false
          for (const chunk of entry!.pendingChunks) entry!.terminal.write(chunk)
          entry!.pendingChunks.length = 0
          if (dims) window.ion.terminalResize(key, dims.cols, dims.rows)
          rDebug('terminal', 'conversation terminal viewer attached', {
            key,
            running: info.running,
            history_bytes: history.length,
            cwd_fell_back: info.cwdFellBack,
          })
        }).catch((err) => {
          entry!.historyPending = false
          if (restoredBuffer) entry!.terminal.write(restoredBuffer)
          for (const chunk of entry!.pendingChunks) entry!.terminal.write(chunk)
          entry!.pendingChunks.length = 0
          rWarn('terminal', 'terminal attach failed', { key, error: String(err) })
        })
      }
    })

    // Wire keystrokes -> PTY (only while mounted/visible)
    const disposeOnData = entry.terminal.onData((data) => {
      window.ion.terminalWrite(key, data)
    })

    // Resize observer
    let rafId = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        if (!entry) return
        entry.fitAddon.fit()
        const dims = entry.fitAddon.proposeDimensions()
        if (dims) {
          window.ion.terminalResize(key, dims.cols, dims.rows)
        }
      })
    })
    ro.observe(container)

    entry.terminal.focus()

    return () => {
      disposeOnData.dispose()
      cancelAnimationFrame(rafId)
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
      window.ion.terminalResize(key, dims.cols, dims.rows)
    }
  }, [key, terminalFontFamily, terminalFontSize])

  // Refit terminal when UI zoom changes (container dimensions change due to counter-zoom)
  useEffect(() => {
    const entry = terminalInstances.get(key)
    if (!entry) return
    entry.fitAddon.fit()
    const dims = entry.fitAddon.proposeDimensions()
    if (dims) {
      window.ion.terminalResize(key, dims.cols, dims.rows)
    }
  }, [key, uiZoom])

  return (
    <div
      ref={containerRef}
      data-ion-ui
      style={{
        height: '100%',
        padding: '8px 12px 0 12px',
        boxSizing: 'border-box',
        overflow: 'hidden',
        zoom: uiZoom !== 1 ? 1 / uiZoom : undefined,
      }}
    />
  )
}
