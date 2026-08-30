import SwiftUI

/// A left-aligned layout that wraps its subviews onto new rows.
///
/// ── Why a custom `Layout` and not an `HStack` ───────────────────────────────
/// A chart legend is a variable number of variable-width entries. An `HStack`
/// gives every entry a share of one row, so three series with real names on a
/// phone-width card either compress each label to an unreadable width or push
/// the last entry past the card edge. Either way the reader loses the mapping
/// from color to series, which is the only thing a legend does.
///
/// `Layout` is the right primitive rather than a manual `GeometryReader` pass:
/// it is measured in the same pass that places it, so the container reports an
/// honest height for two rows instead of reserving one row and overflowing.
///
/// ── Deliberately not general ────────────────────────────────────────────────
/// This wraps and left-aligns. It has no alignment options, no justification,
/// and no reflow animation, because the legend needs none of them and every
/// option would be untested surface.
struct ChartLegendFlow: Layout {
    /// Horizontal gap between entries on one row.
    var spacing: CGFloat
    /// Vertical gap between rows.
    var rowSpacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        let rows = layoutRows(subviews: subviews, maxWidth: maxWidth)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.reduce(CGFloat(0)) { $0 + $1.height }
            + (rowSpacing * CGFloat(max(rows.count - 1, 0)))
        // An unconstrained proposal reports the natural width; a constrained
        // one reports the width it was given, so the legend fills the card
        // rather than shrinking to its longest row.
        return CGSize(width: maxWidth.isFinite ? maxWidth : width, height: height)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let rows = layoutRows(subviews: subviews, maxWidth: bounds.width)
        var y = bounds.minY
        for row in rows {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(
                    at: CGPoint(x: x, y: y + ((row.height - size.height) / 2)),
                    proposal: ProposedViewSize(size),
                )
                x += size.width + spacing
            }
            y += row.height + rowSpacing
        }
    }

    // MARK: - Row packing

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    /// Greedy first-fit packing: an entry joins the current row when it fits,
    /// and starts a new one when it does not. Greedy is correct here because
    /// legend order is meaningful — it matches series order, and reordering
    /// entries to balance the rows would break the correspondence a reader
    /// uses to match a color to a name.
    private func layoutRows(subviews: Subviews, maxWidth: CGFloat) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let advance = current.indices.isEmpty ? size.width : size.width + spacing
            if !current.indices.isEmpty, current.width + advance > maxWidth {
                rows.append(current)
                current = Row()
                current.indices = [index]
                current.width = size.width
                current.height = size.height
                continue
            }
            current.indices.append(index)
            current.width += advance
            current.height = max(current.height, size.height)
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }
}
