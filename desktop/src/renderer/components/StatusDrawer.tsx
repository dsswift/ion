/**
 * StatusDrawer — right-side panel toggled by the ⓘ button in StatusBar.
 *
 * Anchored left:100% of the content column (same GitPanel pattern in App.tsx).
 * Sections:
 *   1. Session info  — copyable ID, conversation-lifetime turns, duration, sessionVersion.
 *   2. Context       — usage bar + cost + state from engineUsage / statusFields.
 *   3. Running Dispatches — flat, live, running-only list across all tiers.
 *   4. Context Breakdown — proportion graph + grouped/sorted rows + cache annotation.
 *
 * Redesign (plan minty-grinning-cocoa.md C1–C6):
 *   - Model section removed (C1) — duplicated by StatusBarModelPicker.
 *   - Breakdown is its own scroll region within the capped panel (C2).
 *   - Rows grouped by Kind in fixed order, sorted desc within bucket (C3).
 *   - Proportion graph above list: one horizontal bar segmented by bucket (C4).
 *   - Cache annotation as non-additive "of which, cached" line (C5).
 *   - Session ID (copyable), conversation-lifetime turns, durationMs, sessionVersion (C6).
 */

import React, { useMemo, useCallback, useState } from 'react'
import { X, CircleNotch, Copy, Check } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useShallow } from 'zustand/shallow'
import { useColors } from '../theme'
import { meta, getDispatches, buildBreadcrumbStack } from './agent-panel-helpers'
import { AgentDetailPanel } from './AgentDetailPanel'
import type { AgentStateUpdate } from '../../shared/types'
import type { ContextBreakdownCategory, DispatchInfo, ModelBreakdown } from '../../shared/types-engine'

// ─── Tier badge ──────────────────────────────────────────────────────────────

type Tier = 'exact' | 'local' | 'approximate'

const TIER_LABEL: Record<Tier, string> = { exact: 'exact', local: 'bpe', approximate: '~' }
const TIER_TITLE: Record<Tier, string> = {
  exact: 'Provider native count-tokens endpoint',
  local: 'Local BPE tokenizer (tiktoken)',
  approximate: 'Character/4 heuristic (fallback)',
}

function TierBadge({ tier, colors }: { tier: Tier; colors: ReturnType<typeof useColors> }) {
  const bg = tier === 'exact' ? colors.accentLight : tier === 'local' ? colors.surfaceActive : colors.surfaceHover
  const fg = tier === 'exact' ? colors.accent : tier === 'local' ? colors.textTertiary : colors.textMuted
  return (
    <span title={TIER_TITLE[tier]} style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: bg, color: fg, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
      {TIER_LABEL[tier]}
    </span>
  )
}

// ─── Usage bar ───────────────────────────────────────────────────────────────

function UsageBar({ percent, colors }: { percent: number; colors: ReturnType<typeof useColors> }) {
  const clamped = Math.max(0, Math.min(100, percent))
  const barColor = clamped >= 90 ? colors.statusError : clamped >= 70 ? '#d4882a' : colors.accent
  return (
    <div style={{ height: 4, borderRadius: 2, background: colors.containerBorder, overflow: 'hidden', flexShrink: 0 }}>
      <div style={{ height: '100%', width: `${clamped}%`, background: barColor, borderRadius: 2, transition: 'width 0.4s ease' }} />
    </div>
  )
}

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ label, colors }: { label: string; colors: ReturnType<typeof useColors> }) {
  return (
    <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: colors.textTertiary, paddingBottom: 6, borderBottom: `1px solid ${colors.containerBorder}`, marginBottom: 8 }}>
      {label}
    </div>
  )
}

// ─── Elapsed display ─────────────────────────────────────────────────────────

function elapsedStr(startTime: number | undefined): string {
  if (!startTime) return ''
  const s = Math.floor((Date.now() - startTime) / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`
}

// ─── Kind ordering + colors for proportion graph ──────────────────────────────

// Fixed display order for kind buckets (C3). Maps engine kind values to display labels.
const KIND_ORDER = ['system_prompt', 'tools', 'conversation', 'file', 'unaccounted'] as const
type KindKey = (typeof KIND_ORDER)[number]

const KIND_LABEL: Record<KindKey, string> = {
  system_prompt: 'System Prompt',
  tools: 'Tools',
  conversation: 'Conversation',
  file: 'Files',
  unaccounted: 'Unaccounted',
}

// Colors for the proportion graph segments (per kind bucket). Matches the
// spirit of the reference ContextVisualization.tsx color palette.
const KIND_COLOR: Record<KindKey, string> = {
  system_prompt: '#7c6af7',
  tools: '#3b82f6',
  conversation: '#22c55e',
  file: '#f59e0b',
  unaccounted: '#6b7280',
}

function kindKey(kind: string): KindKey {
  if (kind === 'system_prompt' || kind === 'system-prompt') return 'system_prompt'
  if (kind === 'tools' || kind === 'tool') return 'tools'
  if (kind === 'conversation' || kind === 'message') return 'conversation'
  if (kind === 'file') return 'file'
  return 'unaccounted'
}

// ─── Proportion graph (C4) ────────────────────────────────────────────────────

interface GraphSegment { kind: KindKey; tokens: number; pct: number }

function ProportionGraph({ segments, contextWindow, colors }: {
  segments: GraphSegment[]
  contextWindow: number
  colors: ReturnType<typeof useColors>
}) {
  const usedPct = segments.reduce((s, g) => s + g.pct, 0)
  const freePct = Math.max(0, 100 - usedPct)
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: colors.surfaceHover }}>
        {segments.map((seg) => seg.pct > 0 && (
          <div key={seg.kind} title={`${KIND_LABEL[seg.kind]}: ${seg.tokens.toLocaleString()} tokens (${seg.pct.toFixed(1)}%)`}
            style={{ width: `${seg.pct}%`, background: KIND_COLOR[seg.kind], transition: 'width 0.4s ease' }} />
        ))}
        {freePct > 0 && (
          <div title={`Free: ${(freePct / 100 * contextWindow).toFixed(0)} tokens (${freePct.toFixed(1)}%)`}
            style={{ flex: 1, background: 'transparent' }} />
        )}
      </div>
      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 8px', marginTop: 4 }}>
        {segments.filter((s) => s.pct > 0).map((seg) => (
          <span key={seg.kind} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9, color: colors.textTertiary }}>
            <span style={{ width: 6, height: 6, borderRadius: 1, background: KIND_COLOR[seg.kind], flexShrink: 0, display: 'inline-block' }} />
            {KIND_LABEL[seg.kind]}
          </span>
        ))}
        {freePct > 0.5 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9, color: colors.textMuted }}>
            <span style={{ width: 6, height: 6, borderRadius: 1, background: colors.surfaceActive, flexShrink: 0, display: 'inline-block' }} />
            Free
          </span>
        )}
      </div>
    </div>
  )
}

// ─── Grouped breakdown rows (C3) ─────────────────────────────────────────────

function groupCategories(categories: ContextBreakdownCategory[]): Map<KindKey, ContextBreakdownCategory[]> {
  const map = new Map<KindKey, ContextBreakdownCategory[]>()
  for (const cat of categories) {
    const k = kindKey(cat.kind)
    const existing = map.get(k) ?? []
    existing.push(cat)
    map.set(k, existing)
  }
  // Sort within each bucket: descending by tokens
  for (const [k, items] of map) {
    map.set(k, items.slice().sort((a, b) => b.tokens - a.tokens))
  }
  // Return in fixed kind order (only present buckets)
  const ordered = new Map<KindKey, ContextBreakdownCategory[]>()
  for (const k of KIND_ORDER) {
    if (map.has(k)) ordered.set(k, map.get(k)!)
  }
  return ordered
}

function CategoryRow({ cat, contextWindow, colors, indent }: {
  cat: ContextBreakdownCategory
  contextWindow: number
  colors: ReturnType<typeof useColors>
  indent?: boolean
}) {
  const pct = contextWindow > 0 ? Math.round((cat.tokens / contextWindow) * 100) : 0
  const label = cat.path ? cat.path.split('/').slice(-2).join('/') : cat.name
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingLeft: indent ? 12 : 0 }}>
      {indent && <span style={{ fontSize: 9, color: colors.textMuted, flexShrink: 0 }}>↳</span>}
      <span style={{ fontSize: 10, color: colors.textSecondary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cat.path || cat.name}>
        {label}
      </span>
      <span style={{ fontSize: 10, color: colors.textPrimary, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
        {cat.tokens.toLocaleString()}
      </span>
      <span style={{ fontSize: 9, color: colors.textTertiary, flexShrink: 0, minWidth: 28, textAlign: 'right' }}>
        {pct}%
      </span>
      <TierBadge tier={cat.tier as Tier} colors={colors} />
    </div>
  )
}

// ─── Copy button ─────────────────────────────────────────────────────────────

function CopyButton({ value, label, colors }: { value: string; label: string; colors: ReturnType<typeof useColors> }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [value])
  return (
    <button onClick={handleCopy} title={`Copy ${label}`}
      style={{ display: 'flex', alignItems: 'center', gap: 3, background: 'transparent', border: 'none', cursor: 'pointer', color: copied ? colors.accent : colors.textTertiary, padding: '1px 4px', borderRadius: 3 }}>
      {copied ? <Check size={10} /> : <Copy size={10} />}
      <span style={{ fontSize: 9 }}>{copied ? 'copied' : label}</span>
    </button>
  )
}

// ─── Per-model cost breakdown rows ────────────────────────────────────────────

// Renders the per-model cost rows under the aggregate cost, split into two
// groups: the viewing conversation's OWN spend (isSelf rows) under a
// "This conversation" sub-label, and the dispatch spend (non-self rows) under
// a "Dispatches" sub-label. When there are no dispatch rows, only the self group
// renders (no "Dispatches" header). This makes explicit that e.g. an opus row
// marked $397 is the viewing conversation's lifetime cost, not one dispatch.
function ModelBreakdownRows({ rows, colors }: { rows: ModelBreakdown[]; colors: ReturnType<typeof useColors> }) {
  const selfRows = rows.filter((r) => r.isSelf)
  const dispatchRows = rows.filter((r) => !r.isSelf)

  const groupLabel = (label: string) => (
    <div style={{ fontSize: 8, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: colors.textMuted, paddingLeft: 10, marginTop: 2 }}>
      {label}
    </div>
  )

  const row = (mb: ModelBreakdown) => (
    <div key={`${mb.model}-${mb.isSelf ? 'self' : 'dispatch'}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingLeft: 18 }}>
      <span style={{ fontSize: 9, color: colors.textMuted, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${mb.model} — ${mb.conversations} conv`}>
        {mb.model} ({mb.conversations})
      </span>
      <span style={{ fontSize: 9, color: colors.textTertiary, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>${mb.costUsd.toFixed(4)}</span>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {selfRows.length > 0 && (
        <>
          {groupLabel('This conversation')}
          {selfRows.map(row)}
        </>
      )}
      {dispatchRows.length > 0 && (
        <>
          {groupLabel('Dispatches')}
          {dispatchRows.map(row)}
        </>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function StatusDrawer() {
  const colors = useColors()
  const closeStatusDrawer = useSessionStore((s) => s.closeStatusDrawer)
  const openDispatchPreview = useSessionStore((s) => s.openDispatchPreview)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const statusDrawerDispatchId = useSessionStore((s) => s.statusDrawerDispatchId)

  const { tab, activeInstance } = useSessionStore(
    useShallow((s) => {
      const t = s.tabs.find((x) => x.id === s.activeTabId) ?? null
      const pane = s.conversationPanes.get(s.activeTabId)
      const id = pane?.activeInstanceId || pane?.instances[0]?.id
      const inst = pane?.instances.find((i) => i.id === id) ?? null
      return { tab: t, activeInstance: inst }
    }),
  )

  const usage = useSessionStore((s) => s.engineUsage.get(activeTabId))

  const statusFields = activeInstance?.statusFields ?? null
  const agentStates: AgentStateUpdate[] = useMemo(
    () => activeInstance?.agentStates ?? [],
    [activeInstance?.agentStates],
  )
  const dispatchTelemetry = activeInstance?.dispatchTelemetry ?? []

  // Flat, running-only dispatch rows across all tiers
  const runningDispatches = useMemo(() => {
    return agentStates.flatMap((agent) => {
      if (agent.status !== 'running') return []
      const dispatches = getDispatches(agent)
      const depth = meta<number>(agent, 'dispatchDepth', 0)
      const displayName = meta<string>(agent, 'displayName', agent.name)
      const activeDispatch = dispatches.find((d) => d.status === 'running') ?? dispatches.at(-1)
      if (!activeDispatch) return []
      return [{ agent, dispatch: activeDispatch, depth, displayName }]
    })
  }, [agentStates])

  // Breadcrumb reconstruction for deep-linked dispatch
  const deepLinkData = useMemo(() => {
    if (!statusDrawerDispatchId) return null
    const targetAgent = agentStates.find((a) => getDispatches(a).some((d) => d.id === statusDrawerDispatchId))
    if (!targetAgent) return null
    const dispatches = getDispatches(targetAgent)
    const stack = buildBreadcrumbStack(statusDrawerDispatchId, agentStates)
    const dispatchIdx = Math.max(0, dispatches.findIndex((d) => d.id === statusDrawerDispatchId))
    return { agent: targetAgent, dispatches, dispatchIdx, stack: stack ?? undefined }
  }, [statusDrawerDispatchId, agentStates])

  const handleCloseDeepLink = useCallback(() => {
    useSessionStore.setState({ statusDrawerDispatchId: null })
  }, [])

  // Context breakdown cached on the instance from engine_context_breakdown events
  const contextBreakdown = activeInstance?.contextBreakdown ?? null

  const contextPercent = usage?.percent ?? statusFields?.contextPercent ?? 0
  const contextTokens = contextPercent && statusFields?.contextWindow
    ? Math.round((contextPercent / 100) * statusFields.contextWindow)
    : null
  const runCostUsd = statusFields?.runCostUsd ?? null
  const conversationCostUsd = statusFields?.conversationCostUsd ?? null
  // totalCostUsd falls back to legacy usage.cost for the message-end path
  const totalCostUsd = usage?.cost ?? runCostUsd ?? null
  const aggregateCostUsd = contextBreakdown?.aggregateCostUsd ?? conversationCostUsd ?? null
  const contextWindow = contextBreakdown?.contextWindow || statusFields?.contextWindow || null
  const state = statusFields?.state ?? null

  // Grouped breakdown + proportion graph data
  const { groupedCats, graphSegments } = useMemo(() => {
    if (!contextBreakdown?.categories?.length || !contextWindow) {
      return { groupedCats: new Map<KindKey, ContextBreakdownCategory[]>(), graphSegments: [] as GraphSegment[] }
    }
    const grouped = groupCategories(contextBreakdown.categories)
    const segments: GraphSegment[] = []
    for (const k of KIND_ORDER) {
      const cats = grouped.get(k)
      if (!cats) continue
      const total = cats.reduce((s, c) => s + c.tokens, 0)
      const pct = contextWindow > 0 ? (total / contextWindow) * 100 : 0
      if (pct > 0) segments.push({ kind: k, tokens: total, pct })
    }
    return { groupedCats: grouped, graphSegments: segments }
  }, [contextBreakdown, contextWindow])

  const hasBreakdown = contextBreakdown != null && Array.isArray(contextBreakdown.categories) && contextBreakdown.categories.length > 0

  return (
    <div
      data-ion-ui
      style={{ display: 'flex', flexDirection: 'column', background: colors.containerBg, border: `1px solid ${colors.containerBorder}`, borderRadius: 8, width: 300, maxHeight: 'calc(100vh - 120px)', overflow: 'hidden', boxShadow: colors.containerShadow }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: `1px solid ${colors.containerBorder}`, flexShrink: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>Status</span>
        <button onClick={closeStatusDrawer}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, background: 'transparent', color: colors.textTertiary, cursor: 'pointer', border: 'none' }}>
          <X size={12} />
        </button>
      </div>

      {/* Scrollable non-breakdown sections */}
      <div style={{ overflowY: 'auto', padding: '12px', display: 'flex', flexDirection: 'column', gap: 16, flexShrink: 0 }}>

        {/* Section: Session Info (C6) */}
        {(tab?.conversationId || tab?.lastResult || tab?.sessionVersion) && (
          <div>
            <SectionHeader label="Session" colors={colors} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {tab?.conversationId && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 10, color: colors.textTertiary }}>ID</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 10, color: colors.textSecondary, fontVariantNumeric: 'tabular-nums', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={tab.conversationId}>
                      {tab.conversationId}
                    </span>
                    <CopyButton value={tab.conversationId} label="session id" colors={colors} />
                  </div>
                </div>
              )}
              {(tab?.lastResult?.conversationTurns ?? tab?.lastResult?.numTurns) != null && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 10, color: colors.textTertiary }}>Turns</span>
                  <span style={{ fontSize: 10, color: colors.textSecondary }}>{tab.lastResult?.conversationTurns ?? tab.lastResult?.numTurns}</span>
                </div>
              )}
              {tab?.lastResult?.durationMs != null && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 10, color: colors.textTertiary }}>Duration</span>
                  <span style={{ fontSize: 10, color: colors.textSecondary }}>{formatMs(tab.lastResult.durationMs)}</span>
                </div>
              )}
              {typeof aggregateCostUsd === 'number' && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 10, color: colors.textTertiary }}>Total cost (incl. dispatches)</span>
                  <span style={{ fontSize: 10, color: colors.textSecondary }}>${aggregateCostUsd.toFixed(4)}</span>
                </div>
              )}
              {contextBreakdown?.modelBreakdown && contextBreakdown.modelBreakdown.length > 0 && (
                <ModelBreakdownRows rows={contextBreakdown.modelBreakdown} colors={colors} />
              )}
              {tab?.sessionVersion && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 10, color: colors.textTertiary }}>Engine version</span>
                  <span style={{ fontSize: 10, color: colors.textSecondary }}>{tab.sessionVersion}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Section: Context */}
        <div>
          <SectionHeader label="Context" colors={colors} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <UsageBar percent={contextPercent} colors={colors} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: colors.textSecondary }}>
                {contextTokens !== null
                  ? `${contextTokens.toLocaleString()} tokens`
                  : `${Math.round(contextPercent)}%`}
                {contextWindow ? ` / ${(contextWindow / 1000).toFixed(0)}k` : ''}
              </span>
              <span style={{ fontSize: 10, color: colors.textSecondary }}>
                {typeof totalCostUsd === 'number' ? `$${totalCostUsd.toFixed(4)}` : ''}
              </span>
            </div>
            {state && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {state === 'running' && <CircleNotch size={10} className="animate-spin" style={{ color: colors.statusRunning }} />}
                <span style={{ fontSize: 10, color: state === 'running' ? colors.statusRunning : colors.textTertiary }}>
                  {state}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Section: Running Dispatches */}
        {runningDispatches.length > 0 && (
          <div>
            <SectionHeader label={`Running (${runningDispatches.length})`} colors={colors} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {runningDispatches.map(({ agent: _agent, dispatch, depth, displayName }) => (
                <button key={dispatch.id} onClick={() => openDispatchPreview(dispatch.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderRadius: 4, background: statusDrawerDispatchId === dispatch.id ? colors.surfaceActive : colors.surfaceHover, border: 'none', cursor: 'pointer', textAlign: 'left', width: '100%' }}>
                  {depth > 0 && <span style={{ fontSize: 9, color: colors.textMuted, flexShrink: 0 }}>T{depth}</span>}
                  <span style={{ fontSize: 10, color: colors.textPrimary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</span>
                  <span style={{ fontSize: 9, color: colors.textTertiary, flexShrink: 0 }}>{elapsedStr(dispatch.startTime)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Deep-link: AgentDetailPanel */}
        {deepLinkData && (
          <div>
            <SectionHeader label="Dispatch Detail" colors={colors} />
            <AgentDetailPanel
              agent={deepLinkData.agent}
              loadedMessages={undefined}
              loading={false}
              dispatches={deepLinkData.dispatches as DispatchInfo[]}
              selectedDispatch={deepLinkData.dispatchIdx}
              onSelectDispatch={() => {}}
              onClose={handleCloseDeepLink}
              dispatchTelemetry={dispatchTelemetry}
              allAgents={agentStates}
              initialStack={deepLinkData.stack}
            />
          </div>
        )}
      </div>

      {/* Section: Context Breakdown — own scroll region (C2) */}
      {hasBreakdown && contextWindow && (
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, borderTop: `1px solid ${colors.containerBorder}` }}>
          <div style={{ padding: '8px 12px 4px', flexShrink: 0 }}>
            <SectionHeader label="Context Breakdown" colors={colors} />
            {/* Proportion graph (C4) */}
            <ProportionGraph segments={graphSegments} contextWindow={contextWindow} colors={colors} />
          </div>
          {/* Scrollable rows (C2) */}
          <div style={{ overflowY: 'auto', minHeight: 0, padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* Grouped rows (C3) */}
            {Array.from(groupedCats.entries()).map(([kind, cats]) => (
              <div key={kind}>
                {/* Bucket header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2, marginTop: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 1, background: KIND_COLOR[kind], flexShrink: 0, display: 'inline-block' }} />
                  <span style={{ fontSize: 9, fontWeight: 600, color: colors.textTertiary, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {KIND_LABEL[kind]}
                  </span>
                  <span style={{ fontSize: 9, color: colors.textMuted }}>
                    {cats.reduce((s, c) => s + c.tokens, 0).toLocaleString()}
                  </span>
                </div>
                {/* Category rows (sub-rows for multi-item buckets) */}
                {cats.map((cat, i) => (
                  <CategoryRow key={`${cat.name}-${i}`} cat={cat} contextWindow={contextWindow} colors={colors} indent={cats.length > 1} />
                ))}
              </div>
            ))}

            {/* Unaccounted row */}
            {typeof contextBreakdown!.unaccounted === 'number' && contextBreakdown!.unaccounted !== 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, paddingTop: 4, borderTop: `1px solid ${colors.containerBorder}` }}>
                <span style={{ fontSize: 10, color: colors.textMuted, flex: 1 }}>unaccounted</span>
                <span style={{ fontSize: 10, color: colors.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                  {contextBreakdown!.unaccounted.toLocaleString()}
                </span>
              </div>
            )}

            {/* Total row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, paddingTop: 4, borderTop: `1px solid ${colors.containerBorder}` }}>
              <span style={{ fontSize: 10, color: colors.textSecondary, flex: 1, fontWeight: 500 }}>total</span>
              <span style={{ fontSize: 10, color: colors.textPrimary, fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                {contextBreakdown!.totalTokens.toLocaleString()}
              </span>
              {contextWindow > 0 && (
                <span style={{ fontSize: 9, color: colors.textTertiary, minWidth: 28, textAlign: 'right' }}>
                  {Math.round((contextBreakdown!.totalTokens / contextWindow) * 100)}%
                </span>
              )}
            </div>

            {/* Cache annotation (C5) — non-additive, visually distinct */}
            {((contextBreakdown!.cacheReadTokens ?? 0) > 0 || (contextBreakdown!.cacheCreationTokens ?? 0) > 0) && (
              <div style={{ marginTop: 4, padding: '4px 6px', borderRadius: 4, background: colors.accentLight, border: `1px solid ${colors.containerBorder}` }}>
                <div style={{ fontSize: 9, color: colors.accent, fontWeight: 600, marginBottom: 2 }}>of which, cached</div>
                {(contextBreakdown!.cacheReadTokens ?? 0) > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 9, color: colors.textTertiary }}>served (read)</span>
                    <span style={{ fontSize: 9, color: colors.textSecondary, fontVariantNumeric: 'tabular-nums' }}>
                      {contextBreakdown!.cacheReadTokens!.toLocaleString()}
                    </span>
                  </div>
                )}
                {(contextBreakdown!.cacheCreationTokens ?? 0) > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 9, color: colors.textTertiary }}>written</span>
                    <span style={{ fontSize: 9, color: colors.textSecondary, fontVariantNumeric: 'tabular-nums' }}>
                      {contextBreakdown!.cacheCreationTokens!.toLocaleString()}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
