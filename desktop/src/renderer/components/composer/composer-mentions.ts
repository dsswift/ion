/**
 * Rules for `@file` mentions in the composer: detecting the one being typed,
 * and turning the ones in a finished prompt into attachments.
 */
import type { FileAttachment } from '@ion/shared/types'
import { joinPath } from '@ion/shared/paths'
import { findComposerChipTokens } from './composer-chips'
import { rWarn } from '../../rendererLogger'

export interface ActiveMention {
  /** Offset of the `@` in the text. */
  from: number
  /** Offset of the cursor (end of the partial path). */
  to: number
  /** What has been typed after the `@`. */
  query: string
}

/**
 * The mention being typed at `offset`, or null. A mention starts a word — an
 * `@` after a letter is an email or a handle mid-word, not a mention.
 */
export function detectActiveMention(text: string, offset: number): ActiveMention | null {
  const before = text.slice(0, offset)
  const match = /(^|[\s(])@([\w\-./\\]*)$/.exec(before)
  if (!match) return null
  const from = before.length - match[2].length - 1
  return { from, to: offset, query: match[2] }
}

/** The text a picked path puts in the prompt. The trailing space ends the token. */
export function mentionInsertion(path: string): string {
  return `@${path} `
}

/** Distinct relative paths mentioned in `text`, in order of first appearance. */
export function mentionedPaths(text: string): string[] {
  const seen = new Set<string>()
  for (const token of findComposerChipTokens(text)) {
    if (token.kind === 'file') seen.add(token.ref)
  }
  return [...seen]
}

/**
 * Resolve the prompt's mentions to attachments so the model receives each
 * file's content, not only its name. A path that does not resolve to a file
 * (a typo, a deleted file) is left as plain text; one already attached is not
 * attached twice.
 */
export async function resolveMentionAttachments(
  text: string,
  workingDirectory: string,
  alreadyAttached: readonly FileAttachment[],
  describe: (absolutePath: string) => Promise<FileAttachment | null>,
): Promise<{ attachments: FileAttachment[]; unresolved: string[] }> {
  const attachedPaths = new Set(alreadyAttached.map((a) => a.path))
  const attachments: FileAttachment[] = []
  const unresolved: string[] = []
  for (const relativePath of mentionedPaths(text)) {
    const absolute = joinPath(workingDirectory, relativePath)
    if (attachedPaths.has(absolute)) continue
    let described: FileAttachment | null = null
    try {
      described = await describe(absolute)
    } catch (err) {
      rWarn('composer', 'describing a mentioned file failed', { path: absolute, error: String(err) })
    }
    if (described) { attachments.push(described); attachedPaths.add(absolute) } else unresolved.push(relativePath)
  }
  return { attachments, unresolved }
}
