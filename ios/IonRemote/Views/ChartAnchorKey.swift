import SwiftUI
import UIKit

/// Where a chart card sits, in the scroll view's coordinate space.
///
/// ── Why a jump needs this ───────────────────────────────────────────────────
/// A transcript row is a whole TURN: assistant text, then tool rows, then the
/// chart card at the very end. Scrolling to the row lands at the top of the
/// turn, which on a tall turn leaves the chart the operator tapped well below
/// the fold. The desktop hit exactly this and fixed it by measuring the chart
/// element and targeting that instead of the row.
///
/// iOS cannot query a subview position the way the desktop queries the DOM: a
/// row is a SwiftUI view inside a `UIHostingConfiguration`, and reaching into
/// that hierarchy to find a card would depend on UIKit's private view tree.
/// So the card reports its own position through a preference, and the scroll
/// code reads the report.
///
/// The card reports its offset WITHIN ITS ROW, not a screen position. A global
/// frame is only true for the instant it was measured: scroll the list and
/// every global frame is stale, and a card that has scrolled out of view stops
/// reporting altogether, so its last value is from an arbitrary past scroll
/// position. Applying that as if it were current sent jumps to the top or the
/// bottom of the conversation at random, and appeared to "work" only for a
/// chart that happened to be on screen already.
///
/// An offset within the row is scroll-invariant: the card sits the same
/// distance below its row's top edge no matter where that row is. The scroll
/// code knows where the row is, so row-top plus this offset is always the
/// card's real position.
struct ChartAnchorKey: PreferenceKey {
    /// Name of the coordinate space a transcript row declares, against which a
    /// chart card measures its own offset.
    static let rowSpace = "chartRow"
    /// chartId → the card's offset from the top of its enclosing row.
    static let defaultValue: [String: CGFloat] = [:]

    static func reduce(value: inout [String: CGFloat], nextValue: () -> [String: CGFloat]) {
        value.merge(nextValue()) { _, new in new }
    }
}

/// Latest reported position of every visible chart card.
///
/// A shared store rather than a value threaded through the view tree: the
/// reader is a UIKit view controller several layers away from the SwiftUI card,
/// and the two are connected only by the collection view that hosts them.
///
/// Entries are overwritten as cards re-measure and are read immediately, so
/// staleness is bounded by the frame that wrote them. A card that scrolls out
/// of view stops reporting; its last entry lingers, which is harmless because
/// a jump re-resolves the row through the data source first and only uses this
/// to refine the offset.
@MainActor
final class ChartAnchorRegistry {
    static let shared = ChartAnchorRegistry()

    private var offsets: [String: CGFloat] = [:]

    private init() {}

    func record(_ reported: [String: CGFloat]) {
        offsets.merge(reported) { _, new in new }
    }

    /// How far the card sits below the top of its row, or nil when the card has
    /// never laid out. Scroll-invariant, so a value measured minutes ago is
    /// still correct.
    func offsetWithinRow(for chartId: String) -> CGFloat? {
        offsets[chartId]
    }
}

extension View {
    /// Publish how far this chart card sits below the top of its row, so a jump
    /// can target the card rather than the top of the turn that contains it.
    ///
    /// Measured against the named `chartRow` coordinate space, which the row
    /// declares. That makes the value independent of where the row currently
    /// is on screen — the property that a global frame does not have.
    func reportsChartAnchor(chartId: String) -> some View {
        background(
            GeometryReader { proxy in
                Color.clear.preference(
                    key: ChartAnchorKey.self,
                    value: [chartId: proxy.frame(in: .named(ChartAnchorKey.rowSpace)).minY]
                )
            }
        )
    }
}
