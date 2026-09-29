/**
 * Which Quick Tools apply to a conversation.
 *
 * One rule, read by both the composer's lightning button (show or hide) and
 * the tray (what to list), so the button can never appear over an empty tray.
 */
import type { QuickTool } from '@ion/shared/types'

/** True when `dir` is `root` or a path beneath it. Either separator counts. */
function isUnder(dir: string, root: string): boolean {
  if (!dir || !root) return false
  if (dir === root) return true
  return dir.startsWith(`${root}/`) || dir.startsWith(`${root}\\`)
}

/**
 * User tools scoped to `workingDirectory`. A tool with no `directories` applies
 * everywhere; otherwise the conversation must sit in one of them.
 */
export function visibleUserQuickTools(tools: readonly QuickTool[], workingDirectory: string): QuickTool[] {
  return tools.filter((tool) => {
    if (!tool.directories || tool.directories.length === 0) return true
    return tool.directories.some((dir) => isUnder(workingDirectory, dir))
  })
}
