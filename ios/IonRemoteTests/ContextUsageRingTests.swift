import XCTest
@testable import IonRemote

/// Geometry and threshold tests for the iOS context ring — the counterpart of
/// the desktop's StatusBarContextRadial.test.ts. The two clients must agree
/// about what a given occupancy looks like, so both pin the same numbers.
///
/// The ring replaced the percentage text, so the arc length and the
/// accessibility label are the entire signal.
final class ContextUsageRingTests: XCTestCase {

    func testTrimFractionAtZero() {
        XCTAssertEqual(ContextUsageRing.trimFraction(0), 0, accuracy: 0.0001)
    }

    func testTrimFractionAtHalf() {
        XCTAssertEqual(ContextUsageRing.trimFraction(50), 0.5, accuracy: 0.0001)
    }

    func testTrimFractionAtFull() {
        XCTAssertEqual(ContextUsageRing.trimFraction(100), 1.0, accuracy: 0.0001)
    }

    func testTrimFractionClampsGeometryWhenOverBudget() {
        // A ring cannot draw 220% of itself, so the arc saturates. This is the
        // only clamp in the pipeline — the accessibility label and the status
        // drawer carry the true uncapped figure.
        XCTAssertEqual(ContextUsageRing.trimFraction(220), 1.0, accuracy: 0.0001)
    }

    func testTrimFractionClampsNegative() {
        XCTAssertEqual(ContextUsageRing.trimFraction(-10), 0, accuracy: 0.0001)
    }

    func testLevelThresholds() {
        XCTAssertEqual(ContextUsageRing.level(0), .normal)
        XCTAssertEqual(ContextUsageRing.level(59), .normal)
        XCTAssertEqual(ContextUsageRing.level(60), .warning)
        XCTAssertEqual(ContextUsageRing.level(79), .warning)
        XCTAssertEqual(ContextUsageRing.level(80), .danger)
        XCTAssertEqual(ContextUsageRing.level(100), .danger)
        XCTAssertEqual(ContextUsageRing.level(220), .danger)
    }

    /// Every occupancy-coloring surface resolves through ContextUsageRing, so
    /// the strip and the status bar cannot disagree at the same percentage.
    /// They each carried a private copy of the ladder before this, and had
    /// already drifted: the strip returned .green at the normal level where the
    /// ring directly above it returned .secondary.
    func testConsumersResolveTheSameColor() {
        for pct in [0.0, 59.0, 60.0, 79.0, 80.0, 220.0] {
            XCTAssertEqual(
                ConversationContextStrip.color(pct),
                ContextUsageRing.color(for: pct),
                "the context strip must resolve the same color as the ring at \(pct)%",
            )
        }
    }

    func testColorMapFollowsTheLevels() {
        XCTAssertEqual(ContextUsageRing.color(for: 0), .secondary)
        XCTAssertEqual(ContextUsageRing.color(for: 60), .orange)
        XCTAssertEqual(ContextUsageRing.color(for: 80), .red)
    }

    // MARK: - Accessibility label

    func testAccessibilityLabelCarriesPercentAndTokens() {
        // No number is rendered as text any more, so the label is the sole
        // textual carrier of the figure.
        let bar = ConversationStatusBar(
            modelOverride: "claude-sonnet-4-6",
            preferredModel: "claude-sonnet-4-6",
            contextPercent: nil,
            contextTokens: 220_000,
            engineContextWindow: nil,
            isRunning: false,
            permissionMode: .auto,
            availableModels: [
                RemoteModelEntry(id: "claude-sonnet-4-6", providerId: "anthropic",
                                 label: "Sonnet 4.6", contextWindow: 200_000, hasAuth: true),
            ],
            attachmentCount: 0,
            onSelectModel: { _ in },
            onToggleMode: {},
            onTapAttachments: {},
        )
        let pct = bar.resolvedContextPercent
        XCTAssertNotNil(pct)
        XCTAssertEqual(pct!, 110.0, accuracy: 0.01)

        let label = bar.contextAccessibilityLabel(pct: pct!)
        XCTAssertTrue(label.contains("110"), "label must carry the true uncapped percent: \(label)")
        XCTAssertTrue(label.contains("220000"), "label must carry the token count: \(label)")
    }
}
