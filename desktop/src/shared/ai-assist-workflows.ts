export type AiAssistWorkflowId =
  | 'rebase-resolution'
  | 'merge-resolution'
  | 'cherry-pick-resolution'
  | 'bench-verification-analysis'

export interface AiAssistWorkflow {
  id: AiAssistWorkflowId
  label: string
  description: string
  placeholders: readonly string[]
  defaultTemplate: string
}

const REBASE_TEMPLATE = `Resolve the currently in-progress rebase in {{directory}}.

Inspect every conflict, resolve files, run relevant formatters and tests, then stage resolved files. Do not abort the rebase. Do not combine continue with resolution, formatting, testing, or staging commands. Only after those steps succeed, make a separate standalone call containing only git rebase --continue. Done only when the operation has ended and git status reports no unmerged paths.`

const MERGE_TEMPLATE = `Resolve the currently in-progress merge in {{directory}}.

{{benchContext}}

Inspect every conflict, resolve files, run relevant formatters and tests, then stage resolved files. Do not abort the merge. Do not combine continue with resolution, formatting, testing, or staging commands. Only after those steps succeed, make a separate standalone call containing only git merge --continue. Done only when the operation has ended and git status reports no unmerged paths.`

const CHERRY_PICK_TEMPLATE = `Resolve the currently in-progress cherry-pick in {{directory}}.

Inspect every conflict, resolve files, run relevant formatters and tests, then stage resolved files. Do not abort the cherry-pick. Do not combine continue with resolution, formatting, testing, or staging commands. Only after those steps succeed, make a separate standalone call containing only git cherry-pick --continue. Done only when the operation has ended and git status reports no unmerged paths.`

const VERIFICATION_TEMPLATE = `A bench assembly failed PROJECT VERIFICATION, not a merge conflict.
Bench source branch: {{sourceBranch}}.
Every member merged successfully, including any replayed conflict resolutions. The tree you are standing in right now IS the tree that failed verification — it has been rebuilt into this bench specifically so you can read it.

The verify command that failed: {{verifyCommand}}
Its output:
\`\`\`
{{outputTail}}
\`\`\`

Members whose merge came from a REPLAYED conflict resolution (the suspects — a replay is the one thing this assembly introduced beyond the members’ own commits):
{{replayedMembers}}

Your job is to decide which of exactly two situations this is, and output a VERDICT. Do not attempt to fix anything. Do not edit any file in this bench. Do not propose a bench-local shim, adapter, or compatibility layer of any kind: the bench is rebuilt from scratch on every assembly, so any change you made here has no permanent home and would be silently discarded on the next reassembly — it is work thrown away at best, and a landing hazard at worst if it were ever committed.

MECHANICAL: a recorded conflict resolution produced a tree that is textually clean but functionally wrong (a mangled hunk, a duplicated line, a dropped brace, a stray merge marker git did not catch). If this is the case, name the exact member and the exact defect. The fix is to discard that one member’s recording and re-resolve — the recovery dialog already offers this as a one-click verb once you have named which member.

SEMANTIC: two (or more) members are each individually correct, but their combination is not — one renamed or removed something the other still calls, one changed a signature or contract the other still relies on. No merge here is wrong, so there is no fix to apply in the bench. The correct path is to disable one of the colliding members in the bench, verify the other in isolation, land it so it becomes part of the base, and then sync the other member upward against the new base — which dissolves the incompatibility at its source instead of merging around it.

Output shape, in this order:
1. One line: "Verdict: Mechanical" or "Verdict: Semantic".
2. The member(s) involved, by branch name, and your reasoning.
3. If Semantic: a fenced code block containing a paste-ready prompt for the OWNING member’s own conversation. That prompt must stand alone in a fresh session: name the bench and source branch ({{sourceBranch}}), name the other member it collides with, name the exact symbol, file, and line the incompatibility is in, quote the verify command that catches it, and instruct that conversation to fix the incompatibility in ITS OWN worktree and commit there — never in the bench.

State the verdict and stop. Do not ask questions — this conversation is locked and nobody can answer them. Do not attempt any fix yourself.`

export const AI_ASSIST_WORKFLOWS: readonly AiAssistWorkflow[] = [
  {
    id: 'rebase-resolution',
    label: 'Rebase Resolution',
    description: 'Resolves a worktree sync that stopped during rebase.',
    placeholders: ['directory'],
    defaultTemplate: REBASE_TEMPLATE,
  },
  {
    id: 'merge-resolution',
    label: 'Merge Resolution',
    description: 'Resolves a merge conflict, including integration-bench resolve-once merges.',
    placeholders: ['directory', 'benchContext'],
    defaultTemplate: MERGE_TEMPLATE,
  },
  {
    id: 'cherry-pick-resolution',
    label: 'Cherry-pick Resolution',
    description: 'Resolves a cherry-pick that stopped on conflicting changes.',
    placeholders: ['directory'],
    defaultTemplate: CHERRY_PICK_TEMPLATE,
  },
  {
    id: 'bench-verification-analysis',
    label: 'Bench Verification Analysis',
    description: 'Diagnoses a project verification failure after all bench members merged.',
    placeholders: ['sourceBranch', 'verifyCommand', 'outputTail', 'replayedMembers'],
    defaultTemplate: VERIFICATION_TEMPLATE,
  },
]

const BY_ID = new Map(AI_ASSIST_WORKFLOWS.map((workflow) => [workflow.id, workflow]))
const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g

export function isAiAssistWorkflowId(value: string): value is AiAssistWorkflowId {
  return BY_ID.has(value as AiAssistWorkflowId)
}

export function aiAssistWorkflow(id: AiAssistWorkflowId): AiAssistWorkflow {
  const workflow = BY_ID.get(id)
  if (!workflow) throw new Error(`Unknown AI-assisted workflow: ${id}`)
  return workflow
}

export function validateAiAssistTemplate(id: AiAssistWorkflowId, template: string): string | null {
  const allowed = new Set(aiAssistWorkflow(id).placeholders)
  const unknown = [...template.matchAll(PLACEHOLDER)]
    .map((match) => match[1])
    .filter((name, index, names) => !allowed.has(name) && names.indexOf(name) === index)
  return unknown.length > 0 ? `Unknown placeholder${unknown.length === 1 ? '' : 's'}: ${unknown.map((name) => `{{${name}}}`).join(', ')}` : null
}

export type AiAssistTemplateValues = Record<string, string>
export type AiAssistRenderResult = { ok: true; prompt: string } | { ok: false; error: string }

export function renderAiAssistTemplate(
  id: AiAssistWorkflowId,
  template: string,
  values: AiAssistTemplateValues,
): AiAssistRenderResult {
  const validationError = validateAiAssistTemplate(id, template)
  if (validationError) return { ok: false, error: validationError }

  const missing = [...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1]))]
    .filter((name) => !(name in values))
  if (missing.length > 0) {
    return { ok: false, error: `Missing placeholder value${missing.length === 1 ? '' : 's'}: ${missing.map((name) => `{{${name}}}`).join(', ')}` }
  }

  const prompt = template.replace(PLACEHOLDER, (_match, name: string) => values[name])
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { ok: true, prompt }
}

export function effectiveAiAssistTemplate(
  id: AiAssistWorkflowId,
  overrides: Partial<Record<AiAssistWorkflowId, string>> = {},
): { template: string; overridden: boolean } {
  const override = overrides[id]?.trim()
  return override
    ? { template: override, overridden: true }
    : { template: aiAssistWorkflow(id).defaultTemplate, overridden: false }
}
