/**
 * useTransferLanding — asks the destination what the chosen project offers
 * (`transfer.landings`) and holds the Worktree and From branch picks.
 *
 * Re-asks whenever the destination or the project changes, and resets the
 * picks when it does: a worktree on one project is meaningless on another.
 */
import { useEffect, useMemo, useState } from 'react'
import type { TransferLanding, TransferLandingOptions } from '@ion/shared/types-transfer'
import { action } from '../../host/host-instance'
import { buildLanding, defaultBaseBranch, type WorktreeChoice } from './landing-choice'
import { rInfo, rWarn } from '../../rendererLogger'

export interface TransferLandingState {
  options: TransferLandingOptions | null
  loading: boolean
  /** Why the destination could not say; the conversation can still land in the checkout. */
  error: string | null
  choice: WorktreeChoice
  setChoice(choice: WorktreeChoice): void
  baseBranch: string
  setBaseBranch(branch: string): void
  /** What the picks add up to; null while a required pick is missing. */
  landing: TransferLanding | null
}

export function useTransferLanding(
  targetEnvironmentId: string,
  projectDir: string,
  /** The branch the conversation's own worktree was cut from, when it has one. */
  conversationBase: string | null,
): TransferLandingState {
  const [options, setOptions] = useState<TransferLandingOptions | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState<WorktreeChoice>({ kind: 'checkout' })
  const [chosenBase, setChosenBase] = useState('')

  useEffect(() => {
    setChoice({ kind: 'checkout' })
    setChosenBase('')
    setOptions(null)
    setError(null)
    if (!targetEnvironmentId || !projectDir) return
    let cancelled = false
    setLoading(true)
    action(targetEnvironmentId, 'transfer.landings', [{ projectDir }])
      .then((value) => {
        if (cancelled) return
        const answer = value as TransferLandingOptions
        setOptions(answer)
        rInfo('transfer.landing', 'destination answered', { target_environment_id: targetEnvironmentId, project_dir: projectDir, worktree_count: answer.worktrees.length, branch_count: answer.branches.length })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        rWarn('transfer.landing', 'landing options failed', { target_environment_id: targetEnvironmentId, project_dir: projectDir, error: String(err) })
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [targetEnvironmentId, projectDir])

  const baseBranch = chosenBase || defaultBaseBranch(options, conversationBase)
  const landing = useMemo(() => buildLanding(projectDir, choice, baseBranch), [projectDir, choice, baseBranch])

  return { options, loading, error, choice, setChoice, baseBranch, setBaseBranch: setChosenBase, landing }
}
