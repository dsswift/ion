/**
 * Bash command mode, extracted from InputBar.handleSend.
 *
 * Bash mode is a separate dispatch from a prompt send: the text never reaches
 * the LLM, it runs in the conversation's working directory and its output is
 * stored as a pending tool message. Keeping it out of the component leaves one
 * send path per destination and keeps InputBar under the file-size cap.
 *
 * Unlike a prompt, clearing the input first is correct here: the only refusals
 * (empty command, an execution already in flight, a still-connecting session)
 * are decided before anything is cleared, and the execution itself cannot
 * refuse — a failed IPC call comes back as command output, not as a dropped
 * send.
 */

export interface BashDispatchDeps {
  /** Trimmed command text, already read from the input. */
  command: string
  /** True while a previous bash execution for this tab is still running. */
  bashExecuting: boolean
  /** True while the session is connecting or tab state is still restoring. */
  isConnecting: boolean
  cwd: string
  activeTabId: string | null
  clearInput: () => void
  clearDraft: (tabId: string) => void
  exitBashMode: () => void
  startBashCommand: (cmd: string, execId: string) => { toolMsgId: string; tabId: string }
  completeBashCommand: (
    tabId: string,
    toolMsgId: string,
    cmd: string,
    stdout: string,
    stderr: string,
    exitCode: number | null,
  ) => void
  executeBash: (execId: string, cmd: string, cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>
  onSettled: () => void
}

/** Returns false when the command was refused and nothing was cleared. */
export function dispatchBashCommand(deps: BashDispatchDeps): boolean {
  if (!deps.command) return false
  if (deps.bashExecuting) return false
  if (deps.isConnecting) return false

  const execId = crypto.randomUUID()
  deps.clearInput()
  if (deps.activeTabId) deps.clearDraft(deps.activeTabId)
  deps.exitBashMode()

  const { toolMsgId, tabId } = deps.startBashCommand(deps.command, execId)
  deps.executeBash(execId, deps.command, deps.cwd).then((result) => {
    deps.completeBashCommand(tabId, toolMsgId, deps.command, result.stdout, result.stderr, result.exitCode)
    deps.onSettled()
  }).catch((err) => {
    deps.completeBashCommand(tabId, toolMsgId, deps.command, '', `IPC error: bash execution failed: ${String(err)}`, 1)
  })
  return true
}
