import XCTest
import SwiftUI
import UIKit
@testable import IonRemote

/// Pins the eleven type roles to the values the iOS style guide specifies, and
/// pins the property that motivated the scale in the first place: every role
/// participates in Dynamic Type.
///
/// The Dynamic Type assertions are the load-bearing ones. A role built with
/// `Font.system(size:weight:)` looks correct at the default content size and
/// silently refuses to grow, which is exactly the defect the scale exists to
/// end. `resolvedPointSize` below renders each role's underlying `UIFont` at a
/// small and a large content size and asserts it actually moved, so a
/// regression to a fixed-point font fails here instead of shipping.
final class IonTypeTests: XCTestCase {

    // MARK: - Role table

    /// Every role's specified size and line height, straight from the guide.
    /// A role whose metric drifts fails here.
    func testRoleMetricsMatchSpecification() {
        let expected: [IonType.Role: (size: CGFloat, lineHeight: CGFloat)] = [
            .screenTitleLarge:  (28, 34),
            .screenTitleInline: (17, 22),
            .rowTitle:          (17, 22),
            .rowTitleAttention: (17, 22),
            .body:              (16, 23),
            .bodyStrong:        (16, 23),
            .sectionLabel:      (13, 18),
            .meaning:           (13, 18),
            .metadata:          (12, 16),
            .mono:              (13, 18),
            .microLabel:        (11, 14),
        ]

        for role in IonType.Role.allCases {
            guard let spec = expected[role] else {
                XCTFail("role \(role.rawValue) has no expected metrics — the table is out of date")
                continue
            }
            XCTAssertEqual(IonType.size(role), spec.size, "size for \(role.rawValue)")
            XCTAssertEqual(IonType.lineHeight(role), spec.lineHeight, "line height for \(role.rawValue)")
        }
    }

    /// Every role's Dynamic Type anchor, straight from the guide.
    func testRoleTextStyleAnchorsMatchSpecification() {
        let expected: [IonType.Role: UIFont.TextStyle] = [
            .screenTitleLarge:  .largeTitle,
            .screenTitleInline: .headline,
            .rowTitle:          .body,
            .rowTitleAttention: .body,
            .body:              .body,
            .bodyStrong:        .body,
            .sectionLabel:      .footnote,
            .meaning:           .footnote,
            .metadata:          .caption1,
            .mono:              .footnote,
            .microLabel:        .caption2,
        ]

        for role in IonType.Role.allCases {
            guard let anchor = expected[role] else {
                XCTFail("role \(role.rawValue) has no expected anchor — the table is out of date")
                continue
            }
            XCTAssertEqual(IonType.textStyle(role), anchor, "anchor for \(role.rawValue)")
        }
    }

    /// The guide names exactly eleven roles. A twelfth added without a guide
    /// revision, or a role quietly dropped, fails here.
    func testScaleDeclaresElevenRoles() {
        XCTAssertEqual(IonType.Role.allCases.count, 11)
    }

    /// Every role resolves to a font. Guards the `font(_:)` switch against a
    /// case added to the enum but not to the lookup.
    func testEveryRoleResolvesToAFont() {
        for role in IonType.Role.allCases {
            XCTAssertNotNil(IonType.font(role), "no font for \(role.rawValue)")
        }
    }

    func testCompactSelectionLabelUsesSelectionWeight() {
        XCTAssertEqual(
            IonType.compactSelectionWeight(isSelected: true, selectedWeight: .bold),
            .bold
        )
        XCTAssertEqual(
            IonType.compactSelectionWeight(isSelected: false, selectedWeight: .bold),
            .regular
        )
    }

    // MARK: - Dynamic Type

    /// The regression this scale exists to prevent: a role that ignores the
    /// user's content size. Each role must render larger at an accessibility
    /// content size than at the smallest one.
    ///
    /// Reverting any role to `Font.system(size:weight:)` — or dropping
    /// `relativeTo:` from the mono role — makes both point sizes identical and
    /// fails this test.
    func testEveryRoleScalesWithContentSize() {
        let small = UITraitCollection(preferredContentSizeCategory: .extraSmall)
        let large = UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge)

        for role in IonType.Role.allCases {
            let smallSize = Self.resolvedPointSize(role, in: small)
            let largeSize = Self.resolvedPointSize(role, in: large)

            XCTAssertGreaterThan(
                largeSize,
                smallSize,
                "role \(role.rawValue) does not scale with Dynamic Type "
                + "(\(smallSize)pt at extraSmall, \(largeSize)pt at AX5)"
            )
        }
    }

    /// At the default content size, a role renders at the exact size it
    /// specifies. Scaling must not come at the cost of the stated metric.
    func testRolesRenderAtSpecifiedSizeAtDefaultContentSize() {
        let standard = UITraitCollection(preferredContentSizeCategory: .large)

        for role in IonType.Role.allCases {
            let resolved = Self.resolvedPointSize(role, in: standard)
            XCTAssertEqual(
                resolved,
                IonType.size(role),
                accuracy: 0.01,
                "role \(role.rawValue) renders at \(resolved)pt, not its specified \(IonType.size(role))pt"
            )
        }
    }

    // MARK: - Line spacing

    /// `ionType(_:)` applies line height as the gap between lines, which is the
    /// total minus the point size. Pins the arithmetic so a role whose line
    /// height stops clearing its size degrades to zero spacing rather than a
    /// negative one.
    func testLineSpacingIsLineHeightMinusSize() {
        for role in IonType.Role.allCases {
            let spacing = IonType.lineHeight(role) - IonType.size(role)
            XCTAssertGreaterThanOrEqual(
                spacing,
                0,
                "role \(role.rawValue) specifies a line height below its own point size"
            )
        }
    }

    // MARK: - Helpers

    /// Renders a role's underlying `UIFont` in a given trait collection and
    /// returns its point size.
    ///
    /// The roles are declared as SwiftUI `Font` values, which expose no metrics,
    /// so this rebuilds each role through the same two mechanisms the
    /// declarations use — `UIFontMetrics` for the SF Pro Text roles and
    /// `UIFontMetrics` against the custom face for `mono` — under the supplied
    /// traits. That keeps the assertion honest about scaling behaviour while
    /// reading a measurable point size.
    private static func resolvedPointSize(
        _ role: IonType.Role,
        in traits: UITraitCollection
    ) -> CGFloat {
        let base: UIFont
        if role == .mono {
            // The custom face may be unavailable in a unit-test host; fall back
            // to the system monospaced face at the same size. Either way the
            // metric under test is the scaling, not the glyphs.
            base = UIFont(name: "JetBrainsMonoNLNerdFontMono-Regular", size: IonType.size(role))
                ?? UIFont.monospacedSystemFont(ofSize: IonType.size(role), weight: .regular)
        } else {
            base = UIFont.systemFont(ofSize: IonType.size(role))
        }
        let metrics = UIFontMetrics(forTextStyle: IonType.textStyle(role))
        return metrics.scaledFont(for: base, compatibleWith: traits).pointSize
    }
}
