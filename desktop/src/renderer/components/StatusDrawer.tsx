/**
 * StatusDrawer — right-side panel toggled by the ⓘ button in StatusBar.
 *
 * Anchored left:100% of the content column (same GitPanel pattern in App.tsx).
 * Sections:
 *   1. Session info  — copyable ID, conversation-lifetime turns, duration, sessionVersion.
 *   2. Context       — usage bar + cost + state from statusFields.
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

import React, { useMemo, useCallback } from 'react'
import { X, CircleNotch } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useShallow } from 'zustand/shallow'
import { useColors } from '../theme'
import { meta, getDispatches, buildBreadcrumbStack } from './agent-panel-helpers'
import { AgentDetailPanel } from './AgentDetailPanel'
import type { AgentStateUpdate } from '../../shared/types'
import type { ContextBreakdownCategory, DispatchInfo } from '../../shared/types-engine'
import { getDynamicContextWindow } from '../stores/model-labels'
import { usePreferencesStore } from '../preferences'
import { resolveContextDisplay, resolveContextInputs } from './context-usage'

// Presentational parts live in StatusDrawerParts.tsx — this file is under an
// explicit size cap and the parts are pure (data + colors in, JSX out). The
// copy affordance, tier badges, and kind bucketing are owned by those parts,
// so their internals (useState, Copy/Check icons, TierBadge, kindKey) are
// imported there rather than here.
import {
  UsageBar, SectionHeader, elapsedStr, ProportionGraph,
  groupCategories, CategoryRow, CopyButton, ModelBreakdownRows,
  KIND_ORDER, KIND_LABEL, KIND_COLOR, formatMs,
} from './StatusDrawerParts'
import type { KindKey, GraphSegment } from './StatusDrawerParts'

// ─── Main component ───────────────────────────────────────────────────────────

export function StatusDrawer() {
  const colors = useColors()
  const preferredModel = usePreferencesStore((s) => s.preferredModel)
  const closeStatusDrawer = useSessionStore((s) => s.closeStatusDrawer)
  const openDispatchPreview = useSessionStore((s) => s.openDispatchPreview)
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

  // The drawer and the status bar MUST agree, so both read the same numerator
  // and the same denominator (the SELECTED model's window via
  // resolveContextDisplay). Deriving tokens from percent × window — the old
  // shape — was lossy and produced a figure that disagreed with the bar
  // whenever the picker differed from the engine.
  //
  // The numerator and the engine-window fallback both come from
  // resolveContextInputs, which the status-bar ring also calls — that shared
  // helper is what makes the two surfaces agree by construction rather than by
  // each assembling the same fields by hand. It documents why occupancy wins and
  // why the itemized totalTokens is never a candidate.
  //
  // The itemized sum still drives the per-category grid below, where the
  // `unaccounted` row makes its drift from the provider total explicit.
  const { tokens: contextTokens, engineWindow } = resolveContextInputs(activeInstance)
  const effectiveModel = activeInstance?.modelOverride || activeInstance?.sessionModel || preferredModel
  const selectedWindow = getDynamicContextWindow(effectiveModel, engineWindow)
  const contextDisplay = resolveContextDisplay(contextTokens, selectedWindow)
  const contextPercent = contextDisplay?.pct ?? 0
  const runCostUsd = statusFields?.runCostUsd ?? null
  const conversationCostUsd = statusFields?.conversationCostUsd ?? null
  const totalCostUsd = runCostUsd
  const aggregateCostUsd = contextBreakdown?.aggregateCostUsd ?? conversationCostUsd ?? null
  // The breakdown grid is proportional to what the ENGINE measured against,
  // so it keeps the engine's window; the headline figure above uses the
  // selected model's.
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
            {/* UsageBar clamps its FILL at 100 (a bar cannot render 220% of
                its width); the numeric label below reports the true figure. */}
            <UsageBar percent={contextPercent} colors={colors} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: colors.textSecondary }}>
                {/* contextDisplay is non-null exactly when contextTokens is —
                    both derive from the same resolveContextDisplay(contextTokens, …)
                    guard above — so this is one expression, not a ternary plus
                    an appended percent. The old shape had an unreachable "%"
                    fallback branch AND appended the percent unconditionally. */}
                {contextDisplay
                  ? `${contextTokens!.toLocaleString()} tokens (${contextDisplay.pct}%)`
                  : '—'}
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
                  <span style={{ width: 6, height: 6, borderRadius: 1, background: colors[KIND_COLOR[kind]], flexShrink: 0, display: 'inline-block' }} />
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
