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
/// Both figures the picker shows are costs for the NEXT turn, and the honest
/// comparison is between them. That makes the cache's lifetime part of the
/// arithmetic, not a detail: a prompt cache entry is only readable for a
/// bounded window after the write that created it. Once it expires, staying on
/// the current model re-writes the whole prompt at the cache-creation rate,
/// exactly like switching does. A stay-put figure quoted at the cache-read rate
/// when the cache is already gone understates the true cost by the full
/// creation-to-read ratio — up to 50x — and can invert the comparison
/// completely, telling the operator to stay put when switching is cheaper.
///
/// So the estimator takes the age of the conversation's last activity and the
/// cache lifetime the engine publishes for the model (`cacheTtlSeconds`), and
/// prices the stay-put side against a cache it has established is still alive.
/// When the age or the lifetime is unknown it does not guess: it reports the
/// warm figure and marks it unconfirmed, so the caller can say so rather than
/// assert a number it cannot stand behind.
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

    /// Why the stay-put figure is priced the way it is.
    enum CacheState: String, Equatable {
        /// The cache is provably still readable: activity is inside the lifetime.
        case warm
        /// The cache has provably expired: activity is older than the lifetime.
        case expired
        /// The current model does not cache prompts at all.
        case unsupported
        /// Either the last-activity time or the cache lifetime is unavailable,
        /// so whether the cache survives cannot be determined. Priced as warm,
        /// which is the lower bound, and flagged so the caller never states it
        /// as fact.
        case unknown
    }

    struct Estimate: Equatable {
        /// Tokens that would be re-sent as cache-creation input.
        let tokens: Int
        /// USD cost of re-sending those tokens to the target model.
        let costUsd: Double
        /// USD cost of the next turn's same tokens if the operator stays on the
        /// model the conversation is already using. Priced at that model's
        /// cache-read rate only while its cache is still readable; at its
        /// cache-creation rate once the cache has expired, because that is what
        /// the next turn would actually bill. Nil when its price is unavailable.
        let cachedCostUsd: Double?
        /// Which of those two rates `cachedCostUsd` used, and why.
        let cacheState: CacheState
        /// Seconds since the conversation's last activity, when known.
        let idleSeconds: Double?
        /// The cache lifetime used to judge `cacheState`. Nil when undeclared.
        let cacheTtlSeconds: Int?
        /// True when the target-model estimate is a real computation. False
        /// when the target publishes no usable input price. In that case the
        /// token count remains meaningful but no dollar value is shown.
        let priced: Bool
    }

    /// Resolve the cache-read rate for a model, or nil when it has no usable
    /// price.
    private static func readRate(_ model: RemoteModelEntry) -> Double? {
        guard let rate = model.costPer1kInput, rate.isFinite, rate > 0 else { return nil }
        if let explicit = model.costPer1kCacheRead, explicit.isFinite, explicit > 0 {
            return explicit
        }
        return rate * cacheReadFallbackMultiplier
    }

    /// Resolve the cache-creation rate for a model, or nil when it has no
    /// usable price.
    private static func creationRate(_ model: RemoteModelEntry) -> Double? {
        guard let rate = model.costPer1kInput, rate.isFinite, rate > 0 else { return nil }
        if let explicit = model.costPer1kCacheCreation, explicit.isFinite, explicit > 0 {
            return explicit
        }
        return rate * cacheCreationFallbackMultiplier
    }

    /// Decide whether the current model's prompt cache is still readable.
    ///
    /// Returns `.unknown` rather than assuming warm or expired whenever either
    /// input is missing. Guessing here is what produces a confidently wrong
    /// dollar figure.
    static func resolveCacheState(
        currentModel: RemoteModelEntry,
        lastActivityAt: Date? = nil,
        now: Date = Date()
    ) -> (state: CacheState, idleSeconds: Double?, ttlSeconds: Int?) {
        // A model that never writes a cache has no warm path to compare
        // against, regardless of how recently the conversation ran.
        if currentModel.supportsCaching == false {
            return (.unsupported, nil, nil)
        }
        let ttlSeconds: Int? = {
            guard let ttl = currentModel.cacheTtlSeconds, ttl > 0 else { return nil }
            return ttl
        }()
        guard let lastActivityAt, let ttlSeconds else {
            return (.unknown, nil, ttlSeconds)
        }
        // A negative age means the clock the timestamps came from disagrees
        // with the clock measuring now. Clamp to zero: the conversation cannot
        // have run in the future, and treating skew as a huge age would falsely
        // report an expiry.
        let idleSeconds = max(0, now.timeIntervalSince(lastActivityAt))
        return (idleSeconds > Double(ttlSeconds) ? .expired : .warm, idleSeconds, ttlSeconds)
    }

    /// Estimate what the first turn after a model switch will cost.
    ///
    /// `contextTokens` is the conversation's current model-visible size, which
    /// the engine already reports through `StatusFields.contextTokens`. A nil or
    /// non-positive value means there is nothing to re-send.
    ///
    /// `lastActivityAt` is the conversation's last real turn — the turn that
    /// wrote the prompt cache — so the stay-put side can be priced against a
    /// cache that is actually still alive. Omitting it yields an `.unknown`
    /// cache state and an explicitly unconfirmed comparison, never a silent
    /// assumption that the cache is warm.
    ///
    /// Returns nil when no switch cost applies at all — no history, or no target
    /// model. A nil result is the signal that the switch is free and needs no
    /// warning, which is exactly the fresh-conversation case.
    static func estimate(
        contextTokens: Int?,
        targetModel: RemoteModelEntry?,
        currentModel: RemoteModelEntry? = nil,
        lastActivityAt: Date? = nil,
        now: Date = Date()
    ) -> Estimate? {
        guard let tokens = contextTokens, tokens > 0 else { return nil }
        guard let model = targetModel else { return nil }

        // A model with no published price is not free — it is unknown. Report
        // the token count and mark the estimate unpriced rather than printing
        // $0.00, which would read as "this switch costs nothing".
        guard let rate = model.costPer1kInput, rate.isFinite, rate > 0 else {
            return Estimate(
                tokens: tokens,
                costUsd: 0,
                cachedCostUsd: nil,
                cacheState: .unknown,
                idleSeconds: nil,
                cacheTtlSeconds: nil,
                priced: false
            )
        }

        let perThousand = Double(tokens) / 1000.0
        let current = currentModel ?? model
        let resolved = resolveCacheState(
            currentModel: current,
            lastActivityAt: lastActivityAt,
            now: now
        )

        // The stay-put side is the cost of the NEXT turn on the current model,
        // which is the cache-read rate only while that cache survives. Once it
        // has expired — or when the model never cached — the next turn
        // re-writes the prompt, so the honest comparison uses the write rate on
        // both sides.
        let stayRate: Double?
        switch resolved.state {
        case .warm, .unknown:
            stayRate = readRate(current)
        case .unsupported:
            if let base = current.costPer1kInput, base.isFinite, base > 0 {
                stayRate = base
            } else {
                stayRate = nil
            }
        case .expired:
            stayRate = creationRate(current)
        }

        return Estimate(
            tokens: tokens,
            costUsd: perThousand * (creationRate(model) ?? 0),
            cachedCostUsd: stayRate.map { perThousand * $0 },
            cacheState: resolved.state,
            idleSeconds: resolved.idleSeconds,
            cacheTtlSeconds: resolved.ttlSeconds,
            priced: true
        )
    }

    /// Format an estimate as short operator-facing text.
    ///
    /// Leads with the verdict, because that is the only thing the operator has
    /// to decide. The cache state is not a caveat to pass along for them to
    /// interpret — it is an input the estimator already resolved, so the text
    /// states which option is cheaper and by how much, then gives the two
    /// figures behind it.
    ///
    /// "Staying is cheaper if the cache is still live" is a non-answer: it
    /// hands back the question the estimator exists to settle. The only case
    /// that legitimately hedges is `.unknown`, and the fix for that is to
    /// supply the missing input, not to soften the sentence.
    static func describe(_ estimate: Estimate) -> String {
        let tokens = formatTokenCount(estimate.tokens)
        if !estimate.priced {
            return "\(tokens) tokens will be re-sent to the new model. This model publishes no price, so the cost is unknown."
        }
        let switchCost = formatUsd(estimate.costUsd)
        guard let cachedCost = estimate.cachedCostUsd else {
            return "Switching re-sends \(tokens) tokens and costs about \(switchCost)."
        }
        let stayCost = formatUsd(cachedCost)
        let costs = "Switching costs about \(switchCost); staying costs about \(stayCost)."

        if estimate.cacheState == .unknown {
            // The one honest hedge: an input was missing, so no verdict exists.
            return "Switching re-sends \(tokens) tokens and costs about \(switchCost). Staying costs about \(stayCost) if this conversation's prompt cache is still live, and more if it has expired — its age could not be determined."
        }

        let delta = cachedCost - estimate.costUsd
        let saving = formatUsd(abs(delta))
        let idle = formatDuration(estimate.idleSeconds)

        switch estimate.cacheState {
        case .warm:
            // The cache is alive, so staying really does buy the read rate.
            return "Staying on the current model is cheaper — its prompt cache is still live (idle \(idle)), so its next turn reads \(tokens) cached tokens instead of re-sending them. \(costs) Staying saves about \(saving)."
        case .expired:
            // The saving the operator thinks they are protecting is already
            // gone: both options re-write the whole prompt, so this is a
            // straight price-per-token comparison between the two models.
            if delta > 0 {
                return "Switching is cheaper. This conversation has been idle \(idle), so its prompt cache has already expired and all \(tokens) tokens are re-sent either way — the only difference is each model's rate. \(costs) Switching saves about \(saving)."
            }
            return "Staying on the current model is cheaper, but not because of its cache — that expired \(idle) into idle, so all \(tokens) tokens are re-sent either way. The difference is each model's rate. \(costs) Staying saves about \(saving)."
        case .unsupported:
            // No cache is ever written, so again a straight rate comparison.
            if delta > 0 {
                return "Switching is cheaper. The current model does not cache prompts, so all \(tokens) tokens are re-sent on every turn either way. \(costs) Switching saves about \(saving)."
            }
            return "Staying on the current model is cheaper. It does not cache prompts, so all \(tokens) tokens are re-sent either way and the difference is each model's rate. \(costs) Staying saves about \(saving)."
        case .unknown:
            // Handled above; the compiler needs the arm.
            return costs
        }
    }

    /// The reason line shown under the cost, or nil when there is no honest
    /// reason to give.
    ///
    /// The per-model-cache explanation only means something while a cache
    /// exists to lose. Once it has expired — or when the model never cached —
    /// repeating "the new model cannot read the cache this conversation already
    /// built" describes a cache that is not there, and implies a saving the
    /// operator would be protecting by staying put when there is none.
    static func reason(_ estimate: Estimate) -> String? {
        guard estimate.priced else { return nil }
        switch estimate.cacheState {
        case .warm, .unknown:
            return "A prompt cache belongs to one model, so the new model cannot read the cache this conversation already built."
        case .expired, .unsupported:
            return nil
        }
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

    /// Idle time in the coarsest unit that stays truthful, for a sentence the
    /// operator reads at a glance. Nil renders as "a while" rather than a fake
    /// number.
    static func formatDuration(_ seconds: Double?) -> String {
        guard let seconds, seconds.isFinite else { return "a while" }
        if seconds < 90 { return "\(Int(seconds.rounded()))s" }
        let minutes = seconds / 60
        if minutes < 90 { return "\(Int(minutes.rounded()))m" }
        let hours = minutes / 60
        if hours < 36 { return "\(Int(hours.rounded()))h" }
        return "\(Int((hours / 24).rounded()))d"
    }

    /// USD with enough precision to stay honest at small amounts. A switch that
    /// costs a third of a cent must not render as "$0.00" — that reads as free.
    static func formatUsd(_ amount: Double) -> String {
        if amount > 0 && amount < 0.01 { return "<$0.01" }
        let roundedCents = ((amount + Double.ulpOfOne) * 100).rounded() / 100
        return String(format: "$%.2f", roundedCents)
    }
}
