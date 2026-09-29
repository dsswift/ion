import type { Terminal } from '@xterm/xterm'
import { rDebug } from '../rendererLogger'

/**
 * Write a terminal's recorded history into a fresh viewer without answering it.
 *
 * The history an attach returns is the raw pty stream, so it still holds every
 * question a program asked the terminal while it ran: the background color
 * (OSC 11), the cursor position (DSR 6n), device attributes. A viewer answers
 * each one as it parses it. Written with input enabled, a history answers
 * questions whose askers are long gone, and the answers land in whatever reads
 * the pty now -- usually the shell prompt, as literal text such as
 * `11;rgb:0000/0000/0000;1R`.
 *
 * xterm's stdin gate (`disableStdin`) silences every byte the terminal would
 * send, whatever the sequence, so it is closed for exactly this write and
 * restored in the write's completion callback. xterm runs write callbacks in
 * order, right after their own data is parsed, so output written after the
 * history is answered normally. The cost is that a key pressed while the
 * history is still parsing is dropped with the answers; a history is capped at
 * the server's scrollback size and parses in milliseconds, before the viewer
 * has anything to type at.
 */
export function writeTerminalHistory(terminal: Terminal, history: string, logFields: Record<string, unknown>): void {
  if (!history) return
  const stdinWasDisabled = terminal.options.disableStdin ?? false
  const startedAt = performance.now()
  terminal.options.disableStdin = true
  terminal.write(history, () => {
    terminal.options.disableStdin = stdinWasDisabled
    rDebug('terminal', 'terminal history replayed with answers suppressed', {
      ...logFields,
      history_bytes: history.length,
      parse_ms: Math.round(performance.now() - startedAt),
    })
  })
}
