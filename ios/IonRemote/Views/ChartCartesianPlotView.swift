import SwiftUI

/// The Cartesian drawing surface for an Ion chart spec.
///
/// ── Why this is drawn rather than delegated to Swift Charts ─────────────────
/// A Swift Charts plot has ONE value scale. The Ion chart contract has two: a
/// dataset names its axis, and `rightAxis` carries its own title, bounds, and
/// value format — that is how a volume-and-rate chart is expressed, and the
/// desktop renders it against two Chart.js scales. Plotting both series on a
/// single scale does not merely look different: a rate of 13% drawn against a
/// volume axis reaching 380 collapses onto the baseline, so the chart shows a
/// flat line for data that is not flat. That is a chart that lies, which is
/// the one failure a chart must never have.
///
/// So the geometry is explicit here: each axis owns a domain, each series is
/// normalized against the domain its own axis defines, and annotations are
/// placed against the axis the spec names.
///
/// ── What is deliberately NOT here ───────────────────────────────────────────
/// Chrome — title, caption, copy, the value table — belongs to `ChartCardView`,
/// and radial charts stay with Swift Charts in `ChartPlotView`. This view draws
/// the plot and nothing else, so the card can embed it at any size.
struct ChartCartesianPlotView: View {
    @Environment(\.appTheme) private var theme
    let spec: ChartSpec

    /// Height reserved for the category labels below the plot.
    private let categoryGutter: CGFloat = 18

    /// Vertical room reserved above and below the plot for the tick labels that
    /// sit at the very ends of an axis.
    ///
    /// A tick label is centred on its tick, so half of the topmost one lies
    /// above the plot's top edge and half of the bottom one lies below its
    /// floor. Without this inset the card clipped `$40,000` against its own
    /// edge, which read as a rendering fault rather than as a label.
    private var tickOverhang: CGFloat { IonType.lineHeight(.microLabel) / 2 }

    private var palette: [Color] { ChartPalette.series(theme) }

    /// True when any dataset is measured against the right axis. The right
    /// gutter and its ticks exist only then, so a single-axis chart keeps the
    /// full width for its plot.
    private var usesRightAxis: Bool { spec.usesRightAxis }

    private var leftDomain: ClosedRange<Double> { ChartMath.domain(for: .left, in: spec) }
    private var rightDomain: ClosedRange<Double> { ChartMath.domain(for: .right, in: spec) }

    /// Tick-label font, resolved through the type role so the measured gutter
    /// and the drawn label are the same size at every Dynamic Type setting.
    private var tickFont: UIFont {
        UIFontMetrics(forTextStyle: IonType.textStyle(.microLabel))
            .scaledFont(for: .systemFont(ofSize: IonType.size(.microLabel), weight: .medium))
    }

    /// Each axis's gutter, measured from the labels it will actually print
    /// rather than assumed. See `ChartMath.axisGutterWidth`.
    private func gutter(_ axis: ChartAxisId) -> CGFloat {
        ChartMath.axisGutterWidth(for: axis, in: spec, font: tickFont)
    }

    var body: some View {
        VStack(spacing: IonSpace.hairlineGap) {
            if legendVisible, legendPosition == .top { legend }
            axisTitles
            HStack(spacing: 0) {
                tickColumn(axis: .left, domain: leftDomain)
                plotColumn
                if usesRightAxis {
                    tickColumn(axis: .right, domain: rightDomain)
                }
            }
            if let title = spec.categoryAxis?.title, !title.isEmpty {
                // The category axis names what the labels ARE. Without it a
                // reader sees P1…P6 and has to infer that they are periods —
                // the spec said so, and the desktop prints it.
                Text(title)
                    .ionType(.microLabel)
                    .foregroundStyle(theme.textSecondary)
            }
            if legendVisible, legendPosition != .top { legend }
        }
    }

    // MARK: - Axis titles

    @ViewBuilder
    private var axisTitles: some View {
        let left = spec.leftAxis?.title ?? ""
        let right = usesRightAxis ? (spec.rightAxis?.title ?? "") : ""
        if !left.isEmpty || !right.isEmpty {
            HStack {
                Text(left)
                    .ionType(.microLabel)
                    .foregroundStyle(theme.textSecondary)
                Spacer(minLength: 0)
                // The right axis names its own quantity. Without this label a
                // dual-axis chart gives the reader no way to tell which scale
                // a series belongs to.
                Text(right)
                    .ionType(.microLabel)
                    .foregroundStyle(theme.textSecondary)
            }
        }
    }

    // MARK: - Tick columns

    /// One axis's tick labels, in that axis's OWN value format.
    ///
    /// The format is per-axis on purpose: a currency left axis beside a percent
    /// right axis is the common dual-scale chart, and formatting both with one
    /// format would mislabel one of them.
    private func tickColumn(axis: ChartAxisId, domain: ClosedRange<Double>) -> some View {
        let logarithmic = ChartMath.axisDefinition(axis, in: spec)?.scale == .logarithmic
        let format = ChartMath.format(for: axis, in: spec)
        let width = gutter(axis)
        return GeometryReader { geo in
            let plotHeight = plotHeight(in: geo.size)
            ForEach(Array(ChartMath.ticks(for: domain).enumerated()), id: \.offset) { _, value in
                let fraction = ChartMath.normalized(value, in: domain, logarithmic: logarithmic)
                Text(ChartMath.formatted(value, format))
                    .ionType(.microLabel)
                    .foregroundStyle(theme.textTertiary)
                    // One line, always. A wrapped tick label reads as two
                    // different numbers stacked on each other.
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .frame(width: width, alignment: axis == .left ? .trailing : .leading)
                    .position(
                        x: width / 2,
                        y: tickOverhang + plotHeight - (plotHeight * fraction),
                    )
            }
        }
        .frame(width: width)
    }

    // MARK: - Plot

    /// The drawing height inside a given container: the container less the
    /// category labels below it and the tick overhang at both ends.
    private func plotHeight(in size: CGSize) -> CGFloat {
        max(size.height - categoryGutter - (tickOverhang * 2), 1)
    }

    private var plotColumn: some View {
        GeometryReader { geo in
            let plotHeight = plotHeight(in: geo.size)
            let plotSize = CGSize(width: geo.size.width, height: plotHeight)
            ZStack(alignment: .topLeading) {
                gridLines(size: plotSize)
                bands(size: plotSize)
                seriesLayer(size: plotSize)
                referenceLines(size: plotSize)
            }
            .frame(width: geo.size.width, height: plotHeight)
            .offset(y: tickOverhang)
            categoryLabels(size: plotSize)
                .frame(width: geo.size.width, height: categoryGutter)
                .offset(y: tickOverhang + plotHeight)
        }
    }

    private func gridLines(size: CGSize) -> some View {
        // Grid lines follow the LEFT axis only. A second set from the right
        // axis would double every horizontal rule — the same rule the desktop
        // mapper applies (`drawOnChartArea` on the left scale alone).
        let domain = leftDomain
        let logarithmic = spec.leftAxis?.scale == .logarithmic
        return ZStack(alignment: .topLeading) {
            ForEach(Array(ChartMath.ticks(for: domain).enumerated()), id: \.offset) { _, value in
                let fraction = ChartMath.normalized(value, in: domain, logarithmic: logarithmic)
                Rectangle()
                    .fill(theme.borderSubtle.opacity(0.45))
                    .frame(width: size.width, height: 0.5)
                    .offset(y: size.height - (size.height * fraction))
            }
        }
    }

    // MARK: - Range bands

    private func bands(size: CGSize) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(Array((spec.rangeBands ?? []).enumerated()), id: \.offset) { _, band in
                // The band is placed against the axis it NAMES. A band bound to
                // the right axis drawn on the left scale marks an unrelated
                // region of the plot.
                let axis = band.axis ?? .left
                let domain = axis == .right ? rightDomain : leftDomain
                let logarithmic = ChartMath.axisDefinition(axis, in: spec)?.scale == .logarithmic
                let top = ChartMath.normalized(max(band.from, band.to), in: domain, logarithmic: logarithmic)
                let bottom = ChartMath.normalized(min(band.from, band.to), in: domain, logarithmic: logarithmic)
                let height = max((top - bottom) * size.height, 1)
                ZStack(alignment: .topLeading) {
                    Rectangle()
                        .fill((color(band.color) ?? theme.accent).opacity(0.12))
                    if let label = band.label, !label.isEmpty {
                        // A band with no name is an unexplained coloured
                        // region. The spec supplied the name and the desktop
                        // prints it, so a reader gets the same answer on both.
                        Text(label)
                            .ionType(.microLabel)
                            .foregroundStyle(theme.textTertiary)
                            .lineLimit(1)
                            .padding(.horizontal, IonSpace.hairlineGap)
                            .padding(.top, 1)
                    }
                }
                .frame(width: size.width, height: height, alignment: .topLeading)
                .clipped()
                .offset(y: size.height - (size.height * top))
            }
        }
    }

    // MARK: - Reference lines

    private func referenceLines(size: CGSize) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(Array((spec.referenceLines ?? []).enumerated()), id: \.offset) { _, line in
                let axis = line.axis ?? .left
                let domain = axis == .right ? rightDomain : leftDomain
                let logarithmic = ChartMath.axisDefinition(axis, in: spec)?.scale == .logarithmic
                let fraction = ChartMath.normalized(line.value, in: domain, logarithmic: logarithmic)
                let y = size.height - (size.height * fraction)
                ZStack(alignment: .topTrailing) {
                    Rectangle()
                        .fill(color(line.color) ?? theme.textSecondary)
                        .frame(width: size.width, height: 1)
                    if let label = line.label {
                        // The value is stated in the label's OWN axis format,
                        // so a target on a currency axis reads as money.
                        //
                        // Drawn on an opaque chip, and inset from the plot's
                        // trailing edge: bare text ran into the right axis's
                        // own tick, so "Rate target · 13.0%" and "13.0%"
                        // overprinted each other. The desktop's annotation
                        // label carries the same background for the same
                        // reason.
                        Text("\(label) · \(ChartMath.formatted(line.value, ChartMath.format(for: axis, in: spec)))")
                            .ionType(.microLabel)
                            .foregroundStyle(theme.textSecondary)
                            .lineLimit(1)
                            .padding(.horizontal, IonSpace.hairlineGap)
                            .padding(.vertical, 1)
                            .background(
                                RoundedRectangle(cornerRadius: IonRadius.control / 2, style: .continuous)
                                    .fill(theme.surfaceSecondary),
                            )
                            .padding(.trailing, IonSpace.hairlineGap)
                            .offset(y: -12)
                    }
                }
                .frame(width: size.width, alignment: .topTrailing)
                .offset(y: y)
            }
        }
    }

    // MARK: - Series

    private func seriesLayer(size: CGSize) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach(Array(spec.datasets.enumerated()), id: \.offset) { index, dataset in
                ChartSeriesShapeView(
                    spec: spec,
                    dataset: dataset,
                    color: ChartMath.seriesColor(dataset, index: index, palette: palette),
                    size: size,
                    barSlot: barSlot(for: dataset),
                    theme: theme,
                )
            }
        }
    }

    /// Where a bar series sits inside its category slot.
    ///
    /// Stacked bars share one slot (they are drawn on top of each other);
    /// grouped bars each take a share of it, which is what keeps two series
    /// side by side instead of one hiding the other.
    private func barSlot(for dataset: ChartDataset) -> ChartBarSlot {
        let bars = spec.datasets.filter { candidate in
            (candidate.kind ?? (spec.kind == .bar ? .bar : .line)) == .bar
        }
        guard spec.stacked != true else { return ChartBarSlot(index: 0, count: 1) }
        let position = bars.firstIndex { $0.label == dataset.label } ?? 0
        return ChartBarSlot(index: position, count: max(bars.count, 1))
    }

    // MARK: - Category labels

    private func categoryLabels(size: CGSize) -> some View {
        HStack(spacing: 0) {
            ForEach(Array(spec.labels.enumerated()), id: \.offset) { _, label in
                Text(label)
                    .ionType(.microLabel)
                    .foregroundStyle(theme.textSecondary)
                    .lineLimit(1)
                    .frame(width: size.width / CGFloat(max(spec.labels.count, 1)))
            }
        }
    }

    // MARK: - Legend

    private var legendVisible: Bool {
        // Same default as the desktop: a legend earns its space only when
        // there is more than one series to name.
        spec.legend?.visible ?? (spec.datasets.count > 1)
    }

    /// Where the legend sits. The spec's own choice, defaulting to bottom.
    ///
    /// `left` and `right` collapse to `bottom` deliberately: a phone-width
    /// card has no horizontal room to give a legend a column, and taking one
    /// would leave the plot narrower than the series it must show. The
    /// vertical choice the spec expressed is honoured; the horizontal one is
    /// answered with the nearest thing this width can render.
    private var legendPosition: ChartLegendPosition {
        switch spec.legend?.position {
        case .top: return .top
        case .bottom, .left, .right, .none: return .bottom
        }
    }

    /// The series key.
    ///
    /// Laid out as a wrapping flow rather than one row: three series with long
    /// names exceed a phone-width card, and a single `HStack` would push the
    /// last entry off the edge — the one series the reader cannot identify is
    /// then the one the legend was for. Entries wrap onto a second line
    /// instead, which costs height only when the width actually runs out.
    private var legend: some View {
        ChartLegendFlow(spacing: IonSpace.contentGap, rowSpacing: IonSpace.hairlineGap) {
            ForEach(Array(spec.datasets.enumerated()), id: \.offset) { index, dataset in
                HStack(spacing: 4) {
                    Circle()
                        .fill(ChartMath.seriesColor(dataset, index: index, palette: palette))
                        .frame(width: 7, height: 7)
                    Text(dataset.label)
                        .ionType(.microLabel)
                        .foregroundStyle(theme.textSecondary)
                    if ChartMath.axis(of: dataset) == .right {
                        // Which scale a series is measured against is data the
                        // reader needs; without it a dual-axis chart is
                        // ambiguous by construction.
                        Text("(right)")
                            .ionType(.microLabel)
                            .foregroundStyle(theme.textTertiary)
                    }
                }
                .fixedSize()
            }
        }
    }

    private func color(_ hex: String?) -> Color? {
        guard let hex else { return nil }
        return Color(rgbaHex: hex)
    }
}

/// A bar's position within its category slot.
struct ChartBarSlot {
    let index: Int
    let count: Int
}
