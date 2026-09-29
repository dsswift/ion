/**
 * TransferDestinationFields — the dialog's choices, top to bottom: what
 * moves, where to, which project it lands in, and, inside that project,
 * which worktree and from which branch.
 *
 * Each field appears only when it is a real choice. "What moves" is asked
 * only of a worktree conversation; the Worktree field only of a project git
 * can read; From branch only when a new worktree is being cut. A whole
 * worktree carries its own checkout, so none of the landing fields apply to
 * it.
 */
import React from 'react'
import { Desktop, Folder, Globe, GitBranch, Stack, ChatCircle, Plus } from '@phosphor-icons/react'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import type { EnvironmentProject } from '@ion/shared/types-environment-admin'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { TransferSelect, type TransferSelectOption } from './TransferSelect'
import { projectNameFor } from './plain-destination'
import { CHECKOUT_VALUE, NEW_WORKTREE_VALUE, offersWorktrees, parseWorktreeChoice, worktreeChoiceValue } from './landing-choice'
import type { TransferMode, TransferPreflightState } from './useTransferPreflight'
import type { TransferLandingState } from './useTransferLanding'
import { useColors } from '../../theme'

export interface TransferDestinationFieldsProps {
  mode: TransferMode
  onModeChange(mode: TransferMode): void
  /** Other conversations in the conversation's worktree; null when it has no worktree. */
  worktreeSiblingCount: number | null
  targets: readonly EnvironmentCatalogEntry[]
  sourceEnvironmentId: string
  targetEnvironmentId: string
  onTargetChange(id: string): void
  targetLabel: string
  targetProjects: readonly EnvironmentProject[]
  preflight: TransferPreflightState
  landing: TransferLandingState
  /** The landing is exactly where the conversation already lives. */
  landsWhereItIs: boolean
  onOpenChange(open: boolean): void
}

function environmentOption(entry: EnvironmentCatalogEntry, sourceEnvironmentId: string): TransferSelectOption {
  const isLocal = entry.id === LOCAL_ENVIRONMENT_ID
  return {
    value: entry.id,
    label: entry.label,
    // The machine the conversation is on is a target too: moving it into
    // another checkout or worktree here.
    detail: entry.id === sourceEnvironmentId ? 'Where it is now' : isLocal ? 'This machine' : 'Another machine',
    icon: isLocal ? <Desktop size={15} /> : <Globe size={15} />,
  }
}

export function TransferDestinationFields(props: TransferDestinationFieldsProps): React.JSX.Element {
  const colors = useColors()
  const { mode, preflight, landing, targetLabel, onOpenChange } = props
  const projectOption = (dir: string, section?: string): TransferSelectOption => ({
    value: dir, label: projectNameFor(dir, props.targetProjects), detail: dir, icon: <Folder size={15} />, ...(section ? { section } : {}),
  })
  // The match first, then everything else under its own heading: a match
  // narrows the default, never the menu.
  const projectOptions = [
    ...preflight.destinationMatches.map((dir) => projectOption(dir)),
    ...preflight.destinationOthers.map((dir) => projectOption(dir, preflight.destinationMatches.length > 0 ? 'Other projects' : undefined)),
  ]
  const movesAlone = mode === 'conversation'
  const options = landing.options

  return (
    <>
      {props.worktreeSiblingCount !== null && (
        <TransferSelect
          label="What moves"
          heading="Move"
          value={mode}
          placeholder="Choose what moves…"
          options={[
            { value: 'conversation', label: 'Just this conversation', detail: 'The worktree and its other conversations stay here', icon: <ChatCircle size={15} /> },
            {
              value: 'worktree',
              label: 'The whole worktree',
              detail: props.worktreeSiblingCount > 0 ? `${props.worktreeSiblingCount + 1} conversations and the checkout` : 'This conversation and the checkout',
              icon: <Stack size={15} />,
            },
          ]}
          onChange={(value) => props.onModeChange(value === 'worktree' ? 'worktree' : 'conversation')}
          onOpenChange={onOpenChange}
        />
      )}
      <TransferSelect
        label="Target environment"
        heading="Move it to"
        value={props.targetEnvironmentId}
        placeholder="Choose an environment…"
        options={props.targets.map((entry) => environmentOption(entry, props.sourceEnvironmentId))}
        onChange={props.onTargetChange}
        onOpenChange={onOpenChange}
      />
      {movesAlone && projectOptions.length > 0 && (
        <TransferSelect
          label="Lands in"
          heading={`Projects on ${targetLabel}`}
          value={preflight.destinationDirectory}
          placeholder="Choose where it lands…"
          options={projectOptions}
          // Invalid until something is chosen: a conversation is filed
          // under its directory, so it cannot move without one.
          invalid={!preflight.destinationDirectory && !preflight.loading}
          invalidMessage={`Pick the project on ${targetLabel} this conversation belongs in.`}
          onChange={preflight.setDestinationDirectory}
          onOpenChange={onOpenChange}
        />
      )}
      {movesAlone && preflight.destinationDirectory && offersWorktrees(options) && options && (
        <TransferSelect
          label="Worktree"
          heading={`In ${projectNameFor(preflight.destinationDirectory, props.targetProjects)}`}
          value={worktreeChoiceValue(landing.choice)}
          placeholder="Choose a worktree…"
          options={[
            { value: CHECKOUT_VALUE, label: 'Source checkout', detail: options.currentBranch ? `On ${options.currentBranch}` : preflight.destinationDirectory, icon: <Folder size={15} /> },
            { value: NEW_WORKTREE_VALUE, label: 'New worktree', detail: 'Cut a fresh one for this conversation', icon: <Plus size={15} /> },
            ...options.worktrees.map((wt) => ({ value: wt.worktreePath, label: wt.title || wt.branchName, detail: wt.title ? wt.branchName : wt.worktreePath, icon: <GitBranch size={15} />, section: 'Worktrees' })),
          ]}
          invalid={props.landsWhereItIs}
          invalidMessage="The conversation already lives here. Pick another place."
          onChange={(value) => landing.setChoice(parseWorktreeChoice(value))}
          onOpenChange={onOpenChange}
        />
      )}
      {movesAlone && !offersWorktrees(options) && props.landsWhereItIs && (
        // A project with no worktrees to offer: the Lands in field is the
        // only place the operator can change, so it says so.
        <div role="alert" style={{ marginTop: -6, marginBottom: 12, fontSize: 11, color: colors.dangerFg }}>The conversation already lives here. Pick another project.</div>
      )}
      {movesAlone && landing.choice.kind === 'new' && options && (
        <TransferSelect
          label="From branch"
          heading="Cut the new worktree from"
          value={landing.baseBranch}
          placeholder="Choose a branch…"
          options={options.branches.map((branch) => ({ value: branch, label: branch, detail: branch === options.currentBranch ? 'The checkout is on this branch' : undefined, icon: <GitBranch size={15} /> }))}
          invalid={!landing.baseBranch}
          invalidMessage="Pick the branch the new worktree starts from."
          onChange={landing.setBaseBranch}
          onOpenChange={onOpenChange}
        />
      )}
    </>
  )
}
