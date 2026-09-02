import Foundation

/// Model-switch cost estimation.
///
/// A provider prompt cache is keyed per exact model. Switching the model a
/// conversation runs on therefore cannot reuse the cache the previous model
/// built: the whole conversation is re-sent as cache-creation input on the
/// first turn after the switch, instead of being read back at the much cheaper
/// cache-read rate. This holds for a same-vendor switch too — the cache is
/// per-model, not per-account, so a Sonnet-to-Opus hop is no cheaper than a
/// cross-vendor one.
///
/// The operator cannot see that from the picker, which is why switching mid
/// conversation is easy to do repeatedly by accident. This type turns the
/// conversation's current size into the concrete dollar figure the next turn
/// will cost, so the picker can state it before the switch happens.
///
/// The rates come from the projected model catalog. Explicit cache rates win;
/// the fallback multipliers apply only when the selected model omits them.
enum ModelSwitchCost {
    /// Applied to the base input rate when a model has no explicit
    /// cache-creation rate.
    static let cacheCreationFallbackMultiplier = 1.25

    /// Applied to the base input rate when a model has no explicit cache-read
    /// rate.
    static let cacheReadFallbackMultiplier = 0.10

    struct Estimate: Equatable {
        /// Tokens that would be re-sent as cache-creation input.
        let tokens: Int
        /// USD cost of re-sending those tokens to the target model.
        let costUsd: Double
        /// USD cost the same tokens would have had as a cache read on the model
        /// the conversation is already using. Nil when its price is unavailable.
        let cachedCostUsd: Double?
        /// True when the target-model estimate is a real computation. False
        /// when the target publishes no usable input price. In that case the
        /// token count remains meaningful but no dollar value is shown.
        let priced: Bool
    }

    /// Estimate what the first turn after a model switch will cost.
    ///
    /// `contextTokens` is the conversation's current model-visible size, which
    /// the engine already reports through `StatusFields.contextTokens`. A nil or
    /// non-positive value means there is nothing to re-send.
    ///
    /// Returns nil when no switch cost applies at all — no history, or no target
    /// model. A nil result is the signal that the switch is free and needs no
    /// warning, which is exactly the fresh-conversation case.
    static func estimate(
        contextTokens: Int?,
        targetModel: RemoteModelEntry?,
        currentModel: RemoteModelEntry? = nil
    ) -> Estimate? {
        guard let tokens = contextTokens, tokens > 0 else { return nil }
        guard let model = targetModel else { return nil }

        // A model with no published price is not free — it is unknown. Report
        // the token count and mark the estimate unpriced rather than printing
        // $0.00, which would read as "this switch costs nothing".
        guard let rate = model.costPer1kInput, rate.isFinite, rate > 0 else {
            return Estimate(tokens: tokens, costUsd: 0, cachedCostUsd: nil, priced: false)
        }

        let perThousand = Double(tokens) / 1000.0
        let creationRate = model.costPer1kCacheCreation.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
            ?? rate * cacheCreationFallbackMultiplier
        let current = currentModel ?? model
        let readRate: Double?
        if let currentInputRate = current.costPer1kInput,
           currentInputRate.isFinite,
           currentInputRate > 0 {
            readRate = current.costPer1kCacheRead.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
                ?? currentInputRate * cacheReadFallbackMultiplier
        } else {
            readRate = nil
        }
        return Estimate(
            tokens: tokens,
            costUsd: perThousand * creationRate,
            cachedCostUsd: readRate.map { perThousand * $0 },
            priced: true
        )
    }

    /// Format an estimate as short operator-facing text.
    ///
    /// Deliberately terse: this appears in a confirmation the operator reads
    /// while doing something else. It states the cost and the reason, not a
    /// lecture.
    static func describe(_ estimate: Estimate) -> String {
        let tokens = formatTokenCount(estimate.tokens)
        if !estimate.priced {
            return "\(tokens) tokens will be re-sent to the new model. This model publishes no price, so the cost is unknown."
        }
        let switchText = "\(tokens) tokens will be re-sent to the new model, about \(formatUsd(estimate.costUsd))."
        guard let cachedCost = estimate.cachedCostUsd else { return switchText }
        return "\(switchText) The same tokens cost about \(formatUsd(cachedCost)) on the model you are already using."
    }

    /// Compact token count: 1200 -> "1K", 650000 -> "650K", 1500000 -> "1.5M".
    static func formatTokenCount(_ tokens: Int) -> String {
        if tokens >= 1_000_000 {
            return String(format: "%.1fM", Double(tokens) / 1_000_000.0)
        }
        if tokens >= 1_000 {
            return "\(Int((Double(tokens) / 1000.0).rounded()))K"
        }
        return String(tokens)
    }

    /// USD with enough precision to stay honest at small amounts. A switch that
    /// costs a third of a cent must not render as "$0.00" — that reads as free.
    static func formatUsd(_ amount: Double) -> String {
        if amount > 0 && amount < 0.01 { return "<$0.01" }
        let roundedCents = ((amount + Double.ulpOfOne) * 100).rounded() / 100
        return String(format: "$%.2f", roundedCents)
    }
}
