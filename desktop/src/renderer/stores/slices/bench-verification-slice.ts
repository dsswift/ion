/**
 * bench-verification-slice — the AI-assisted ANALYSIS flow for a bench
 * verification failure (never a fix; see bench-verification-prompt.ts for
 * why plan mode and a locked tab are the correct shape here).
 *
 * Modelled directly on openConflictAssist (git-conflict-slice.ts): same tier
 * gate, same fresh-tab-never-commandeer rule, same role+lock-before-submit
 * ordering. The one deliberate divergence is the permission mode — 'plan'
 * here, 'auto' there — because the deliverable is a verdict, not a diff.
 *
 * ONE forwarded action (ATV multi-step rule): this reads store state
 * (benchWorkspaces, to build the prompt) between two mutations (materialising
 * the diagnostic tree on disk, then creating and tagging a tab), so a
 * component handler chaining these calls would run in whichever window hosts
 * it and could decide against stale mirror state.
 */
import type { StoreSet, StoreGet, State } from '../session-store-types'
import type { BenchAssembleResult } from '../../../shared/types'
import { rInfo, rWarn } from '../../rendererLogger'
import { usePreferencesStore } from '../../preferences'
import { applyPermissionModeForTab } from './tab-slice-permission-mode'
import { verificationAnalysisValues } from '../../../shared/bench-verification-prompt'
import { effectiveAiAssistTemplate, renderAiAssistTemplate } from '../../../shared/ai-assist-workflows'
import { resolveWorkbenchTier } from '../resolve-workbench-tier'

export function createBenchVerificationSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    openBenchVerificationAnalysis: async (repoPath, sourceBranch) => {
      const ws = (get().benchWorkspaces.get(repoPath) ?? []).find((w) => w.sourceBranch === sourceBranch)
      if (!ws) {
        throw new Error(`No integration workspace for ${sourceBranch}.`)
      }

      const tier = await resolveWorkbenchTier({
        workflow: 'bench-verification-analysis', repoPath, sourceBranch,
      })
      if (!tier.ok) throw new Error(tier.error)

      // ── Materialise the failing tree BEFORE creating anything ──────────
      // A refusal here (the bench state moved since the failure) must leave
      // no tab behind to clean up.
      rInfo('bench.verification', 'preparing diagnostic tree', { repo_path: repoPath, source_branch: sourceBranch })
      const prepared = await window.ion.benchPrepareVerificationAnalysis(repoPath, sourceBranch)
      if (!prepared.ok || !prepared.benchPath) {
        rWarn('bench.verification', 'diagnostic preparation failed', {
          repo_path: repoPath, source_branch: sourceBranch, error: prepared.error ?? '',
        })
        throw new Error(prepared.error ?? 'Could not rebuild the failing bench tree for analysis.')
      }

      // Refresh so the prompt reads the just-written evidence rather than the
      // pre-diagnostic record still cached in the store.
      await get().refreshBench(repoPath)
      const refreshed = (get().benchWorkspaces.get(repoPath) ?? []).find((w) => w.sourceBranch === sourceBranch)
      const evidence = refreshed?.lastAssemblyVerification
      const replayedMembers = (evidence?.replayedBranches ?? []).map((branchName) => ({
        branchName,
        worktreePath: (refreshed ?? ws).members.find((m) => m.branchName === branchName)?.worktreePath ?? branchName,
      }))

      const workflowId = 'bench-verification-analysis' as const
      const { template, overridden } = effectiveAiAssistTemplate(
        workflowId,
        usePreferencesStore.getState().aiAssistPromptOverrides,
      )
      const rendered = renderAiAssistTemplate(workflowId, template, verificationAnalysisValues({
        sourceBranch,
        verifyCommand: evidence?.command ?? '(unknown — evidence unavailable)',
        outputTail: evidence?.outputTail ?? '',
        replayedMembers,
      }))
      if (!rendered.ok) {
        rWarn('bench.verification', 'analysis prompt validation failed', {
          repo_path: repoPath, source_branch: sourceBranch, workflow: workflowId,
          overridden, error: rendered.error,
        })
        throw new Error(`AI-assisted workflow prompt is invalid: ${rendered.error}`)
      }
      rInfo('bench.verification', 'analysis prompt rendered', {
        repo_path: repoPath, source_branch: sourceBranch, workflow: workflowId, overridden,
      })
      const prompt = rendered.prompt

      // useWorktree=false: the bench IS the checkout to analyse.
      // skipDuplicateCheck=true: never commandeer a non-blank conversation
      // already open in the bench (the bench's persistent operator
      // conversation, in particular) — this is always a fresh tab.
      const tabId = await get().createTabInDirectory(prepared.benchPath, false, true)
      get().setTabAutomaticModel(tabId, tier.model)

      // Plan mode, not auto: the deliverable here is a verdict, and plan mode
      // is read-only, so the agent structurally cannot edit the bench even
      // before ion-meta's write gate would refuse it.
      applyPermissionModeForTab(set, get, tabId, 'plan', 'bench_verification_analysis')

      // Role + lock BEFORE the machine prompt goes in, same ordering
      // openConflictAssist uses and for the same reason: a fast completion
      // could otherwise race ahead of the tagging and be missed by the
      // auto-fix lifecycle's close/retain decision.
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, tabRole: 'verification-analysis' as const, inputLocked: true } : t)),
      }))

      get().submit(tabId, prompt, { source: 'machine' })

      rInfo('bench.verification', 'analysis prompt submitted', {
        repo_path: repoPath,
        source_branch: sourceBranch,
        tab_id: tabId.slice(0, 8),
        model: tier.model,
        replayed_members: replayedMembers.length,
      })
      return tabId
    },

    benchDiscardVerificationRecordings: async (repoPath, sourceBranch, branchNames) => {
      rInfo('bench.verification', 'discard recordings requested', {
        repo_path: repoPath, source_branch: sourceBranch, branches: branchNames,
      })
      const result: BenchAssembleResult & { forgottenCount?: number } =
        await window.ion.benchDiscardVerificationRecordings(repoPath, sourceBranch, branchNames)
      if (!result.ok) {
        rWarn('bench.verification', 'discard recordings failed', { error: result.error ?? '' })
      } else {
        rInfo('bench.verification', 'discard recordings completed', {
          forgotten_count: result.forgottenCount ?? 0,
          outcome: result.workspace?.lastAssembly ?? 'unknown',
        })
      }
      await get().refreshBench(repoPath)
      return result
    },
  }
}
