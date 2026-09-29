import Foundation

/// `environment.systemMetrics.history`: host load in 10-second buckets over
/// the window asked for. Mirrors `SystemMetricsHistoryBucket` in
/// `packages/shared/src/types-system-metrics.ts`; only host CPU is read.
struct SystemMetricsHistory: Decodable, Equatable, Sendable {

    struct Bucket: Decodable, Equatable, Sendable {
        /// Bucket start, Unix ms.
        let at: Double
        let hostCpuAvg: Double?
    }

    let buckets: [Bucket]
    let windowMs: Double

    /// Host CPU over the window, 0...1, oldest first; buckets with no reading are skipped.
    var cpuSeries: [Double] { buckets.compactMap(\.hostCpuAvg) }
}
