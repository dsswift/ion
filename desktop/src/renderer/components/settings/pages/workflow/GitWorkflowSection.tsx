/**
 * GitWorkflowSection — how the picked server runs git for your work: GitOps
 * mode, how worktree work lands, the commit command, the saved source branch
 * per directory, and where the git file watcher stays quiet.
 */
import React, { useState } from 'react'
import { PencilSimple, Trash } from '@phosphor-icons/react'
import type { GitOpsMode, WorktreeCompletionStrategy } from '@ion/shared/types'
import { useSettingsPreferences } from '../../settings-target'
import { Button, CellText, DataList, FormGroup, FormRow, Segmented, SidePanel, Stack, StringListEditor, TextInput, ToggleRow } from '../../kit'

export const IGNORED_DIRECTORIES_EMPTY_TEXT = 'No directories ignored. The git watcher runs in every directory.'

/** A home-relative path reads shorter: `/Users/me/src` → `~/src`. */
function shortenHome(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~')
}

export function GitWorkflowSection(): React.JSX.Element {
  const gitOpsMode = useSettingsPreferences((s) => s.gitOpsMode)
  const setGitOpsMode = useSettingsPreferences((s) => s.setGitOpsMode)
  const strategy = useSettingsPreferences((s) => s.worktreeCompletionStrategy)
  const setStrategy = useSettingsPreferences((s) => s.setWorktreeCompletionStrategy)
  const skipPrTitle = useSettingsPreferences((s) => s.worktreeSkipPrTitle)
  const setSkipPrTitle = useSettingsPreferences((s) => s.setWorktreeSkipPrTitle)
  const branchDefaults = useSettingsPreferences((s) => s.worktreeBranchDefaults)
  const removeBranchDefault = useSettingsPreferences((s) => s.removeWorktreeBranchDefault)
  const commitCommand = useSettingsPreferences((s) => s.commitCommand)
  const setCommitCommand = useSettingsPreferences((s) => s.setCommitCommand)
  const ignored = useSettingsPreferences((s) => s.gitWatcherIgnoredDirectories)
  const setIgnored = useSettingsPreferences((s) => s.setGitWatcherIgnoredDirectories)
  const [ignoredOpen, setIgnoredOpen] = useState(false)
  const defaults = Object.entries(branchDefaults).map(([dir, branch]) => ({ dir, branch }))

  return (
    <Stack gap={20}>
      <FormGroup title="Git operations">
        <FormRow label="GitOps mode" anchor="gitops-mode" description="Manual: no automatic git operations. Worktrees: each new conversation gets an isolated worktree branch.">
          <Segmented<GitOpsMode> label="GitOps mode" value={gitOpsMode} onChange={setGitOpsMode} options={[{ value: 'manual', label: 'Manual' }, { value: 'worktree', label: 'Worktrees' }]} />
        </FormRow>
        <FormRow label="Completion strategy" anchor="completion" description="How worktree work goes back into the source branch, for Land and Finish work. Linear syncs first so the fast-forward is available, and refuses rather than writing a merge commit.">
          <Segmented<WorktreeCompletionStrategy> label="Completion strategy" value={strategy} onChange={setStrategy} options={[{ value: 'merge-ff', label: 'Linear (sync + ff)' }, { value: 'merge', label: 'Merge commit' }, { value: 'pr', label: 'Pull request' }]} />
        </FormRow>
        {strategy === 'pr' && (
          <ToggleRow label="Skip PR title prompt" description="Always use the generated branch name as the PR title, without asking." checked={skipPrTitle} onChange={setSkipPrTitle} />
        )}
        <FormRow label="Commit command" anchor="commit-command" description="A bash command run in the terminal instead of asking the model to commit. Leave empty for the default.">
          <TextInput aria-label="Commit command" mono width={220} value={commitCommand} onChange={(e) => setCommitCommand(e.target.value)} placeholder="e.g. commit --smart" spellCheck={false} />
        </FormRow>
        <FormRow
          label="Ignored directories"
          anchor="watcher-ignore"
          description={`${ignored.length === 0 ? 'None' : `${ignored.length} ${ignored.length === 1 ? 'directory' : 'directories'}`} where the git file watcher stays quiet. The panel still refreshes on focus and conversation switch.`}
        >
          <Button icon={PencilSimple} onClick={() => setIgnoredOpen(true)}>Edit</Button>
        </FormRow>
      </FormGroup>
      {defaults.length > 0 && (
        <DataList
          label="Branch defaults"
          title="Branch defaults"
          description="The saved source branch per directory. Remove one to see the branch picker again."
          anchor="branch-defaults"
          items={defaults}
          getKey={(d) => d.dir}
          noun={['default', 'defaults']}
          filter={(d, q) => d.dir.toLowerCase().includes(q) || d.branch.toLowerCase().includes(q)}
          showHeader
          columns={[
            { id: 'dir', header: 'Directory', render: (d) => <CellText mono>{shortenHome(d.dir)}</CellText> },
            { id: 'branch', header: 'Branch', width: 'minmax(80px, 0.6fr)', render: (d) => <CellText muted>{d.branch}</CellText> },
          ]}
          rowMenu={(d) => [{ label: 'Remove', icon: Trash, danger: true, onSelect: () => removeBranchDefault(d.dir) }]}
        />
      )}
      <SidePanel
        open={ignoredOpen}
        title="Ignored directories"
        subtitle="The git file watcher is suppressed under these paths. Supports ~ and $HOME. Default: ~/.ion"
        onClose={() => setIgnoredOpen(false)}
      >
        <StringListEditor label="Ignored directories" values={ignored} onChange={setIgnored} placeholder="e.g. ~/.ion" emptyText={IGNORED_DIRECTORIES_EMPTY_TEXT} />
      </SidePanel>
    </Stack>
  )
}
