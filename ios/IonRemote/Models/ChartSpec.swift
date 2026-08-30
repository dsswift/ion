import Foundation

/// The Ion chart contract, as iOS reads it.
///
/// A chart arrives as a `chart`-kind resource whose `content` is the JSON
/// encoding of `ChartResourceContent` (produced by the desktop's
/// `chartResourceItem`). This file mirrors `desktop/src/shared/chart-schema.ts`
/// field for field.
///
/// ── Why iOS decodes the spec rather than an image ───────────────────────────
/// The desktop could rasterize and ship a PNG, but then a chart would be a
/// picture: unreadable at phone scale, unable to adopt the device's theme, and
/// frozen at whatever size the desktop chose. Decoding the same structured
/// spec the desktop renders means iOS draws a real chart with real axes.
///
/// ── Decoding is permissive where the desktop is strict ──────────────────────
/// The desktop tool REJECTS an invalid spec, so anything that reaches a client
/// has already passed validation. iOS therefore decodes rather than
/// re-validates, and treats an undecodable payload as "cannot render this"
/// instead of trying to repair it. The one thing iOS must not do is render a
/// partially-decoded chart, which would silently show wrong numbers.

/// Schema version iOS understands. A newer chart is shown as unsupported
/// rather than rendered from fields this build does not know about.
let ionChartSchemaVersion = 1

/// The resource kind charts are published under.
///
/// Must match `CHART_RESOURCE_KIND` in
/// `desktop/src/main/chart-resource-store.ts`. One constant, so a rename is a
/// single edit per client rather than a scatter of string literals that drift.
enum ChartResourceKind {
    static let name = "chart"
}

enum ChartKind: String, Codable {
    case line, area, bar, pie, doughnut

    /// True when the kind draws on an X/Y grid (and so supports axes).
    var isCartesian: Bool { self == .line || self == .area || self == .bar }
    /// True when the kind is a single-series proportion chart.
    var isRadial: Bool { self == .pie || self == .doughnut }
}

enum ChartSeriesKind: String, Codable { case line, bar }
enum ChartAxisScale: String, Codable { case linear, logarithmic }
enum ChartLineStyle: String, Codable { case solid, dashed, dotted }
enum ChartAxisId: String, Codable { case left, right }
enum ChartLegendPosition: String, Codable { case top, bottom, left, right }
enum ChartValueFormatKind: String, Codable { case decimal, currency, percent }

/// How a numeric axis (and anything bound to it) renders its values.
struct ChartValueFormat: Codable, Equatable {
    let kind: ChartValueFormatKind
    /// Decimal places, 0-6. Defaults to 0 for decimal/percent, 2 for currency.
    let decimals: Int?
    /// ISO 4217 code, present only when `kind` is `.currency`.
    let currency: String?
}

/// A numeric Y axis. `right` only exists when a dataset binds to it.
struct ChartValueAxis: Codable, Equatable {
    let title: String?
    let scale: ChartAxisScale?
    let min: Double?
    let max: Double?
    let format: ChartValueFormat?
}

/// The category (X) axis. Ion charts are category-based, never free numeric.
struct ChartCategoryAxis: Codable, Equatable {
    let title: String?
}

/// One data series. `nil` is an explicit gap, never zero.
struct ChartDataset: Codable, Equatable {
    let label: String
    let data: [Double?]
    /// `#RRGGBB`. Absent means the theme assigns one by series index.
    let color: String?
    /// Overrides the chart kind for this series (mixed bar + line charts).
    let kind: ChartSeriesKind?
    /// Which numeric axis this series is measured against. Defaults to `left`.
    let axis: ChartAxisId?
    let fill: Bool?
    let style: ChartLineStyle?
    /// Render the running total of `data` instead of the raw values.
    let cumulative: Bool?

    /// The values this dataset actually renders, after any Ion-owned
    /// transform. Kept as a computed property so the drawn line, the value
    /// table, and the axis domain cannot disagree about what is plotted.
    var resolvedData: [Double?] {
        (cumulative ?? false) ? ChartMath.cumulative(data) : data
    }
}

/// A labelled horizontal line: a target, threshold, or average.
struct ChartReferenceLine: Codable, Equatable {
    let value: Double
    let label: String?
    let color: String?
    let axis: ChartAxisId?
    let style: ChartLineStyle?
}

/// A labelled shaded band between two values on one axis.
struct ChartRangeBand: Codable, Equatable {
    let from: Double
    let to: Double
    let label: String?
    let color: String?
    let axis: ChartAxisId?
}

struct ChartLegend: Codable, Equatable {
    let visible: Bool?
    let position: ChartLegendPosition?
}

/// A fully validated chart. Every renderer reads exactly this.
struct ChartSpec: Codable, Equatable {
    let schemaVersion: Int
    let kind: ChartKind
    let title: String
    let subtitle: String?
    let caption: String?
    let source: String?
    let labels: [String]
    let datasets: [ChartDataset]
    let categoryAxis: ChartCategoryAxis?
    let leftAxis: ChartValueAxis?
    let rightAxis: ChartValueAxis?
    /// Explicit slice colors for pie/doughnut, one per label.
    let sliceColors: [String]?
    let legend: ChartLegend?
    let stacked: Bool?
    /// Print each value on the chart itself, not only on tap.
    let showValues: Bool?
    let referenceLines: [ChartReferenceLine]?
    let rangeBands: [ChartRangeBand]?

    /// True when this build can draw the spec. A chart written by a newer Ion
    /// is refused rather than drawn from the subset of fields iOS recognises:
    /// a chart missing a series it was told to show is worse than an honest
    /// "cannot display".
    var isSupportedVersion: Bool { schemaVersion == ionChartSchemaVersion }

    /// True when any dataset binds to the right axis, which is what decides
    /// whether a second axis is drawn at all.
    var usesRightAxis: Bool { datasets.contains { $0.axis == .right } }
}

/// The decoded `content` of a `chart` resource.
struct ChartResourceContent: Codable, Equatable {
    let chartId: String
    let title: String
    let spec: ChartSpec
    let revision: Int
    /// Transcript anchor — the tool row this revision was rendered by.
    let toolMessageId: String
    let createdAt: String
    let updatedAt: String

    /// Decode a chart from a resource's `content` string.
    ///
    /// Returns `nil` for anything that is not a well-formed chart payload, so
    /// a caller renders its own fallback rather than a broken card. The
    /// failure is logged rather than swallowed: the desktop validates every
    /// spec before it is stored, so a chart resource that will not decode here
    /// means the two clients disagree about the format — exactly the condition
    /// an operator needs to see in the log to diagnose it.
    static func decode(from content: String) -> ChartResourceContent? {
        guard let data = content.data(using: .utf8) else {
            DiagnosticLog.log("chart content is not valid UTF-8", tag: "model.chart", level: .warn, fields: [
                "content_length": String(content.count),
            ])
            return nil
        }
        do {
            return try JSONDecoder().decode(ChartResourceContent.self, from: data)
        } catch {
            DiagnosticLog.log("chart content failed to decode", tag: "model.chart", level: .warn, fields: [
                "content_length": String(content.count),
                "error": String(describing: error),
            ])
            return nil
        }
    }
}
