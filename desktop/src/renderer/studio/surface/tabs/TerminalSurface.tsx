/**
 * TerminalSurface — a `terminal:` surface tab body: a pure ATTACH client
 * over a main-owned pty keyed by its owning Conversation.
 *
 * Lifecycle contract:
 *   - mount → TERMINAL_ATTACH {restartIfNotRunning:true}: write the history
 *     snapshot into xterm, then ride the live TERMINAL_INCOMING stream
 *     (chunks arriving during the async attach are queued and flushed after
 *     the snapshot so the transcript stays chronological)
 *   - unmount → detach only (listeners off; the pty keeps running)
 *   - explicit tab close (surface store teardown) is the ONE destroy path
 *   - pty exit → exited banner + press-any-key respawn (restartIfNotRunning)
 *   - dead cwd → visible fallback notice (respawned in ~)
 *
 * The `<conversationId>:surface:<instanceId>` namespace preserves exact parent
 * ownership while remaining distinct from conversation-panel Terminal keys.
 */
import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { usePreferencesStore } from '../../../preferences'
import { useColors } from '../../../theme'
import { rDebug, rWarn } from '../../../rendererLogger'
import '@xterm/xterm/css/xterm.css'
import { host } from '../../../host/host-instance'
import { writeTerminalHistory } from '../../../lib/terminal-history'
import { terminalFontStack } from '../../../lib/terminal-font'

export function TerminalSurface({ tabId, instanceId, cwd }: { tabId: string; instanceId: string; cwd: string }): React.JSX.Element {
  const colors = useColors()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const terminalFontFamily = usePreferencesStore((s) => s.terminalFontFamily)
  const terminalFontSize = usePreferencesStore((s) => s.terminalFontSize)
  const uiZoom = usePreferencesStore((s) => s.uiZoom)
  const [exited, setExited] = useState<number | null>(null)
  // The shell never started (as opposed to exited): the attach answered with
  // the reason, which is written into the terminal and shown as a banner.
  const [startError, setStartError] = useState<string | null>(null)
  const [cwdNotice, setCwdNotice] = useState(false)
  const key = `${tabId}:surface:${instanceId}`

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const terminal = new Terminal({
      fontSize: terminalFontSize,
      fontFamily: terminalFontStack(terminalFontFamily),
      allowTransparency: true,
      scrollback: 5000,
    })
    const fitAddon = new FitAddon()
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    terminal.loadAddon(fitAddon)
    terminal.open(container)

    let historyPending = true
    const pendingChunks: string[] = []
    let disposed = false

    const showStartFailure = (message: string): void => {
      setExited(null)
      setStartError(message)
      terminal.writeln(`\x1b[31mterminal failed to start:\x1b[0m ${message}`)
    }

    const attach = (restart: boolean): void => {
      historyPending = true
      void host.shell
        .terminalAttach(key, { restartIfNotRunning: restart, cwd })
        .then((info) => {
          if (disposed) return
          writeTerminalHistory(terminal, info.history, { key })
          setExited(info.running ? null : info.exitCode)
          setCwdNotice(info.cwdFellBack)
          if (!info.running && info.startError) {
            showStartFailure(info.startError)
            rWarn('studio.terminal', 'attached to a terminal that failed to start', { key, error: info.startError })
            return
          }
          setStartError(null)
          rDebug('studio.terminal', 'attached', { key, running: info.running, history_bytes: info.history.length })
        })
        .catch((err) => {
          if (disposed) return
          // The attach itself failed (transport, refusal). Shown the same way
          // as a spawn failure: a cursor over nothing explains nothing.
          showStartFailure(String(err))
          rWarn('studio.terminal', 'attach failed', { key, error: String(err) })
        })
        .finally(() => {
          historyPending = false
          for (const chunk of pendingChunks) terminal.write(chunk)
          pendingChunks.length = 0
        })
    }
    const offData = host.shell.onTerminalData((k, data) => {
      if (k !== key) return
      if (historyPending) pendingChunks.push(data)
      else terminal.write(data)
    })
    const offExit = host.shell.onTerminalExit((k, exitCode) => {
      if (k !== key) return
      setExited(exitCode)
    })

    attach(true)

    const onInput = terminal.onData((data) => {
      // Typing into an exited (or never-started) terminal respawns it on demand.
      if (exitedRef.current !== null || startErrorRef.current !== null) {
        terminal.reset()
        setExited(null)
        setStartError(null)
        attach(true)
        return
      }
      host.shell.terminalWrite(key, data)
    })

    const resize = (): void => {
      try {
        fitAddon.fit()
        const dims = fitAddon.proposeDimensions()
        if (dims) host.shell.terminalResize(key, dims.cols, dims.rows)
      } catch {
        // silent-ok: fit on a zero-size container during layout transitions
      }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    requestAnimationFrame(resize)

    return () => {
      // DETACH, never destroy: the pty (and its main-side scrollback)
      // survives unmounts, tab switches, window closes, and mode switches.
      disposed = true
      offData()
      offExit()
      onInput.dispose()
      observer.disconnect()
      fitAddonRef.current = null
      terminalRef.current = null
      terminal.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- attach once per key; font changes handled below
  }, [key])

  useEffect(() => {
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (!terminal || !fitAddon) return
    terminal.options.fontFamily = terminalFontStack(terminalFontFamily)
    terminal.options.fontSize = terminalFontSize
    try {
      fitAddon.fit()
      const dimensions = fitAddon.proposeDimensions()
      if (dimensions) host.shell.terminalResize(key, dimensions.cols, dimensions.rows)
    } catch (err) {
      rDebug('studio.terminal', 'fit skipped during typography update', { key, error: String(err) })
    }
  }, [key, terminalFontFamily, terminalFontSize, uiZoom])

  // Live exited flag for the input handler without re-running the effect.
  const exitedRef = useRef<number | null>(null)
  exitedRef.current = exited
  const startErrorRef = useRef<string | null>(null)
  startErrorRef.current = startError

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
      {cwdNotice && (
        <div style={{ padding: '3px 10px', fontSize: 10, fontFamily: 'system-ui, sans-serif', color: colors.warningFg, borderBottom: `1px solid ${colors.containerBorder}`, flexShrink: 0 }}>
          Original directory no longer exists — started in home directory.
        </div>
      )}
      <div ref={containerRef} data-ion-ui style={{ flex: 1, minHeight: 0, padding: '2px 4px', zoom: uiZoom !== 1 ? 1 / uiZoom : undefined }} />
      {exited !== null && (
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            left: 10,
            fontSize: 10,
            fontFamily: 'system-ui, sans-serif',
            color: colors.textTertiary,
            background: colors.surfacePrimary,
            border: `1px solid ${colors.containerBorder}`,
            borderRadius: 4,
            padding: '2px 8px',
          }}
        >
          exited ({exited}) — type to restart
        </div>
      )}
      {exited === null && startError !== null && (
        <div
          data-testid="terminal-start-error"
          style={{
            position: 'absolute',
            bottom: 8,
            left: 10,
            fontSize: 10,
            fontFamily: 'system-ui, sans-serif',
            color: colors.dangerFg,
            background: colors.surfacePrimary,
            border: `1px solid ${colors.containerBorder}`,
            borderRadius: 4,
            padding: '2px 8px',
          }}
        >
          failed to start — type to retry
        </div>
      )}
    </div>
  )
}
