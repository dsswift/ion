/**
 * Word-level diff for paired add/remove lines.
 */

import { diffWordsWithSpace } from 'diff'

export interface WordToken {
  type: 'context' | 'add' | 'remove'
  text: string
}

export function wordDiff(oldLine: string, newLine: string): { old: WordToken[]; new: WordToken[] } {
  const parts = diffWordsWithSpace(oldLine, newLine)
  const oldOut: WordToken[] = []
  const newOut: WordToken[] = []
  for (const p of parts) {
    if (p.added) newOut.push({ type: 'add', text: p.value })
    else if (p.removed) oldOut.push({ type: 'remove', text: p.value })
    else { oldOut.push({ type: 'context', text: p.value }); newOut.push({ type: 'context', text: p.value }) }
  }
  return { old: oldOut, new: newOut }
}
