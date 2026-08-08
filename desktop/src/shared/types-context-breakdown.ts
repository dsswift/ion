// ─── Context Breakdown (engine_context_breakdown wire payload) ───
//
// Extracted from types-engine.ts at the 600-line cap split — the same seam
// that file already uses for types-enterprise.ts's re-export. Mirrors Go's
// ContextBreakdownCategory and ContextBreakdownPayload in
// engine/internal/types/engine_event.go. The desktop and iOS use these to
// render the per-category context-usage readout in the Status Drawer.
//
// Cross-language contract: contract-sync.test.ts validates field parity against
// engine/internal/types/testdata/contracts.json. Update that manifest whenever
// the Go struct changes (go test ./internal/types/ -run TestContractManifest -update).

/** One row in a context breakdown: a named category with its token count and resolution tier. */
export interface ContextBreakdownCategory {
  name: string
  kind: string
  tokens: number
  /** How the count was obtained: provider endpoint, BPE, or char/4 heuristic. */
  tier: 'exact' | 'local' | 'approximate'
  /** Absolute path — populated for per-file rows (kind === 'file'). */
  path?: string
}

/** Wire payload for engine_context_breakdown. Mirrors Go's ContextBreakdownPayload. */
export interface ContextBreakdownPayload {
  categories: ContextBreakdownCategory[]
  contextWindow: number
  totalTokens: number
  /** Provider-reported input_tokens. Zero until reconciliation after first usage event. */
  apiReportedTotal?: number
  /** apiReportedTotal - totalTokens. Non-zero after reconciliation. */
  unaccounted?: number
  /**
   * Provider-reported cache-read tokens. Non-additive annotation — NOT included in
   * totalTokens. Zero/absent when the provider did not report cache activity.
   */
  cacheReadTokens?: number
  /**
   * Provider-reported cache-creation tokens. Non-additive annotation — NOT included in
   * totalTokens. Zero/absent when the provider did not report cache activity.
   */
  cacheCreationTokens?: number
  model: string
  /**
   * The engine's authoritative context-window occupancy — the same figure
   * `StatusFields.contextTokens` carries and the same input the engine's
   * proactive-compaction gate measures. Divide by `contextWindow` to render
   * "how full is the context".
   *
   * Prefer this over the two neighbouring counts, which measure different
   * things and both drift as an occupancy proxy:
   *   - `totalTokens` is the ITEMIZED per-category sum, an independent estimate
   *     meant for attribution ("what is taking up the space"). It over-reports,
   *     counting content the provider did not bill for this turn.
   *   - `apiReportedTotal` is the raw provider input_tokens for the last turn
   *     with nothing added for messages appended since, so it under-reports
   *     mid-turn (tool results not yet sent).
   *
   * Absent when the engine has no occupancy figure for the conversation.
   */
  occupancyTokens?: number
  /**
   * Sum of this session's LLM cost plus every descendant dispatch session's
   * cost, computed on demand from the conversation tree. Zero / absent for
   * sessions with no dispatches or no cost yet.
   */
  aggregateCostUsd?: number
  /**
   * Per-model cost breakdown for the conversation dispatch tree. Populated by
   * the on-demand breakdown (ComputeAndEmitContextBreakdown). Empty for
   * runloop-emitted breakdowns. Sorted by costUsd descending.
   */
  modelBreakdown?: ModelBreakdown[]
}

/** One row in the per-model cost breakdown. Mirrors Go's ModelBreakdown in types/model_breakdown.go. */
export interface ModelBreakdown {
  model: string
  conversations: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  /**
   * True when this row is the root/viewing conversation's OWN spend rather than
   * a dispatch. A model used by both the root and its dispatches yields two rows
   * (one isSelf=true count 1, one isSelf=false count n). Absent (omitted on the
   * wire) for dispatch rows. Lets consumers separate "this conversation cost $X"
   * from "the dispatches cost $Y".
   */
  isSelf?: boolean
}
