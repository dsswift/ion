/**
 * Running a Project Quick Tool, and the trust step in front of its first run.
 *
 * A project tool is a shell command that arrived with a repository. Before the
 * first run in a project — and again whenever the project's tool list changes
 * — the operator is shown every command in full and must approve the list. The
 * Environment enforces this too: it hands a command to the terminal only while
 * the approved hash matches the file, so this module is the courtesy, not the
 * guard.
 */
import { useSessionStore } from '@ion/server/store/sessionStore'
import { projectQuickToolStoreId, type ProjectQuickTool } from '@ion/shared/project-studio-config'
import { host } from '../../host/host-instance'
import { rInfo, rWarn } from '../../rendererLogger'

/** The full text of what the operator is approving: every command, none abbreviated. */
export function projectToolsTrustMessage(tools: readonly ProjectQuickTool[]): string {
  const lines = tools.map((t) => `${t.name}\n    ${t.command}`)
  return [
    'This project ships Quick Tools in its .ion/studio.json. Each one runs a shell command in a terminal when you click it.',
    '',
    ...lines,
    '',
    'Trust these only if you trust this repository. You will be asked again if the list changes.',
  ].join('\n')
}

export function runProjectQuickTool(tabId: string, tool: ProjectQuickTool): void {
  void useSessionStore.getState().runQuickTool(tabId, projectQuickToolStoreId(tool.id)).catch((error) => {
    rWarn('terminal', 'project quick tool launch failed', { tab_id: tabId, tool_id: tool.id, error: String(error) })
  })
}

/** Approve the list identified by `toolsHash`, then run `tool`. A refusal runs nothing. */
export async function trustThenRunProjectQuickTool(
  tabId: string,
  directory: string,
  toolsHash: string,
  tool: ProjectQuickTool,
): Promise<boolean> {
  const result = await host.shell.trustProjectQuickTools(directory, toolsHash)
  if (!result.trusted) {
    rWarn('composer', 'project quick tools were not trusted; nothing was run', { directory, reason: result.reason ?? 'unknown' })
    return false
  }
  rInfo('composer', 'project quick tools trusted by the operator', { directory })
  runProjectQuickTool(tabId, tool)
  return true
}
