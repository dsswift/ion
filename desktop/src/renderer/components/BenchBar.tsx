/**
 * BenchBar — what the bench IS, above the rows that make it up.
 *
 * ── Why a bar and not a section ─────────────────────────────────────────────
 * The bench used to be a second list: its own pane, its own header, its own
 * member rows. But a member is a worktree, so an enrolled worktree appeared
 * twice in one panel with two vocabularies describing it. The rows moved into
 * the single worktree list, and what remains here is only what is genuinely
 * BENCH-scoped rather than per-worktree: which branch it builds on, how far
 * that base has drifted, when it last built, and the three verbs that act on
 * the whole bench — talk to it, get a shell in it, assemble it.
 *
 * The workspace selector stays for a repo integrating into more than one
 * feature branch, because it decides which membership the rows below display.
 */
import React from 'react'
import { ArrowsClockwise, CircleNotch, Terminal, X } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { Tooltip } from './git/Tooltip'
import { HoverCard } from './git/HoverCard'
import { WorktreeConversationsCard } from './WorktreeConversationsCard'
import { describeOpenConversations, type DirConversation } from '../../shared/worktree-conversations'
import type { IntegrationWorkspace, IntegrationMember } from '../../shared/types'
import type { OrphanMembership } from '../../shared/worktree-list'

/** Human-readable age of the last assembly. */
function relativeTime(ms: number): string {
  if (!ms) return 'never assembled'
  const secs = Math.round((Date.now() - ms) / 1000)
  if (secs < 60) return 'assembled just now'
  if (secs < 3600) return `assembled ${Math.round(secs / 60)}m ago`
  if (secs < 86400) return `assembled ${Math.round(secs / 3600)}h ago`
  return `assembled ${Math.round(secs / 86400)}d ago`
}

export interface BenchBarProps {
  workspaces: readonly IntegrationWorkspace[]
  active: IntegrationWorkspace
  /** Conversations open in the BENCH directory, distinct from its members'. */
  benchConversations: readonly DirConversation[]
  /** True when the source branch has moved past the bench's base. */
  baseDrifted: boolean
  /** Memberships whose worktree is gone: rendered as a footnote, never as rows. */
  orphans: readonly OrphanMembership[]
  /** Members absorbed by the last assembly, for the dismissible notice. */
  absorbed: readonly IntegrationMember[]
  /** How many enrolled worktrees hold work newer than their pin. */
  behindCount: number
  /**
   * True when the bench's dedicated terminal tab is already open, so the
   * tooltip can say "go to" rather than "open". One tab per bench, so this is a
   * boolean rather than a count.
   */
  benchTerminalOpen: boolean
  busy: string | null
  onSelectWorkspace(sourceBranch: string): void
  onOpenTerminal(): void
  onAssemble(): void
  onDismissAbsorbed(): void
}

export function BenchBar(props: BenchBarProps): React.JSX.Element {
  const colors = useColors()
  const { workspaces, active, baseDrifted, busy, behindCount } = props
  const openLabel = describeOpenConversations(props.benchConversations)

  return (
    <div style={{ flexShrink: 0 }}>
      {/* Only when the repo integrates into more than one feature branch.
          Merging two benches into one list would be meaningless -- they build
          different bases. */}
      {workspaces.length > 1 && (
        <div style={{ display: 'flex', gap: 3, padding: '3px 6px 0', flexWrap: 'wrap' }}>
          {workspaces.map((ws) => (
            <button
              key={ws.sourceBranch}
              data-testid={`bench-workspace-${ws.sourceBranch}`}
              onClick={() => props.onSelectWorkspace(ws.sourceBranch)}
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 6px' }}>
        {/* The bench branch is a machine string like every other identifier
            here, so it gets the same hover treatment: what is layered on it and
            which conversations are running in it. */}
        <HoverCard
          maxWidth={320}
          fallbackTitle={`Bench branch ${active.benchBranch}`}
          content={
            <WorktreeConversationsCard
              heading={`Bench · ${active.sourceBranch}`}
              identifiers={[
                { label: 'branch', value: active.benchBranch },
                { label: 'base', value: active.baseSha ? active.baseSha.slice(0, 7) : 'never built' },
                { label: 'members', value: `${active.members.filter((m) => m.enabled).length} enabled of ${active.members.length}` },
                { label: 'path', value: active.benchPath },
              ]}
              conversations={props.benchConversations}
              emptyNoun="bench"
            />
          }
        >
          <span style={{ fontSize: 10, color: colors.textSecondary, fontFamily: 'monospace' }}>
            {active.benchBranch}
          </span>
        </HoverCard>
        {openLabel && (
          <span data-testid="bench-open-label" style={{ fontSize: 9, color: colors.accent, flexShrink: 0 }}>
            {openLabel}
          </span>
        )}
        {active.baseSha && (
          <Tooltip text={baseDrifted
            ? `${active.sourceBranch} has moved since this assembly — assemble to pick it up`
            : `Assembled from ${active.sourceBranch}`}>
            <span style={{ fontSize: 9, color: baseDrifted ? colors.warningFg : colors.textTertiary }}>
              base {active.baseSha.slice(0, 7)}{baseDrifted ? ' · moved' : ''}
            </span>
          </Tooltip>
        )}
        {/* The outcome, not just the age. `failed` means the bench was wiped
            to an empty tree (atomic assembly) — an operator who switches to it
            and finds nothing must have been told why HERE, not by the empty
            directory. Absent (legacy record) falls back to the age alone. */}
        {active.lastAssembly === 'failed' ? (
          <Tooltip text={active.lastAssemblyError ?? 'The last assembly failed and the bench is empty until the conflict is resolved.'}>
            <span data-testid="bench-assembly-failed" style={{ fontSize: 9, color: colors.dangerFg }}>
              assembly failed
            </span>
          </Tooltip>
        ) : (
          <span style={{ fontSize: 9, color: colors.textTertiary }}>{relativeTime(active.lastBuiltAt)}</span>
        )}

        <span style={{ flex: 1 }} />

        {/* Open-conversation is deliberately HIDDEN, not removed. A
            conversation in the bench is a gateway to doing development work
            there, and bench work is destroyed by the next assembly — the
            terminal button covers the legitimate need (build, run, test) and
            fix conversations belong in the member worktree that owns the
            file. The store action, IPC, and wire command all still work:
            the auto-fix resolve flow creates bench conversations, and
            navigation to an existing one (hover card, open label) stays. If
            a real use for operator-initiated bench conversations appears,
            re-render the button here — the plumbing is intact. */}

        {/* Building and testing in the bench is shell work, and the generic
            new-terminal path stacks a fresh tab per press. This always lands on
            the SAME tab for this bench; the terminal strip's `+` multiplexes
            inside it. */}
        <Tooltip text={props.benchTerminalOpen
          ? 'Go to the bench terminal'
          : 'Open the bench terminal to build and test'}>
          <button
            data-testid="bench-open-terminal"
            onClick={props.onOpenTerminal}
            disabled={busy !== null}
            style={{
              display: 'inline-flex', alignItems: 'center', padding: 2,
              background: 'transparent', border: 'none',
              color: props.benchTerminalOpen ? colors.accent : colors.textTertiary,
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            {busy === 'terminal' ? <CircleNotch size={12} className="animate-spin" /> : <Terminal size={12} />}
          </button>
        </Tooltip>

        <Tooltip text={behindCount > 0
          ? `Update ${behindCount} member${behindCount === 1 ? '' : 's'} holding newer work, then assemble`
          : 'Assemble from the current pins'}>          <button
            data-testid="bench-assemble"
            onClick={props.onAssemble}
            disabled={busy !== null}
            style={{
              display: 'inline-flex', alignItems: 'center', padding: 2,
              background: 'transparent', border: 'none',
              color: behindCount > 0 ? colors.warningFg : colors.textTertiary,
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            {busy === 'assemble' ? <CircleNotch size={12} className="animate-spin" /> : <ArrowsClockwise size={12} />}
          </button>
        </Tooltip>
      </div>

      {props.absorbed.length > 0 && (
        <div
          data-testid="bench-absorbed-notice"
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 4,
            padding: '3px 8px', fontSize: 9, color: colors.textSecondary,
          }}
        >
          <span style={{ flex: 1 }}>
            {props.absorbed.map((m) => m.branchName).join(', ')} landed into {active.sourceBranch} and{' '}
            {props.absorbed.length === 1 ? 'is' : 'are'} now part of the base.
          </span>
          <button
            data-testid="bench-absorbed-dismiss"
            onClick={props.onDismissAbsorbed}
            style={{
              display: 'inline-flex', alignItems: 'center', padding: 0,
              background: 'transparent', border: 'none',
              color: colors.textTertiary, cursor: 'pointer', flexShrink: 0,
            }}
          >
            <X size={9} />
          </button>
        </div>
      )}

      {/* Memberships with no worktree left. They have no directory to open, so
          a row would offer verbs that cannot run -- but letting them vanish is
          what made absorption read as the bench eating a worktree. */}
      {props.orphans.length > 0 && (
        <div
          data-testid="bench-orphans"
          style={{ padding: '2px 8px', fontSize: 9, color: colors.textTertiary }}
        >
          {props.orphans.length} member{props.orphans.length === 1 ? '' : 's'}{' '}
          {props.orphans.length === 1 ? 'has' : 'have'} no worktree any more:{' '}
          {props.orphans.map((o) => o.membership.branchName).join(', ')}
        </div>
      )}
    </div>
  )
}
