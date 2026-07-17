import Foundation

// MARK: - ContextBreakdownPayload
//
// Wire types for the desktop_context_breakdown event (plan modest-leaping-waffle §9).
// These mirror TypeScript's ContextBreakdownCategory + ContextBreakdownPayload in
// desktop/src/shared/types-engine.ts and Go's ContextBreakdownCategory +
// ContextBreakdownPayload in engine/internal/types/engine_event.go.
//
// Cross-language contract: update ContractSyncTests.swift whenever the Go struct
// gains a field (go test ./internal/types/ -run TestContractManifest -update and
// then mirror the new field here).

// MARK: - ContextBreakdownCategory

/// One row in a context breakdown: a named category with its token count and
/// resolution tier. Mirrors Go's ContextBreakdownCategory and TypeScript's
/// ContextBreakdownCategory in types-engine.ts.
struct ContextBreakdownCategory: Codable, Sendable {
    /// Human-readable category name (e.g. "System Prompt", "Tools", "Conversation").
    let name: String
    /// Category kind: "system", "tools", "file", "memory", "extension", "conversation".
    let kind: String
    /// Absolute token count for this category.
    let tokens: Int
    /// How the count was obtained: "exact" (provider endpoint), "local" (BPE),
    /// "approximate" (char/4 heuristic). Never downgraded silently.
    let tier: String
    /// Absolute file path — populated for per-file rows (kind == "file").
    let path: String?
}

// MARK: - ModelBreakdown

/// One row in the per-model cost breakdown for the conversation dispatch tree.
/// Mirrors Go's ModelBreakdown in engine/internal/types/model_breakdown.go and
/// TypeScript's ModelBreakdown in types-engine.ts.
///
/// Attribution: token counts come from each conversation's .llm.jsonl header.
/// A conversation that switched models mid-run attributes entirely to its final
/// header model. inputTokens is cache-inclusive (matches the persisted
/// totalInputTokens semantic).
struct ModelBreakdown: Codable, Sendable, Identifiable {
    var id: String { isSelf == true ? "\(model)#self" : model }
    let model: String
    let conversations: Int
    let inputTokens: Int
    let outputTokens: Int
    let costUsd: Double
    /// True when this row is the root/viewing conversation's OWN spend rather
    /// than a dispatch. A model used by both the root and its dispatches yields
    /// two rows (one isSelf=true count 1, one isSelf=false count n). Absent
    /// (omitted on the wire) for dispatch rows. Lets the drawer separate "this
    /// conversation cost $X" from "the dispatches cost $Y".
    let isSelf: Bool?
}

// MARK: - ContextBreakdownPayload

/// Wire payload for desktop_context_breakdown (forwarded from engine_context_breakdown).
/// Carries per-category token counts, context window size, and the post-reconciliation
/// unaccounted delta. Mirrors Go's ContextBreakdownPayload and TypeScript's
/// ContextBreakdownPayload in types-engine.ts.
struct ContextBreakdownPayload: Codable, Sendable {
    /// Per-category rows. Includes per-file and per-tool sub-rows when the engine
    /// ran per-category isolation (kind=="file" / kind=="tool" rows are nested by kind).
    let categories: [ContextBreakdownCategory]
    /// Engine-reported context window size in tokens.
    let contextWindow: Int
    /// Sum of tokens across all categories.
    let totalTokens: Int
    /// Provider-reported input_tokens. Zero / absent until reconciliation after
    /// the first UsageEvent. Non-zero means the itemized sum has been checked
    /// against the real aggregate.
    let apiReportedTotal: Int?
    /// apiReportedTotal - totalTokens. Non-zero after reconciliation; surfaces
    /// hidden overhead (tool preamble, formatting) that the per-category
    /// isolation cannot attribute. Never silently absorbed.
    let unaccounted: Int?
    /// Model that produced this breakdown (e.g. "claude-sonnet-4-6").
    let model: String
    /// Provider-reported cache-read (served) tokens. Non-additive annotation on
    /// the total — surfaces how much of the context was served from the prompt
    /// cache rather than freshly tokenized. Zero / absent until reconciliation.
    let cacheReadTokens: Int?
    /// Provider-reported cache-creation (written) tokens. Non-additive annotation
    /// on the total — surfaces how much of the context was newly written to the
    /// prompt cache. Zero / absent until reconciliation.
    let cacheCreationTokens: Int?
    /// Sum of this session's LLM cost plus every descendant dispatch session's
    /// cost, computed on demand from the conversation tree. Nil / zero for
    /// sessions with no dispatches or no cost yet.
    let aggregateCostUsd: Double?
    /// Per-model cost breakdown for the conversation dispatch tree. Populated by
    /// the on-demand breakdown. Sorted by costUsd descending (highest spend first).
    /// Nil / empty for runloop-emitted breakdowns.
    let modelBreakdown: [ModelBreakdown]?
}
