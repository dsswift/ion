import SwiftUI

/// One data series drawn against the axis it declares.
///
/// Split from `ChartCartesianPlotView` so each file holds one concern (that
/// view owns axes, grid, annotations, and legend; this owns the marks) and
/// both stay well under the Swift size cap.
///
/// ── The rule every branch here obeys ────────────────────────────────────────
/// A `nil` is a GAP, never a zero. A line breaks across it, an area stops, and
/// a bar is simply absent — plotting zero would invent a reading the source
/// never had, which is the one way a chart can be wrong while looking right.
struct ChartSeriesShapeView: View {
    let spec: ChartSpec
    let dataset: ChartDataset
    let color: Color
    let size: CGSize
    let barSlot: ChartBarSlot
    let theme: any AppTheme

    /// The axis this series is measured against — the whole point of the
    /// custom renderer. Its domain, not the chart's, positions every point.
    private var axis: ChartAxisId { ChartMath.axis(of: dataset) }
    private var domain: ClosedRange<Double> { ChartMath.domain(for: axis, in: spec) }
    private var logarithmic: Bool {
        ChartMath.axisDefinition(axis, in: spec)?.scale == .logarithmic
    }
    /// Values after the Ion-owned transforms (cumulative, then same-axis
    /// stacking). Stacking never crosses axes: two series on different scales
    /// share no baseline, so a sum across them would be meaningless.
    private var values: [Double?] { ChartMath.plottedValues(for: dataset, in: spec) }
    private var renderAsBar: Bool {
        (dataset.kind ?? (spec.kind == .bar ? .bar : .line)) == .bar
    }

    var body: some View {
        if renderAsBar {
            bars
        } else {
            ZStack(alignment: .topLeading) {
                if dataset.fill == true || spec.kind == .area { area }
                line
            }
            if spec.showValues == true { valueLabels }
        }
    }

    // MARK: - Geometry

    private var slotWidth: CGFloat {
        size.width / CGFloat(max(spec.labels.count, 1))
    }

    private func x(_ index: Int) -> CGFloat {
        slotWidth * (CGFloat(index) + 0.5)
    }

    private func y(_ value: Double) -> CGFloat {
        let fraction = ChartMath.normalized(value, in: domain, logarithmic: logarithmic)
        return size.height - (size.height * fraction)
    }

    /// The vertical origin a bar grows from: the stacked baseline when this
    /// series sits on another, otherwise the domain's own floor.
    private func barBase(at index: Int) -> CGFloat {
        let resolved = dataset.resolvedData
        guard spec.stacked == true,
              index < values.count, index < resolved.count,
              let stacked = values[index], let raw = resolved[index]
        else { return y(max(domain.lowerBound, min(domain.upperBound, 0))) }
        return y(stacked - raw)
    }

    // MARK: - Marks

    private var line: some View {
        Path { path in
            var open = false
            for (index, value) in values.enumerated() {
                guard let value else {
                    // The break that makes a gap honest.
                    open = false
                    continue
                }
                let point = CGPoint(x: x(index), y: y(value))
                if open {
                    path.addLine(to: point)
                } else {
                    path.move(to: point)
                    open = true
                }
            }
        }
        .stroke(color, style: strokeStyle)
    }

    private var area: some View {
        Path { path in
            let base = y(max(domain.lowerBound, min(domain.upperBound, 0)))
            var run: [CGPoint] = []
            func flush() {
                guard run.count > 1 else { run = []; return }
                path.move(to: CGPoint(x: run[0].x, y: base))
                for point in run { path.addLine(to: point) }
                path.addLine(to: CGPoint(x: run[run.count - 1].x, y: base))
                path.closeSubpath()
                run = []
            }
            for (index, value) in values.enumerated() {
                guard let value else { flush(); continue }
                run.append(CGPoint(x: x(index), y: y(value)))
            }
            flush()
        }
        .fill(color.opacity(0.18))
    }

    private var bars: some View {
        ZStack(alignment: .topLeading) {
            ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                if let value {
                    let width = (slotWidth * 0.7) / CGFloat(max(barSlot.count, 1))
                    let groupLeft = x(index) - (slotWidth * 0.35)
                    let top = min(y(value), barBase(at: index))
                    let height = max(abs(barBase(at: index) - y(value)), 1)
                    Rectangle()
                        .fill(color)
                        .frame(width: max(width, 1), height: height)
                        .offset(
                            x: groupLeft + (width * CGFloat(barSlot.index)),
                            y: top,
                        )
                }
            }
        }
    }

    private var valueLabels: some View {
        ZStack(alignment: .topLeading) {
            ForEach(Array(values.enumerated()), id: \.offset) { index, value in
                if let value {
                    // Labelled in the series' OWN axis format, so a right-axis
                    // rate reads as a percentage beside a left-axis count.
                    Text(ChartMath.formatted(value, ChartMath.format(for: axis, in: spec)))
                        .ionType(.microLabel)
                        .foregroundStyle(theme.textSecondary)
                        .offset(x: x(index) - 14, y: y(value) - 14)
                }
            }
        }
    }

    private var strokeStyle: StrokeStyle {
        switch dataset.style {
        case .dashed: return StrokeStyle(lineWidth: 2, dash: [6, 4])
        case .dotted: return StrokeStyle(lineWidth: 2, dash: [2, 3])
        case .solid, .none: return StrokeStyle(lineWidth: 2)
        }
    }
}
