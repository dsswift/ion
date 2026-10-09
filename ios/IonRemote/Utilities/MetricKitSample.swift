import Foundation

/// A day's `MXMetricPayload` as the numbers the `metrickit sample` line
/// carries, read from the payload's JSON representation.
///
/// The JSON is read rather than the typed payload because MetricKit's types
/// cannot be constructed in a test, and the JSON is what Apple documents as
/// the payload's stable form. Measurements are strings with a unit
/// (`"700 sec"`, `"80,000 kB"`, `"1000 ms"`); histograms are bucketed counts
/// whose percentile is taken at the bucket midpoint.
struct MetricKitSample: Equatable, Sendable {
    /// The window the payload covers, as the payload writes it.
    var periodStart: String?
    var periodEnd: String?
    var appBuild: String?
    /// Launch time to first draw, median over the day's launches.
    var launchP50Ms: Double?
    var launches: Double?
    /// Hangs: how many, their total, their median, and the share of
    /// foreground time spent hung (`hang_rate`, a ratio).
    var hangCount: Double?
    var hangTotalMs: Double?
    var hangP50Ms: Double?
    var hangRate: Double?
    var foregroundMs: Double?
    var cellularRxBytes: Double?
    var cellularTxBytes: Double?
    var wifiRxBytes: Double?
    var wifiTxBytes: Double?

    /// Reads a payload's JSON. Nil when the data is not a JSON object.
    static func parse(_ data: Data) -> MetricKitSample? {
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data)
        } catch {
            DiagnosticLog.log("metrickit payload is not json", tag: "metrics.metrickit", level: .warn, fields: [
                "error": error.localizedDescription, "bytes": String(data.count)
            ])
            return nil
        }
        guard let root = object as? [String: Any] else { return nil }
        var sample = MetricKitSample()
        sample.periodStart = root["timeStampBegin"] as? String
        sample.periodEnd = root["timeStampEnd"] as? String
        sample.appBuild = (root["metaData"] as? [String: Any])?["appBuildVersion"] as? String

        if let launch = root["applicationLaunchMetrics"] as? [String: Any],
           let histogram = (launch["histogrammedTimeToFirstDrawKey"] ?? launch["histogrammedTimeToFirstDraw"]) as? [String: Any],
           let buckets = Self.buckets(histogram) {
            sample.launchP50Ms = Self.percentile(buckets, 50)
            sample.launches = buckets.reduce(0) { $0 + $1.count }
        }
        if let responsiveness = root["applicationResponsivenessMetrics"] as? [String: Any],
           let histogram = (responsiveness["histogrammedAppHangTime"] ?? responsiveness["histogrammedApplicationHangTime"]) as? [String: Any],
           let buckets = Self.buckets(histogram) {
            sample.hangCount = buckets.reduce(0) { $0 + $1.count }
            sample.hangTotalMs = buckets.reduce(0) { $0 + $1.count * $1.midpoint }
            sample.hangP50Ms = Self.percentile(buckets, 50)
        }
        if let time = root["applicationTimeMetrics"] as? [String: Any],
           let foreground = Self.milliseconds(time["cumulativeForegroundTime"]) {
            sample.foregroundMs = foreground
            if let hang = sample.hangTotalMs, foreground > 0 { sample.hangRate = hang / foreground }
        }
        if let network = root["networkTransferMetrics"] as? [String: Any] {
            sample.cellularRxBytes = Self.bytes(network["cumulativeCellularDownload"])
            sample.cellularTxBytes = Self.bytes(network["cumulativeCellularUpload"])
            sample.wifiRxBytes = Self.bytes(network["cumulativeWifiDownload"])
            sample.wifiTxBytes = Self.bytes(network["cumulativeWifiUpload"])
        }
        return sample
    }

    /// The line's string fields.
    var fields: [String: String] {
        var fields: [String: String] = [:]
        if let periodStart { fields["period_start"] = periodStart }
        if let periodEnd { fields["period_end"] = periodEnd }
        if let appBuild { fields["app_build"] = appBuild }
        return fields
    }

    /// The line's numeric fields; a metric the payload lacked is absent.
    var numbers: [String: Double] {
        let pairs: [(String, Double?)] = [
            ("launch_p50_ms", launchP50Ms), ("launches", launches),
            ("hang_count", hangCount), ("hang_total_ms", hangTotalMs), ("hang_p50_ms", hangP50Ms), ("hang_rate", hangRate),
            ("foreground_ms", foregroundMs),
            ("cellular_rx_bytes", cellularRxBytes), ("cellular_tx_bytes", cellularTxBytes),
            ("wifi_rx_bytes", wifiRxBytes), ("wifi_tx_bytes", wifiTxBytes)
        ]
        var numbers: [String: Double] = [:]
        for (key, value) in pairs { if let value { numbers[key] = value } }
        return numbers
    }

    // MARK: - Histograms

    struct Bucket: Equatable {
        let startMs: Double
        let endMs: Double
        let count: Double
        var midpoint: Double { (startMs + endMs) / 2 }
    }

    /// The buckets of a `histogramValue`, in order of their start.
    static func buckets(_ histogram: [String: Any]) -> [Bucket]? {
        guard let values = histogram["histogramValue"] as? [String: Any] else { return nil }
        var buckets: [Bucket] = []
        for case let bucket as [String: Any] in values.values {
            guard let count = Self.number(bucket["bucketCount"]),
                  let start = milliseconds(bucket["bucketStart"]),
                  let end = milliseconds(bucket["bucketEnd"]) else { continue }
            buckets.append(Bucket(startMs: start, endMs: end, count: count))
        }
        return buckets.sorted { $0.startMs < $1.startMs }
    }

    /// Nearest-rank percentile over bucketed counts, at the bucket midpoint.
    /// Nil when every bucket is empty.
    static func percentile(_ buckets: [Bucket], _ p: Int) -> Double? {
        let total = buckets.reduce(0) { $0 + $1.count }
        guard total > 0 else { return nil }
        let rank = (Double(p) / 100 * total).rounded(.up)
        var seen = 0.0
        for bucket in buckets {
            seen += bucket.count
            if seen >= rank { return bucket.midpoint }
        }
        return buckets.last?.midpoint
    }

    // MARK: - Measurements

    /// A duration measurement string as milliseconds.
    static func milliseconds(_ value: Any?) -> Double? {
        guard let (number, unit) = measurement(value) else { return nil }
        switch unit {
        case "ms", "millisecond", "milliseconds": return number
        case "s", "sec", "secs", "second", "seconds": return number * 1000
        case "min", "mins", "minute", "minutes": return number * 60_000
        case "hr", "hrs", "h", "hour", "hours": return number * 3_600_000
        case "us", "µs", "microseconds": return number / 1000
        default: return nil
        }
    }

    /// A data-size measurement string as bytes.
    static func bytes(_ value: Any?) -> Double? {
        guard let (number, unit) = measurement(value) else { return nil }
        switch unit {
        case "b", "byte", "bytes": return number
        case "kb": return number * 1000
        case "mb": return number * 1_000_000
        case "gb": return number * 1_000_000_000
        case "kib": return number * 1024
        case "mib": return number * 1_048_576
        case "gib": return number * 1_073_741_824
        default: return nil
        }
    }

    /// `"80,000 kB"` → (80000, "kb"). A bare number is a number with no unit.
    private static func measurement(_ value: Any?) -> (Double, String)? {
        if let number = Self.number(value) { return (number, "") }
        guard let text = value as? String else { return nil }
        let parts = text.split(separator: " ", maxSplits: 1).map(String.init)
        guard let first = parts.first, let number = Double(first.replacingOccurrences(of: ",", with: "")) else { return nil }
        return (number, (parts.count > 1 ? parts[1] : "").lowercased())
    }

    private static func number(_ value: Any?) -> Double? {
        if let number = value as? NSNumber { return number.doubleValue }
        if let text = value as? String { return Double(text.replacingOccurrences(of: ",", with: "")) }
        return nil
    }
}
