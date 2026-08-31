import Foundation
import SwiftUI
import UIKit

/// Value math and display formatting for Ion charts.
///
/// Mirrors the pure helpers in `desktop/src/shared/chart-schema.ts`
/// (`cumulativeSeries`, `formatChartValue`, `datasetFormat`). These are kept
/// together and free of SwiftUI so the drawn chart, the value list, and the
/// copied text all read the same numbers from one implementation — a chart
/// whose axis label disagrees with its tooltip is a defect the user cannot
/// diagnose.
enum ChartMath {

    /// Apply the cumulative transform Ion owns.
    ///
    /// A `nil` stays `nil` — the gap is honest about a missing source reading
    /// — and the running total is carried across it, so the next real value
    /// continues the series instead of restarting it.
    static func cumulative(_ data: [Double?]) -> [Double?] {
        var total: Double = 0
        return data.map { point in
            guard let point else { return nil }
            total += point
            return total
        }
    }

    /// The format governing a dataset's values, resolved through its axis.
    static func format(for dataset: ChartDataset, in spec: ChartSpec) -> ChartValueFormat? {
        dataset.axis == .right ? spec.rightAxis?.format : spec.leftAxis?.format
    }

    /// Format one value for display, honoring the axis format.
    ///
    /// `NumberFormatter` is used rather than string interpolation so grouping
    /// separators and currency placement follow the device locale, which is
    /// what makes a shared chart readable to whoever receives it.
    static func formatted(_ value: Double, _ format: ChartValueFormat?) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal

        guard let format else {
            formatter.maximumFractionDigits = 2
            return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
        }

        switch format.kind {
        case .currency:
            let decimals = format.decimals ?? 2
            formatter.numberStyle = .currency
            formatter.currencyCode = format.currency
            formatter.minimumFractionDigits = decimals
            formatter.maximumFractionDigits = decimals
            return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
        case .decimal, .percent:
            let decimals = format.decimals ?? 0
            formatter.minimumFractionDigits = decimals
            formatter.maximumFractionDigits = decimals
            let rendered = formatter.string(from: NSNumber(value: value)) ?? "\(value)"
            return format.kind == .percent ? "\(rendered)%" : rendered
        }
    }

    /// Resolve a series color: the spec's explicit choice, else the palette.
    ///
    /// The palette is supplied by the caller from the active theme (see
    /// `ChartPalette`), never hardcoded here, so a chart matches the
    /// surrounding conversation in every theme — the same rule the desktop
    /// mapper follows.
    static func seriesColor(_ dataset: ChartDataset, index: Int, palette: [Color]) -> Color {
        if let hex = dataset.color, let color = Color(rgbaHex: hex) { return color }
        return palette[index % palette.count]
    }

    /// Slice colors for a radial chart, one per label.
    static func sliceColors(_ spec: ChartSpec, palette: [Color]) -> [Color] {
        if let explicit = spec.sliceColors, explicit.count == spec.labels.count {
            return explicit.enumerated().map { index, hex in
                Color(rgbaHex: hex) ?? palette[index % palette.count]
            }
        }
        return spec.labels.indices.map { palette[$0 % palette.count] }
    }

    /// A plain-text rendering of the chart's values.
    ///
    /// This is what "Copy" puts on the pasteboard. Charts are frequently
    /// pasted into a message or a ticket, where an image is useless and a
    /// table is not — so the copy carries the real numbers, tab-separated,
    /// with the same formatting the chart shows.
    static func plainText(_ spec: ChartSpec) -> String {
        var lines: [String] = [spec.title]
        if let subtitle = spec.subtitle, !subtitle.isEmpty { lines.append(subtitle) }

        let header = ([spec.categoryAxis?.title ?? ""] + spec.datasets.map(\.label))
            .joined(separator: "\t")
        lines.append(header)

        for (row, label) in spec.labels.enumerated() {
            var cells = [label]
            for dataset in spec.datasets {
                let resolved = dataset.resolvedData
                let raw = row < resolved.count ? resolved[row] : nil
                guard let raw else { cells.append("—"); continue }
                cells.append(formatted(raw, format(for: dataset, in: spec)))
            }
            lines.append(cells.joined(separator: "\t"))
        }

        if let caption = spec.caption, !caption.isEmpty { lines.append(caption) }
        if let source = spec.source, !source.isEmpty { lines.append("Source: \(source)") }
        return lines.joined(separator: "\n")
    }

    // MARK: - Axis geometry
    //
    // The desktop maps each series onto the Chart.js scale its `axis` names,
    // and gives each scale its own domain, ticks, and value format
    // (`chart-config.ts` → buildValueScale). These helpers are the same rule in
    // pure Swift, so the phone plots a dual-axis chart against the same two
    // scales instead of flattening both series onto one — which silently
    // rescaled the right-axis series and drew it as though it shared the left
    // axis's magnitude.

    /// The axis a dataset is measured against. Absent means left.
    static func axis(of dataset: ChartDataset) -> ChartAxisId {
        dataset.axis ?? .left
    }

    /// The datasets bound to one axis, in spec order.
    static func datasets(for axis: ChartAxisId, in spec: ChartSpec) -> [ChartDataset] {
        spec.datasets.filter { Self.axis(of: $0) == axis }
    }

    /// The value axis definition for an id, if the spec declares one.
    static func axisDefinition(_ axis: ChartAxisId, in spec: ChartSpec) -> ChartValueAxis? {
        axis == .right ? spec.rightAxis : spec.leftAxis
    }

    /// The value format for an axis, used by its ticks and its annotations.
    static func format(for axis: ChartAxisId, in spec: ChartSpec) -> ChartValueFormat? {
        axisDefinition(axis, in: spec)?.format
    }

    /// One dataset's plotted values, after the Ion-owned transforms.
    ///
    /// Stacking applies only WITHIN an axis and only to Cartesian charts: two
    /// series measured against different scales have no common baseline, so
    /// summing across them would invent a total that means nothing.
    static func plottedValues(
        for dataset: ChartDataset,
        in spec: ChartSpec
    ) -> [Double?] {
        guard spec.stacked == true, spec.kind.isCartesian else { return dataset.resolvedData }
        let axis = Self.axis(of: dataset)
        var baseline = [Double](repeating: 0, count: spec.labels.count)
        for candidate in spec.datasets {
            if Self.axis(of: candidate) != axis { continue }
            let resolved = candidate.resolvedData
            if candidate.label == dataset.label {
                // A gap stays a gap: a missing reading has no stacked position,
                // and drawing it at the running baseline would present the
                // series below it as this one's value.
                return resolved.enumerated().map { index, value in
                    guard let value else { return nil }
                    return baseline[index] + value
                }
            }
            for index in 0..<baseline.count where index < resolved.count {
                baseline[index] += resolved[index] ?? 0
            }
        }
        return dataset.resolvedData
    }

    /// True when an axis must include zero in its domain.
    ///
    /// Decided PER AXIS from the series bound to it, never from the chart kind:
    /// a bar's height and a filled area's extent are read against a zero
    /// baseline, so their axis has to contain it. A plain line states a level
    /// rather than a magnitude, so its axis ranges to the data.
    ///
    /// Judging this from the chart kind is the defect this replaces. A stacked
    /// bar chart with a rate line on the right axis is the ordinary dual-scale
    /// shape, and testing `spec.kind == .bar` anchored the RIGHT axis to zero
    /// too — an 11.2%–14.2% series was squeezed into the top fifth of a 0%–14%
    /// scale and read as almost level. The desktop's Chart.js scales resolve
    /// this per scale, so the two clients drew the same chart differently.
    static func axisAnchorsZero(_ axis: ChartAxisId, in spec: ChartSpec) -> Bool {
        let bound = datasets(for: axis, in: spec)
        // Stacking is a WITHIN-AXIS transform, so it only reaches an axis that
        // carries more than one series. A lone line on the right axis of a
        // stacked chart is stacked on nothing — reading the chart-wide flag
        // here would re-create the very defect this function replaces, one
        // level down.
        let stacks = spec.stacked == true && bound.count > 1
        return bound.contains { dataset in
            let effectiveKind = dataset.kind ?? (spec.kind == .bar ? .bar : .line)
            if effectiveKind == .bar { return true }
            if dataset.fill == true || spec.kind == .area { return true }
            return stacks
        }
    }

    /// The numeric domain one axis must cover.
    ///
    /// An explicit bound from the spec always wins — it is the model stating
    /// the scale it wants — and the data supplies whatever the spec omits.
    /// Annotations bound to the axis are included so a target line or an
    /// expected band outside the data range is still visible rather than
    /// silently clipped.
    ///
    /// A data-derived bound is rounded OUTWARD to a nice tick boundary. Ending
    /// exactly on the data pins the lowest reading to the bottom edge and the
    /// highest to the top, so every series fills the whole plot height whatever
    /// its actual spread — a 3-point rise and a 300-point rise draw identically,
    /// and the reader loses the one thing the vertical position was telling
    /// them. Chart.js rounds to nice bounds for the same reason, so this is also
    /// what keeps the phone and the desktop drawing one chart the same way.
    static func domain(for axis: ChartAxisId, in spec: ChartSpec) -> ClosedRange<Double> {
        let definition = axisDefinition(axis, in: spec)
        var values: [Double] = []
        for dataset in datasets(for: axis, in: spec) {
            values.append(contentsOf: plottedValues(for: dataset, in: spec).compactMap { $0 })
        }
        for line in spec.referenceLines ?? [] where (line.axis ?? .left) == axis {
            values.append(line.value)
        }
        for band in spec.rangeBands ?? [] where (band.axis ?? .left) == axis {
            values.append(band.from)
            values.append(band.to)
        }

        let logarithmic = definition?.scale == .logarithmic
        if axisAnchorsZero(axis, in: spec), !logarithmic {
            values.append(0)
        }

        let dataLow = values.min() ?? 0
        let dataHigh = values.max() ?? 1
        // A logarithmic axis is placed by decade, so linear tick rounding does
        // not apply to it.
        let rounded = logarithmic ? dataLow...max(dataHigh, dataLow) : niceBounds(low: dataLow, high: dataHigh)
        let low = definition?.min ?? rounded.lowerBound
        let high = definition?.max ?? rounded.upperBound
        // A flat series has no extent; widening it keeps the line on screen
        // instead of collapsing the plot to a zero-height strip.
        guard low < high else { return low...(low + max(abs(low), 1)) }
        return low...high
    }

    /// Round a data range outward to whole tick steps.
    ///
    /// The classic nice-number algorithm, which is what Chart.js's linear scale
    /// uses: pick a tick spacing that is 1, 2, or 5 times a power of ten, then
    /// floor the low bound and ceil the high bound onto it. Beyond the headroom
    /// it buys, it is also what makes the tick LABELS read as round numbers —
    /// an axis ending on the data produced ticks like 3.6% and 10.7%.
    static func niceBounds(low: Double, high: Double, tickCount: Int = 4) -> ClosedRange<Double> {
        guard high > low, tickCount > 0, low.isFinite, high.isFinite else {
            return low...max(high, low)
        }
        let spacing = niceNumber(niceNumber(high - low, rounded: false) / Double(tickCount), rounded: true)
        guard spacing > 0, spacing.isFinite else { return low...high }
        return ((low / spacing).rounded(.down) * spacing)...((high / spacing).rounded(.up) * spacing)
    }

    /// The nearest "nice" number to a range: 1, 2, 5, or 10 times a power of ten.
    private static func niceNumber(_ range: Double, rounded: Bool) -> Double {
        guard range > 0, range.isFinite else { return 1 }
        let exponent = log10(range).rounded(.down)
        let fraction = range / pow(10, exponent)
        let niceFraction: Double
        if rounded {
            if fraction < 1.5 { niceFraction = 1 } else if fraction < 3 { niceFraction = 2 } else if fraction < 7 { niceFraction = 5 } else { niceFraction = 10 }
        } else {
            if fraction <= 1 { niceFraction = 1 } else if fraction <= 2 { niceFraction = 2 } else if fraction <= 5 { niceFraction = 5 } else { niceFraction = 10 }
        }
        return niceFraction * pow(10, exponent)
    }

    /// Fractional position of a value within a domain, 0 at the bottom.
    ///
    /// Logarithmic placement uses log10 because the desktop's Chart.js
    /// logarithmic scale does. The spec parser already refuses a non-positive
    /// value on a logarithmic axis, so the guard here is for a domain floor of
    /// zero produced by an explicit `min`, not for data.
    static func normalized(
        _ value: Double,
        in domain: ClosedRange<Double>,
        logarithmic: Bool
    ) -> Double {
        if logarithmic {
            let low = max(domain.lowerBound, .leastNormalMagnitude)
            let high = max(domain.upperBound, low * 10)
            let span = log10(high) - log10(low)
            guard span > 0 else { return 0 }
            return (log10(max(value, low)) - log10(low)) / span
        }
        let span = domain.upperBound - domain.lowerBound
        guard span > 0 else { return 0 }
        return (value - domain.lowerBound) / span
    }

    /// Evenly spaced tick values across a domain, for axis labels.
    static func ticks(for domain: ClosedRange<Double>, count: Int = 4) -> [Double] {
        guard count > 1 else { return [domain.lowerBound, domain.upperBound] }
        let span = domain.upperBound - domain.lowerBound
        return (0...count).map { step in
            domain.lowerBound + span * (Double(step) / Double(count))
        }
    }

    // MARK: - Axis gutter

    /// The width one axis needs for its tick labels, measured from the labels
    /// it will actually print.
    ///
    /// A fixed gutter is what this replaces. 44 points fits `14.0%` and does
    /// NOT fit `$40,000`, so a currency axis wrapped its top label onto two
    /// lines — the tick read `$40,00` above a stray `0`, and the wrapped line
    /// collided with the axis title above it. The number was still correct and
    /// the chart still unreadable, which is the worst pair.
    ///
    /// The width is measured rather than estimated because label width is a
    /// product of the locale's grouping separators, the currency symbol, the
    /// device's content-size setting, and the font — none of which a constant
    /// in this file can know. `boundingRect` asks the same text system that
    /// will draw the label, so the answer is right in every locale and at every
    /// Dynamic Type size.
    ///
    /// Clamped at both ends: a floor so a one-character axis still reads as a
    /// gutter, and a ceiling so an extreme label cannot squeeze the plot itself
    /// down to nothing.
    static func axisGutterWidth(
        for axis: ChartAxisId,
        in spec: ChartSpec,
        font: UIFont,
        minimum: CGFloat = 30,
        maximum: CGFloat = 96
    ) -> CGFloat {
        let format = format(for: axis, in: spec)
        let widest = ticks(for: domain(for: axis, in: spec))
            .map { formatted($0, format) }
            .reduce(CGFloat(0)) { widest, label in
                let size = (label as NSString).size(withAttributes: [.font: font])
                return max(widest, size.width)
            }
        // The label is centred on its tick, so it needs a little air on the
        // side that faces the plot as well as the card edge.
        return min(max(widest + 8, minimum), maximum)
    }
}
