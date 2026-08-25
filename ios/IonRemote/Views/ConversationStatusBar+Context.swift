import SwiftUI

// MARK: - ConversationStatusBar context-usage resolvers
//
// Context percent/tokens/capacity resolution, extracted from
// ConversationStatusBar.swift to keep that file under the 600-line Swift
// cap. Pure static functions (context-window arithmetic) plus the instance
// computed properties that thread them together for the view's context
// ring — no view body code lives here, only the resolution logic behind it.

extension ConversationStatusBar {
    /// Resolved context occupancy percentage. UNBOUNDED — may exceed 100.
    ///
    /// Tokens-first, matching the desktop: divide the engine's absolute
    /// occupancy figure by the SELECTED model's window. No engine command can
    /// change an idle session's model, so a picker-driven recompute has to be
    /// client-side arithmetic — this is what makes switching a 220k-token
    /// conversation from a 1M model to a 100k one read 220% immediately.
    ///
    /// `contextPercent` is the fallback for a session whose engine has not
    /// reported a token count (an older engine, or a backend that emits no
    /// usage). That percentage is anchored to whatever window the engine
    /// measured against, so it cannot react to the picker.
    ///
    /// Not capped: over-budget is real information, and an operator at 220%
    /// needs to see 220% rather than a figure identical to exactly-full.
    /// Callers clamp for geometry only.
    var resolvedContextPercent: Double? {
        Self.resolveContextPercent(
            contextPercent: contextPercent,
            contextTokens: contextTokens,
            selectedModelWindow: selectedModelWindow,
        )
    }

    /// Pure form of the above, so every iOS surface that shows context usage
    /// (this bar, the conversation header's fill strip) resolves one number
    /// from one implementation and the two can never disagree.
    static func resolveContextPercent(
        contextPercent: Double?,
        contextTokens: Int?,
        selectedModelWindow: Int?,
    ) -> Double? {
        if let tokens = contextTokens, tokens > 0, let denominator = selectedModelWindow, denominator > 0 {
            return Double(tokens) / Double(denominator) * 100.0
        }
        if let cp = contextPercent {
            return cp
        }
        return nil
    }

    /// The absolute occupancy figure to divide by the window — the NUMERATOR
    /// counterpart to `windowForModel`'s denominator. Static for the same reason
    /// as the two resolvers around it: every iOS surface that shows context usage
    /// resolves one number from one implementation, so they cannot disagree.
    ///
    /// A context breakdown carries three token quantities that are easy to
    /// confuse, and only one of them is occupancy:
    ///
    ///   - `breakdownOccupancy` (`occupancyTokens`) — the engine's authoritative
    ///     occupancy. The same figure `StatusFields.contextTokens` carries and the
    ///     same input the engine's proactive-compaction gate measures. THIS is
    ///     what divides by the context window.
    ///   - `breakdownTotal` (`totalTokens`) — the ITEMIZED per-category sum. An
    ///     independent estimate meant for attribution ("what is taking up the
    ///     space"). It OVER-reports, counting content the provider did not bill
    ///     for this turn, so it must never be read as occupancy: doing so
    ///     rendered a conversation occupying 26% of a 1M window as ~103%.
    ///   - `apiReportedTotal` (not accepted here) — the raw provider
    ///     input_tokens for the last turn, with nothing added for messages
    ///     appended since, so it UNDER-reports mid-turn.
    ///
    /// `breakdownTotal` is a parameter purely so this contract is stated at the
    /// one place the decision is made. It is deliberately never returned — a
    /// caller that has it in hand passes it here and gets back the right number.
    static func resolveContextTokens(
        breakdownOccupancy: Int?,
        breakdownTotal: Int?,
        fieldsTokens: Int?,
        instanceTokens: Int?,
    ) -> Int? {
        if let t = breakdownOccupancy, t > 0 { return t }
        if let t = fieldsTokens, t > 0 { return t }
        if let t = instanceTokens, t > 0 { return t }
        return nil
    }

    /// Client-side capacity state. The effective limit reserves response and
    /// compaction room from the selected model's raw context window.
    enum ContextCapacityState: Equatable {
        case normal
        case warning
        case full
    }

    struct ContextCapacity: Equatable {
        let occupancyTokens: Int
        let effectiveLimit: Int
        let percent: Double
    }

    /// Default output reserve when model metadata declares no output cap.
    /// Mirrors DEFAULT_CONTEXT_OUTPUT_RESERVE in shared/context-capacity.ts.
    static let defaultContextOutputReserve = 20_000

    /// Compaction-summary reserve. Mirrors CONTEXT_SUMMARY_RESERVE there.
    static let contextSummaryReserve = 13_000

    /// Mirror the engine's input-budget calculation. The engine-reported
    /// effective limit wins when it is present, because it IS the engine's own
    /// arithmetic for the model the engine used. The client only recomputes from
    /// the selected model's window and output reserve, which is what makes the
    /// picker update admission before another request reaches the engine.
    static func resolveContextCapacity(
        occupancyTokens: Int?,
        modelId: String,
        availableModels: [RemoteModelEntry],
        engineContextWindow: Int?,
        engineEffectiveLimit: Int? = nil,
    ) -> ContextCapacity? {
        guard let occupancyTokens, occupancyTokens > 0 else { return nil }
        let selected = availableModels.first(where: { $0.id == modelId })
        // The engine's answer is only authoritative while the operator has not
        // moved the picker to a model the engine has not run. A selected model
        // that declares its own limit or window takes precedence.
        if let reported = engineEffectiveLimit, reported > 0,
           selected?.effectiveContextLimit == nil, selected?.contextWindow == nil {
            return ContextCapacity(
                occupancyTokens: occupancyTokens,
                effectiveLimit: reported,
                percent: Double(occupancyTokens) / Double(reported) * 100,
            )
        }
        // The selected model's own published limit is the engine's arithmetic
        // for THAT model, so it beats recomputing the reserves locally.
        if let declared = selected?.effectiveContextLimit, declared > 0 {
            return ContextCapacity(
                occupancyTokens: occupancyTokens,
                effectiveLimit: declared,
                percent: Double(occupancyTokens) / Double(declared) * 100,
            )
        }
        guard let rawWindow = windowForModel(
            modelId,
            availableModels: availableModels,
            engineContextWindow: engineContextWindow,
        ), rawWindow > 0 else {
            guard let reported = engineEffectiveLimit, reported > 0 else { return nil }
            return ContextCapacity(
                occupancyTokens: occupancyTokens,
                effectiveLimit: reported,
                percent: Double(occupancyTokens) / Double(reported) * 100,
            )
        }

        let declaredOutput = selected?.maxOutputTokens ?? 0
        let outputReserve = declaredOutput > 0 ? declaredOutput : defaultContextOutputReserve
        let effectiveLimit = rawWindow - outputReserve - contextSummaryReserve
        let limit = effectiveLimit > 0 ? effectiveLimit : rawWindow
        return ContextCapacity(
            occupancyTokens: occupancyTokens,
            effectiveLimit: limit,
            percent: Double(occupancyTokens) / Double(limit) * 100,
        )
    }

    static func contextCapacityState(_ capacity: ContextCapacity?) -> ContextCapacityState {
        guard let capacity else { return .normal }
        if capacity.percent >= 100 { return .full }
        if capacity.percent >= 80 { return .warning }
        return .normal
    }

    /// Context window of a named model from the catalog, falling back to the
    /// engine's reported window. Static so non-bar surfaces can resolve the
    /// same denominator.
    static func windowForModel(
        _ modelId: String,
        availableModels: [RemoteModelEntry],
        engineContextWindow: Int?,
    ) -> Int? {
        if let model = availableModels.first(where: { $0.id == modelId }), model.contextWindow > 0 {
            return model.contextWindow
        }
        if let engineWindow = engineContextWindow, engineWindow > 0 {
            return engineWindow
        }
        return nil
    }

    /// Context window of the model currently SELECTED in the picker — the
    /// display denominator. Falls back to the engine's window when the picker
    /// model is not in the catalog (so the reading degrades to the engine's
    /// own view rather than vanishing).
    var selectedModelWindow: Int? {
        Self.windowForModel(effectiveModel, availableModels: availableModels, engineContextWindow: engineContextWindow)
    }

    /// Presentation percentage for the persistent context ring. Missing
    /// occupancy renders as a neutral 0% ring so a fresh, idle, completed, or
    /// background-agent-waiting conversation never loses its tap target.
    var radialContextPercent: Double {
        resolvedContextPercent ?? 0
    }

    /// Accessible name for the context ring. Carries the true uncapped
    /// percentage plus the raw counts, since no number is rendered as text.
    func contextAccessibilityLabel(pct: Double) -> String {
        if let tokens = contextTokens, tokens > 0, let window = selectedModelWindow, window > 0 {
            return "Context usage \(Int(pct)) percent, \(tokens) of \(window) tokens"
        }
        return "Context usage \(Int(pct)) percent"
    }

    var contextColor: Color {
        guard let pct = resolvedContextPercent else { return .secondary }
        // ContextUsageRing owns the one threshold ladder — see its `level(_:)`.
        return ContextUsageRing.color(for: pct)
    }
}
