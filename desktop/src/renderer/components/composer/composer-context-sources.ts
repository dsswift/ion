/**
 * The two surfaces that can hand context to the composer today: a terminal
 * pane and a changed file in the git panel.
 */
import type { Terminal } from '@xterm/xterm'
import { host } from '../../host/host-instance'
import { rError, rWarn } from '../../rendererLogger'
import { addComposerContext, diffContextToken, nextTerminalContextToken, TERMINAL_CONTEXT_FALLBACK_LINES } from './composer-context'

/** The terminal's selection, or its last lines when nothing is selected. Pure over the xterm API it reads. */
export function terminalContextText(terminal: Pick<Terminal, 'hasSelection' | 'getSelection' | 'buffer'>): { text: string; source: 'selection' | 'tail' } {
  if (terminal.hasSelection()) return { text: terminal.getSelection(), source: 'selection' }
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let i = Math.max(0, buffer.length - TERMINAL_CONTEXT_FALLBACK_LINES); i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
  }
  // Trailing blank rows are the unused part of the screen, not output.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return { text: lines.join('\n'), source: 'tail' }
}

export async function addTerminalContext(terminal: Pick<Terminal, 'hasSelection' | 'getSelection' | 'buffer'>): Promise<boolean> {
  const { text, source } = terminalContextText(terminal)
  if (text.trim().length === 0) {
    rWarn('composer', 'terminal context not added: the terminal is empty', { source })
    return false
  }
  const token = nextTerminalContextToken()
  return addComposerContext(token, `terminal-${token.slice('@@terminal:'.length)}.txt`, text)
}

export async function addDiffContext(directory: string, path: string, staged: boolean): Promise<boolean> {
  let diff: string
  try {
    const result = await host.shell.gitDiff(directory, path, staged)
    if (result.isBinary || result.diff.trim().length === 0) {
      rWarn('composer', 'diff context not added: no text diff for this file', { path, binary: result.isBinary })
      return false
    }
    diff = result.diff
  } catch (err) {
    rError('composer', 'diff context not added: reading the diff failed', { path, error: String(err) })
    return false
  }
  const base = path.split(/[/\\]/).pop() ?? path
  return addComposerContext(diffContextToken(path), `${base}.diff`, diff)
}
