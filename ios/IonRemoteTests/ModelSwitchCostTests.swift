import XCTest
@testable import IonRemote

/// Pins the Swift model-switch cost estimator against the TypeScript one in
/// `desktop/src/shared/model-switch-cost.ts`.
///
/// Both clients warn the operator about the same money, so they must produce
/// the same numbers and the same strings. A drift here would mean the phone and
/// the desktop quote different costs for an identical switch, and the operator
/// would have no way to know which is right. The expected values below are the
/// ones asserted by `model-switch-cost.test.ts`.
final class ModelSwitchCostTests: XCTestCase {

    private func opus(
        rate: Double? = 0.015,
        cacheCreationRate: Double? = nil,
        cacheReadRate: Double? = nil
    ) -> RemoteModelEntry {
        RemoteModelEntry(
            id: "claude-opus-5",
            providerId: "example-provider",
            label: "Opus",
            contextWindow: 1_000_000,
            hasAuth: true,
            costPer1kInput: rate,
            costPer1kCacheCreation: cacheCreationRate,
            costPer1kCacheRead: cacheReadRate
        )
    }

    /// A caching model with a 5-minute cache, the shape the engine publishes.
    private func caching(
        supportsCaching: Bool? = true,
        ttlSeconds: Int? = 300
    ) -> RemoteModelEntry {
        RemoteModelEntry(
            id: "claude-fable-5-1",
            providerId: "example-provider",
            label: "Fable",
            contextWindow: 1_000_000,
            hasAuth: true,
            costPer1kInput: 0.01,
            costPer1kCacheCreation: 0.0125,
            costPer1kCacheRead: 0.00025,
            supportsCaching: supportsCaching,
            cacheTtlSeconds: ttlSeconds
        )
    }

    private let now = Date(timeIntervalSince1970: 1_700_000_000)
    /// Inside the 5-minute cache window.
    private var warmActivity: Date { now.addingTimeInterval(-60) }
    /// Past the 5-minute cache window.
    private var coldActivity: Date { now.addingTimeInterval(-30 * 60) }

    // MARK: - Suppression

    func test_freshConversationHasNoSwitchCost() {
        // No history means nothing is re-sent, so the operator must not be
        // interrupted. This is the fresh / just-cleared case.
        XCTAssertNil(ModelSwitchCost.estimate(contextTokens: 0, targetModel: opus()))
        XCTAssertNil(ModelSwitchCost.estimate(contextTokens: nil, targetModel: opus()))
    }

    func test_noTargetModelHasNoSwitchCost() {
        XCTAssertNil(ModelSwitchCost.estimate(contextTokens: 650_000, targetModel: nil))
    }

    // MARK: - Pricing parity with the TypeScript estimator

    func test_pricesTheRewriteAtTheCacheCreationRate() {
        let est = ModelSwitchCost.estimate(contextTokens: 650_000, targetModel: opus())
        XCTAssertNotNil(est)
        XCTAssertEqual(est!.tokens, 650_000)
        XCTAssertTrue(est!.priced)
        XCTAssertEqual(
            est!.costUsd,
            650 * 0.015 * ModelSwitchCost.cacheCreationFallbackMultiplier,
            accuracy: 0.000001
        )
    }

    func test_usesExplicitCacheRatesBeforeFallbacks() {
        let est = ModelSwitchCost.estimate(
            contextTokens: 650_000,
            targetModel: opus(cacheCreationRate: 0.020, cacheReadRate: 0.001)
        )!
        XCTAssertEqual(est.costUsd, 650 * 0.020, accuracy: 0.000001)
        XCTAssertEqual(est.cachedCostUsd!, 650 * 0.001, accuracy: 0.000001)
    }

    func test_fallsBackIndependentlyWhenCacheRatesAreAbsent() {
        let creationOnly = ModelSwitchCost.estimate(
            contextTokens: 650_000,
            targetModel: opus(cacheCreationRate: 0.020)
        )!
        XCTAssertEqual(creationOnly.costUsd, 650 * 0.020, accuracy: 0.000001)
        XCTAssertEqual(creationOnly.cachedCostUsd!, 650 * 0.015 * ModelSwitchCost.cacheReadFallbackMultiplier, accuracy: 0.000001)

        let readOnly = ModelSwitchCost.estimate(
            contextTokens: 650_000,
            targetModel: opus(cacheReadRate: 0.001)
        )!
        XCTAssertEqual(readOnly.costUsd, 650 * 0.015 * ModelSwitchCost.cacheCreationFallbackMultiplier, accuracy: 0.000001)
        XCTAssertEqual(readOnly.cachedCostUsd!, 650 * 0.001, accuracy: 0.000001)
    }

    func test_invalidExplicitRatesUseFallbacks() {
        for explicit in [0.0, Double.nan] {
            let est = ModelSwitchCost.estimate(
                contextTokens: 650_000,
                targetModel: opus(cacheCreationRate: explicit, cacheReadRate: explicit)
            )!
            XCTAssertEqual(est.costUsd, 650 * 0.015 * ModelSwitchCost.cacheCreationFallbackMultiplier, accuracy: 0.000001)
            XCTAssertEqual(est.cachedCostUsd!, 650 * 0.015 * ModelSwitchCost.cacheReadFallbackMultiplier, accuracy: 0.000001)
        }
    }

    func test_usesCurrentModelRateForStayPutComparison() {
        let target = opus(cacheCreationRate: 0.020, cacheReadRate: 0.003)
        let current = RemoteModelEntry(
            id: "current-model",
            providerId: "anthropic",
            label: "Current",
            contextWindow: 1_000_000,
            hasAuth: true,
            costPer1kInput: 0.003,
            costPer1kCacheRead: 0.0002
        )
        let est = ModelSwitchCost.estimate(
            contextTokens: 650_000,
            targetModel: target,
            currentModel: current
        )!
        XCTAssertEqual(est.costUsd, 650 * 0.020, accuracy: 0.000001)
        XCTAssertEqual(est.cachedCostUsd!, 650 * 0.0002, accuracy: 0.000001)
    }

    func test_reportsTheStayPutCostForComparison() {
        let est = ModelSwitchCost.estimate(contextTokens: 650_000, targetModel: opus())!
        XCTAssertEqual(
            est.cachedCostUsd!,
            650 * 0.015 * ModelSwitchCost.cacheReadFallbackMultiplier,
            accuracy: 0.000001
        )
        // 1.25 vs 0.1 — the switch costs 12.5x what staying put costs for the
        // same tokens. That ratio is the reason this warning exists.
        XCTAssertEqual(est.costUsd / est.cachedCostUsd!, 12.5, accuracy: 0.000001)
    }

    func test_multipliersMatchTheEngineFallbacks() {
        XCTAssertEqual(ModelSwitchCost.cacheCreationFallbackMultiplier, 1.25)
        XCTAssertEqual(ModelSwitchCost.cacheReadFallbackMultiplier, 0.10)
    }

    // MARK: - Honesty of the rendered figures

    func test_unpricedModelIsMarkedRatherThanReportedAsFree() {
        let est = ModelSwitchCost.estimate(contextTokens: 650_000, targetModel: opus(rate: nil))!
        XCTAssertFalse(est.priced)
        XCTAssertEqual(est.tokens, 650_000)
        XCTAssertTrue(ModelSwitchCost.describe(est).contains("cost is unknown"))
    }

    func test_smallCostNeverRendersAsZero() {
        // A third of a cent is not free. "$0.00" would tell the operator the
        // switch costs nothing, which inverts the feature's purpose.
        XCTAssertEqual(ModelSwitchCost.formatUsd(0.003), "<$0.01")
        XCTAssertEqual(ModelSwitchCost.formatUsd(12.1875), "$12.19")
        XCTAssertEqual(ModelSwitchCost.formatUsd(0), "$0.00")
    }

    func test_tokenCountFormattingMatchesTheDesktop() {
        XCTAssertEqual(ModelSwitchCost.formatTokenCount(650), "650")
        XCTAssertEqual(ModelSwitchCost.formatTokenCount(1_200), "1K")
        XCTAssertEqual(ModelSwitchCost.formatTokenCount(650_000), "650K")
        XCTAssertEqual(ModelSwitchCost.formatTokenCount(1_500_000), "1.5M")
    }

    // MARK: - Cache age decides the stay-put rate

    // The cache's age is what makes the stay-put figure true or false. These
    // are the arms that were wrong before: the estimator priced every stay-put
    // side at the cache-read rate unconditionally, so an idle conversation was
    // quoted a saving that had already expired.

    func test_livesCacheIsPricedAtTheReadRate() {
        let est = ModelSwitchCost.estimate(
            contextTokens: 169_000,
            targetModel: opus(),
            currentModel: caching(),
            lastActivityAt: warmActivity,
            now: now
        )!
        XCTAssertEqual(est.cacheState, .warm)
        XCTAssertEqual(est.cachedCostUsd!, 169 * 0.00025, accuracy: 0.000001)
        XCTAssertEqual(est.idleSeconds!, 60, accuracy: 0.000001)
        XCTAssertEqual(est.cacheTtlSeconds, 300)
    }

    func test_expiredCacheIsPricedAtTheCreationRate() {
        let est = ModelSwitchCost.estimate(
            contextTokens: 169_000,
            targetModel: opus(),
            currentModel: caching(),
            lastActivityAt: coldActivity,
            now: now
        )!
        XCTAssertEqual(est.cacheState, .expired)
        // The next turn on the CURRENT model rewrites the whole prompt, exactly
        // as a switch would. That is the creation rate.
        XCTAssertEqual(est.cachedCostUsd!, 169 * 0.0125, accuracy: 0.000001)
        // 50x the figure the read rate would have produced — the size of the
        // error, and why an approximation here is not acceptable.
        XCTAssertEqual(est.cachedCostUsd! / (169 * 0.00025), 50, accuracy: 0.000001)
    }

    func test_switchingCanBeCheaperThanStaying() {
        // The real case: a 169K conversation idle for half an hour on Fable,
        // switching to Opus. Fable's rewrite costs more than Opus's does, so
        // "stay put and save" is backwards.
        let opus5 = RemoteModelEntry(
            id: "claude-opus-5",
            providerId: "example-provider",
            label: "Opus",
            contextWindow: 1_000_000,
            hasAuth: true,
            costPer1kInput: 0.005,
            costPer1kCacheCreation: 0.00625,
            costPer1kCacheRead: 0.0005,
            supportsCaching: true,
            cacheTtlSeconds: 300
        )
        let est = ModelSwitchCost.estimate(
            contextTokens: 169_000,
            targetModel: opus5,
            currentModel: caching(),
            lastActivityAt: coldActivity,
            now: now
        )!
        XCTAssertLessThan(est.costUsd, est.cachedCostUsd!)
    }

    func test_ttlBoundaryIsStillReadable() {
        let atBoundary = ModelSwitchCost.estimate(
            contextTokens: 1_000,
            targetModel: opus(),
            currentModel: caching(),
            lastActivityAt: now.addingTimeInterval(-300),
            now: now
        )!
        XCTAssertEqual(atBoundary.cacheState, .warm)
        let pastBoundary = ModelSwitchCost.estimate(
            contextTokens: 1_000,
            targetModel: opus(),
            currentModel: caching(),
            lastActivityAt: now.addingTimeInterval(-300.001),
            now: now
        )!
        XCTAssertEqual(pastBoundary.cacheState, .expired)
    }

    func test_nonCachingModelIsPricedAtItsBaseInputRate() {
        let noCache = RemoteModelEntry(
            id: "gpt-4.1",
            providerId: "example-provider",
            label: "GPT",
            contextWindow: 1_000_000,
            hasAuth: true,
            costPer1kInput: 0.002,
            supportsCaching: false
        )
        let est = ModelSwitchCost.estimate(
            contextTokens: 169_000,
            targetModel: opus(),
            currentModel: noCache,
            lastActivityAt: warmActivity,
            now: now
        )!
        XCTAssertEqual(est.cacheState, .unsupported)
        XCTAssertEqual(est.cachedCostUsd!, 169 * 0.002, accuracy: 0.000001)
    }

    func test_missingActivityReportsUnknownRatherThanGuessing() {
        let est = ModelSwitchCost.estimate(
            contextTokens: 169_000,
            targetModel: opus(),
            currentModel: caching(),
            now: now
        )!
        XCTAssertEqual(est.cacheState, .unknown)
        XCTAssertNil(est.idleSeconds)
        // The warm rate is the lower bound, and the text must not state it as fact.
        XCTAssertEqual(est.cachedCostUsd!, 169 * 0.00025, accuracy: 0.000001)
        XCTAssertTrue(ModelSwitchCost.describe(est).contains("its age could not be determined"))
    }

    func test_missingTtlReportsUnknownRatherThanGuessing() {
        let est = ModelSwitchCost.estimate(
            contextTokens: 169_000,
            targetModel: opus(),
            currentModel: caching(ttlSeconds: nil),
            lastActivityAt: coldActivity,
            now: now
        )!
        XCTAssertEqual(est.cacheState, .unknown)
    }

    func test_clockSkewIsClampedInsteadOfReportingAFalseExpiry() {
        let est = ModelSwitchCost.estimate(
            contextTokens: 1_000,
            targetModel: opus(),
            currentModel: caching(),
            lastActivityAt: now.addingTimeInterval(60),
            now: now
        )!
        XCTAssertEqual(est.cacheState, .warm)
        XCTAssertEqual(est.idleSeconds!, 0, accuracy: 0.000001)
    }

    // MARK: - The reason line

    func test_reasonExplainsTheCacheOnlyWhileOneExistsToLose() {
        let warm = ModelSwitchCost.estimate(
            contextTokens: 169_000,
            targetModel: opus(),
            currentModel: caching(),
            lastActivityAt: warmActivity,
            now: now
        )!
        XCTAssertTrue(ModelSwitchCost.reason(warm)!.contains("cannot read the cache"))

        // Repeating "the new model cannot read the cache this conversation
        // built" after that cache expired describes a cache that is not there.
        let cold = ModelSwitchCost.estimate(
            contextTokens: 169_000,
            targetModel: opus(),
            currentModel: caching(),
            lastActivityAt: coldActivity,
            now: now
        )!
        XCTAssertNil(ModelSwitchCost.reason(cold))
    }

    // The dialog must state which option is cheaper. The cache state is an
    // input the estimator already resolved, not a caveat handed to the operator.

    func test_warmCacheSaysStayingIsCheaper() {
        let est = ModelSwitchCost.estimate(
            contextTokens: 169_000,
            targetModel: opus(),
            currentModel: caching(),
            lastActivityAt: warmActivity,
            now: now
        )!
        let text = ModelSwitchCost.describe(est)
        XCTAssertTrue(text.contains("Staying on the current model is cheaper"))
        XCTAssertTrue(text.contains("still live"))
        XCTAssertTrue(text.contains("idle 60s"))
        XCTAssertTrue(text.contains("saves about $3.13"))
    }

    func test_expiredCacheSaysSwitchingIsCheaperWhenItIs() {
        // The reported case: 169K idle 30m on Fable, switching to Opus. Both
        // sides re-write the prompt, and Opus's rate is lower.
        let opus5 = RemoteModelEntry(
            id: "claude-opus-5",
            providerId: "example-provider",
            label: "Opus",
            contextWindow: 1_000_000,
            hasAuth: true,
            costPer1kInput: 0.005,
            costPer1kCacheCreation: 0.00625,
            costPer1kCacheRead: 0.0005,
            supportsCaching: true,
            cacheTtlSeconds: 300
        )
        let est = ModelSwitchCost.estimate(
            contextTokens: 169_000,
            targetModel: opus5,
            currentModel: caching(),
            lastActivityAt: coldActivity,
            now: now
        )!
        let text = ModelSwitchCost.describe(est)
        XCTAssertTrue(text.contains("Switching is cheaper"))
        XCTAssertTrue(text.contains("already expired"))
        XCTAssertTrue(text.contains("idle 30m"))
        XCTAssertTrue(text.contains("saves about $1.06"))
        // It must never claim a cache advantage that no longer exists.
        XCTAssertFalse(text.contains("still live"))
    }

    func test_expiredCacheStillNamesTheCheaperSide() {
        let est = ModelSwitchCost.estimate(
            contextTokens: 169_000,
            targetModel: opus(),
            currentModel: caching(),
            lastActivityAt: coldActivity,
            now: now
        )!
        let text = ModelSwitchCost.describe(est)
        XCTAssertTrue(text.contains("Staying on the current model is cheaper"))
        XCTAssertTrue(text.contains("not because of its cache"))
    }

    func test_hedgesOnlyWhenAnInputWasMissing() {
        let est = ModelSwitchCost.estimate(
            contextTokens: 169_000,
            targetModel: opus(),
            currentModel: caching(),
            now: now
        )!
        let text = ModelSwitchCost.describe(est)
        XCTAssertTrue(text.contains("its age could not be determined"))
        XCTAssertFalse(text.contains("is cheaper"))
    }

    func test_durationScalesToTheCoarsestTruthfulUnit() {
        XCTAssertEqual(ModelSwitchCost.formatDuration(45), "45s")
        XCTAssertEqual(ModelSwitchCost.formatDuration(600), "10m")
        XCTAssertEqual(ModelSwitchCost.formatDuration(7_200), "2h")
        XCTAssertEqual(ModelSwitchCost.formatDuration(72 * 3_600), "3d")
        XCTAssertEqual(ModelSwitchCost.formatDuration(nil), "a while")
    }

    func test_descriptionStatesBothCosts() {
        let text = ModelSwitchCost.describe(
            ModelSwitchCost.estimate(contextTokens: 650_000, targetModel: opus())!
        )
        XCTAssertTrue(text.contains("650K"))
        XCTAssertTrue(text.contains("$12.19"))
        XCTAssertTrue(text.contains("$0.98"))
    }
}
