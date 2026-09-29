import {
  aiAssistWorkflow,
  renderAiAssistTemplate,
  type AiAssistTemplateValues,
  type AiAssistWorkflowId,
} from './ai-assist-workflows'

/** Dynamic evidence inserted into bench-verification analysis template. */
export interface VerificationAnalysisContext {
  sourceBranch: string
  verifyCommand: string
  outputTail: string
  replayedMembers: readonly { branchName: string; worktreePath: string }[]
}

export function verificationAnalysisValues(ctx: VerificationAnalysisContext): AiAssistTemplateValues {
  return {
    sourceBranch: ctx.sourceBranch,
    verifyCommand: ctx.verifyCommand,
    outputTail: ctx.outputTail || '(no output captured)',
    replayedMembers: ctx.replayedMembers.length > 0
      ? ctx.replayedMembers.map((member) => `  - ${member.branchName} (worktree: ${member.worktreePath})`).join('\n')
      : '  (none recorded — every merge in this assembly was clean; treat every enrolled member as a candidate)',
  }
}

/** Back-compatible default builder used by tests and external renderer callers. */
export function buildVerificationAnalysisPrompt(ctx: VerificationAnalysisContext): string {
  const id: AiAssistWorkflowId = 'bench-verification-analysis'
  const result = renderAiAssistTemplate(id, aiAssistWorkflow(id).defaultTemplate, verificationAnalysisValues(ctx))
  if (!result.ok) throw new Error(result.error)
  return result.prompt
}
