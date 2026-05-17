import SwiftUI

/// Draws git graph lanes for a single commit row using SwiftUI Canvas.
///
/// The Canvas stretches to fill the full height of the containing row via
/// `.frame(maxHeight: .infinity)`. This ensures lines run seamlessly from
/// one row to the next — no gaps between consecutive commits.
///
/// The commit dot sits at `dotCenterY` (a fixed offset from the top, aligned
/// with the first line of the commit subject text). Connections run from
/// `dotCenterY` to the bottom edge; incoming lines run from the top edge to
/// `dotCenterY`. Pass-through lanes span the full height.
struct GitGraphLaneView: View {
    let layout: GraphLayoutEntry

    private let laneWidth: CGFloat = 16
    private let leftPad: CGFloat = 10
    private let dotRadius: CGFloat = 4
    private let lineWidth: CGFloat = 2.0
    /// Vertical offset for the commit dot — aligned with the first text line
    /// (8pt padding + half of ~18pt subheadline line height ≈ 17pt).
    private let dotCenterY: CGFloat = 17

    private var maxLane: Int {
        var m = layout.lane
        for pt in layout.passThroughLanes { m = max(m, pt.lane) }
        for conn in layout.connections { m = max(m, max(conn.fromLane, conn.toLane)) }
        return m
    }

    private var graphWidth: CGFloat {
        CGFloat(maxLane + 1) * laneWidth + leftPad + 4
    }

    private func x(for lane: Int) -> CGFloat {
        CGFloat(lane) * laneWidth + leftPad
    }

    var body: some View {
        Canvas { context, size in
            let cy = dotCenterY
            let bottom = size.height
            let commitX = x(for: layout.lane)

            // 1. Pass-through lanes (full height, dimmed)
            for pt in layout.passThroughLanes {
                let px = x(for: pt.lane)
                var path = Path()
                path.move(to: CGPoint(x: px, y: 0))
                path.addLine(to: CGPoint(x: px, y: bottom))
                var ctx = context
                ctx.opacity = 0.35
                ctx.stroke(path, with: .color(Color(hex: pt.color)), lineWidth: lineWidth)
            }

            // 2. Incoming line (top edge → dot)
            if layout.hasIncoming {
                var path = Path()
                path.move(to: CGPoint(x: commitX, y: 0))
                path.addLine(to: CGPoint(x: commitX, y: cy))
                context.stroke(path, with: .color(Color(hex: layout.color)), lineWidth: lineWidth)
            }

            // 3. Connections (dot → bottom edge, curving toward parent lanes)
            for conn in layout.connections {
                let x1 = x(for: conn.fromLane)
                let x2 = x(for: conn.toLane)

                var path = Path()
                path.move(to: CGPoint(x: x1, y: cy))

                if conn.fromLane == conn.toLane {
                    // Straight vertical
                    path.addLine(to: CGPoint(x: x2, y: bottom))
                } else {
                    // Smooth S-bend
                    let midY = cy + (bottom - cy) * 0.5
                    path.addCurve(
                        to: CGPoint(x: x2, y: bottom),
                        control1: CGPoint(x: x1, y: midY),
                        control2: CGPoint(x: x2, y: midY)
                    )
                }

                context.stroke(path, with: .color(Color(hex: conn.color)), lineWidth: lineWidth)
            }

            // 4. Commit dot with subtle ring
            let dotRect = CGRect(
                x: commitX - dotRadius,
                y: cy - dotRadius,
                width: dotRadius * 2,
                height: dotRadius * 2
            )
            let dotColor = Color(hex: layout.color)

            context.stroke(
                Path(ellipseIn: dotRect.insetBy(dx: -1, dy: -1)),
                with: .color(dotColor.opacity(0.3)),
                lineWidth: 1.5
            )
            context.fill(Path(ellipseIn: dotRect), with: .color(dotColor))
        }
        .frame(width: graphWidth)
        .frame(maxHeight: .infinity)
    }
}

// Color(hex: String) is defined in AgentBarRow.swift as a module-wide extension.
