import SwiftUI
import Charts

/// The rendering of one Ion chart spec.
///
/// This is the drawing surface only: no chrome, no title, no copy button. The
/// card (`ChartCardView`) owns those, so the same plot can be embedded at
/// thumbnail size in a list and at full size in a detail sheet without the
/// chrome being duplicated or re-styled.
///
/// ── Why Swift Charts and not a rasterized image from the desktop ────────────
/// A chart shipped as a PNG would be frozen at the desktop's size and theme:
/// unreadable at phone width, wrong in dark mode, and unable to respond to
/// Dynamic Type. Drawing from the same structured spec means the phone gets a
/// real chart with real axes, and one shared schema stays the contract.
///
/// ── Why the two kinds take different renderers ──────────────────────────────
/// A radial chart has one scale by definition, and Swift Charts draws it well.
/// A CARTESIAN Ion chart may declare two: a dataset names its axis, and
/// `rightAxis` carries its own bounds and value format. A Swift Charts plot has
/// a single value scale, so both series would land on one domain — a rate of
/// 13% plotted against a volume axis reaching 380 flattens onto the baseline
/// and the chart shows no movement in data that moves. `ChartCartesianPlotView`
/// exists for exactly that: explicit per-axis geometry, so each series is drawn
/// against the scale it declared.
struct ChartPlotView: View {
    @Environment(\.appTheme) private var theme
    let spec: ChartSpec
    /// Nil means "no selection" — the caller owns selection state so a card
    /// and its expanded sheet do not fight over it.
    @Binding var selectedLabel: String?

    private var palette: [Color] { ChartPalette.series(theme) }

    var body: some View {
        if spec.kind.isRadial {
            radialChart
        } else {
            ChartCartesianPlotView(spec: spec)
        }
    }

    // MARK: - Radial (pie / doughnut)

    private var radialChart: some View {
        let dataset = spec.datasets.first
        let resolved = dataset?.resolvedData ?? []
        let colors = ChartMath.sliceColors(spec, palette: palette)

        return Chart {
            ForEach(Array(spec.labels.enumerated()), id: \.offset) { index, label in
                if index < resolved.count, let value = resolved[index] {
                    SectorMark(
                        angle: .value(label, value),
                        // A doughnut is a pie with a hole; the spec's kind is
                        // the only difference between the two renderings.
                        innerRadius: .ratio(spec.kind == .doughnut ? 0.6 : 0),
                        angularInset: 1,
                    )
                    .foregroundStyle(colors[index % colors.count])
                }
            }
        }
        .chartLegend(legendVisible ? .visible : .hidden)
        .chartLegend(position: legendPosition)
    }

    // MARK: - Legend resolution

    private var legendVisible: Bool {
        // Default: show a legend only when there is more than one thing to
        // name. A one-series legend repeats the title and wastes phone height.
        spec.legend?.visible ?? (spec.datasets.count > 1 || spec.kind.isRadial)
    }

    private var legendPosition: AnnotationPosition {
        switch spec.legend?.position {
        case .top: return .top
        case .left: return .leading
        case .right: return .trailing
        case .bottom, .none: return .bottom
        }
    }
}
