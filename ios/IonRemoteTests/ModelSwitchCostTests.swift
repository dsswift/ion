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

    func test_descriptionStatesBothCosts() {
        let text = ModelSwitchCost.describe(
            ModelSwitchCost.estimate(contextTokens: 650_000, targetModel: opus())!
        )
        XCTAssertTrue(text.contains("650K"))
        XCTAssertTrue(text.contains("$12.19"))
        XCTAssertTrue(text.contains("$0.98"))
    }
}
