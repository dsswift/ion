/**
 * IntegrationSection — the bench: what is integrated, what is stale, and the
 * way in to test it.
 *
 * ── The model on screen ─────────────────────────────────────────────────────
 * The bench is a rebuildable worktree whose contents are a deterministic
 * function of (feature-branch tip, ordered pinned members). Nothing here moves
 * on its own: staleness is reported, integration is an explicit act. That is
 * what lets the operator squash a long stream of commits and land on their own
 * schedule without the bench pulling in a half-finished change underneath them.
 *
 * "Open bench conversation" is the button that makes the bench usable: run the
 * build, diagnose a cross-feature failure, discuss — without ever typing the
 * `~/.ion/integration/...` path.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { ArrowsClockwise, ChatCircle, CircleNotch, Plus } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { Tooltip } from './git/Tooltip'
import { BenchMemberRow } from './BenchMemberRow'
import { rError } from '../rendererLogger'
import type { IntegrationWorkspace } from '../../shared/types'

function relativeTime(ms: number): string {
  if (!ms) return 'never built'
  const secs = Math.round((Date.now() - ms) / 1000)
  if (secs < 60) return 'built just now'
  if (secs < 3600) return `built ${Math.round(secs / 60)}m ago`
  if (secs < 86400) return `built ${Math.round(secs / 3600)}h ago`
  return `built ${Math.round(secs / 86400)}d ago`
}

export function IntegrationSection({
  repoPath,
  refreshKey,
}: {
  repoPath: string
  refreshKey: number
}): React.JSX.Element {
  const colors = useColors()
  const workspaces = useSessionStore((s) => s.benchWorkspaces.get(repoPath))
  const tips = useSessionStore((s) => s.benchSourceTips.get(repoPath))
  const inventory = useSessionStore((s) => s.worktreeInventory.get(repoPath))
  const [busy, setBusy] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void useSessionStore.getState().refreshBench(repoPath)
  }, [repoPath])

  useEffect(() => { refresh() }, [refresh, refreshKey])

  const list = workspaces ?? []
  // Default to the first workspace; a repo integrating into two feature
  // branches gets a selector rather than a merged, meaningless list.
  const active: IntegrationWorkspace | undefined =
    list.find((w) => w.sourceBranch === selected) ?? list[0]

  if (list.length === 0) {
    // Name the actual branch when we know it, so the copy is concrete rather
    // than generic.
    const sourceBranchHint = (inventory ?? []).find((w) => w.sourceBranch)?.sourceBranch
      ?? 'your feature branch'
    return (
      <div style={{ padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 10, color: colors.textTertiary }}>
          No integration bench yet.
        </span>
        {/* Describes what the bench IS and names the exact control that
            creates one. The earlier copy pointed at an "add to bench" action
            that did not exist, which made this a dead end. */}
        <span style={{ fontSize: 9, color: colors.textTertiary, lineHeight: 1.4 }}>
          A bench layers several worktrees onto {sourceBranchHint} so you can build and
          test them together before any of them lands. It appears here as soon as
          you add a worktree: use <strong>Add to integration bench</strong> in a
          worktree&apos;s row menu above.
        </span>
      </div>
    )
  }

  if (!active) return <div />

  const staleCount = active.members.filter((m) => m.status === 'stale').length
  const conflictCount = active.members.filter((m) => m.status === 'conflicted').length
  const baseDrifted = !!tips?.[active.sourceBranch] && tips[active.sourceBranch] !== active.baseSha

  const run = (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    void fn()
      // Static msg with the operation as a FIELD (ADR-019): an interpolated
      // message is unqueryable in the log store.
      .catch((err) => rError('bench.section', 'bench operation failed', { operation: key, error: String(err) }))
      .finally(() => setBusy(null))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
      {/* Workspace selector, only when the repo integrates into more than one
          feature branch. Merging them into one list would be meaningless. */}
      {list.length > 1 && (
        <div style={{ display: 'flex', gap: 3, padding: '3px 6px 0', flexWrap: 'wrap' }}>
          {list.map((ws) => (
            <button
              key={ws.sourceBranch}
              onClick={() => setSelected(ws.sourceBranch)}
              style={{
                fontSize: 9, padding: '1px 5px', borderRadius: 3, cursor: 'pointer',
                border: `1px solid ${ws.sourceBranch === active.sourceBranch ? colors.accent : colors.containerBorder}`,
                background: ws.sourceBranch === active.sourceBranch ? colors.accentLight : 'transparent',
                color: ws.sourceBranch === active.sourceBranch ? colors.accent : colors.textSecondary,
              }}
            >
              {ws.sourceBranch}
            </button>
          ))}
        </div>
      )}

      {/* Bench header: what it is built from, and how current that is. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 6px' }}>
        <span style={{ fontSize: 10, color: colors.textSecondary, fontFamily: 'monospace' }}>
          {active.benchBranch}
        </span>
        {active.baseSha && (
          <Tooltip text={baseDrifted
            ? `${active.sourceBranch} has moved since this build — rebuild to pick it up`
            : `Built from ${active.sourceBranch}`}>
            <span style={{ fontSize: 9, color: baseDrifted ? colors.warningFg : colors.textTertiary }}>
              base {active.baseSha.slice(0, 7)}{baseDrifted ? ' ·  moved' : ''}
            </span>
          </Tooltip>
        )}
        <span style={{ fontSize: 9, color: colors.textTertiary }}>{relativeTime(active.lastBuiltAt)}</span>

        <span style={{ flex: 1 }} />

        <Tooltip text="Open a conversation in the bench to build and test">
          <button
            data-testid="bench-open-conversation"
            onClick={() => run('open', async () => {
              await useSessionStore.getState().openBenchConversation(repoPath, active.sourceBranch)
            })}
            disabled={busy !== null}
            style={{
              display: 'inline-flex', alignItems: 'center', padding: 2,
              background: 'transparent', border: 'none',
              color: colors.accent, cursor: busy ? 'default' : 'pointer',
            }}
          >
            {busy === 'open' ? <CircleNotch size={12} className="animate-spin" /> : <ChatCircle size={12} />}
          </button>
        </Tooltip>

        <Tooltip text={staleCount > 0
          ? `Update ${staleCount} stale member${staleCount === 1 ? '' : ''} and rebuild`
          : 'Rebuild from the current pins'}>
          <button
            data-testid="bench-rebuild"
            onClick={() => run('rebuild', async () => {
              const store = useSessionStore.getState()
              // Update-all when something is stale, plain rebuild otherwise.
              // Rebuild alone never advances a pin, so it is always safe.
              await (staleCount > 0
                ? store.benchUpdateAll(repoPath, active.sourceBranch)
                : store.benchRebuild(repoPath, active.sourceBranch))
            })}
            disabled={busy !== null}
            style={{
              display: 'inline-flex', alignItems: 'center', padding: 2,
              background: 'transparent', border: 'none',
              color: staleCount > 0 ? colors.warningFg : colors.textTertiary,
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            {busy === 'rebuild' ? <CircleNotch size={12} className="animate-spin" /> : <ArrowsClockwise size={12} />}
          </button>
        </Tooltip>
      </div>

      {conflictCount > 0 && (
        <div style={{ padding: '2px 8px', fontSize: 9, color: colors.dangerFg }}>
          {conflictCount} member{conflictCount === 1 ? '' : 's'} could not be merged and {conflictCount === 1 ? 'was' : 'were'} skipped.
        </div>
      )}

      {active.members.length === 0 ? (
        <div style={{ padding: '4px 8px', fontSize: 10, color: colors.textTertiary }}>
          No members yet. Add a worktree below to layer it onto {active.sourceBranch}.
        </div>
      ) : (
        active.members.map((m) => (
          <BenchMemberRow
            key={m.worktreePath}
            member={m}
            busy={busy === m.worktreePath}
            onToggleEnabled={() => run(m.worktreePath, async () => {
              await useSessionStore.getState()
                .benchSetEnabled(repoPath, active.sourceBranch, m.worktreePath, !m.enabled)
            })}
            onUpdate={() => run(m.worktreePath, async () => {
              await useSessionStore.getState()
                .benchUpdateMember(repoPath, active.sourceBranch, m.worktreePath)
            })}
            onRemove={() => run(m.worktreePath, async () => {
              await useSessionStore.getState()
                .benchRemoveMember(repoPath, active.sourceBranch, m.worktreePath)
            })}
            onOpen={() => run(m.worktreePath, async () => {
              await useSessionStore.getState().openWorktreeConversation(m.worktreePath)
            })}
          />
        ))
      )}

      {/* Add member: only worktrees not already enrolled, and only ones whose
          source branch matches this bench — a worktree cut from another branch
          belongs to that branch's bench. */}
      <AddMemberPicker
        repoPath={repoPath}
        workspace={active}
        candidates={(inventory ?? []).filter((w) =>
          w.sourceBranch === active.sourceBranch &&
          !active.members.some((m) => m.worktreePath === w.worktreePath))}
        onAdded={refresh}
      />
    </div>
  )
}

function AddMemberPicker({
  repoPath,
  workspace,
  candidates,
  onAdded,
}: {
  repoPath: string
  workspace: IntegrationWorkspace
  candidates: Array<{ worktreePath: string; branchName: string; label: string }>
  onAdded(): void
}): React.JSX.Element | null {
  const colors = useColors()
  const [open, setOpen] = useState(false)

  if (candidates.length === 0) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <button
        data-testid="bench-add-member"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px',
          background: 'transparent', border: 'none', color: colors.textSecondary,
          fontSize: 10, cursor: 'pointer', textAlign: 'left',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.surfaceHover }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      >
        <Plus size={10} />
        <span>Add worktree to bench</span>
      </button>
      {open && candidates.map((c) => (
        <button
          key={c.worktreePath}
          onClick={() => {
            setOpen(false)
            void useSessionStore.getState()
              .benchAddMember(repoPath, workspace.sourceBranch, c.worktreePath, c.branchName)
              .then(onAdded)
              .catch((err) => rError('bench.section', 'add member failed', { error: String(err) }))
          }}
          style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '3px 6px 3px 20px',
            background: 'transparent', border: 'none', color: colors.textPrimary,
            fontSize: 10, cursor: 'pointer', textAlign: 'left',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.surfaceHover }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        >
          <span>{c.label}</span>
          <span style={{ fontSize: 9, color: colors.textTertiary }}>{c.branchName}</span>
        </button>
      ))}
    </div>
  )
}
