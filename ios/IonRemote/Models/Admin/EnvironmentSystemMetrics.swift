import Foundation

/// One full System Metrics sample of a server's host and its Ion processes.
/// Mirrors `EnvironmentSystemMetrics` in `packages/shared/src/types-system-metrics.ts`;
/// the runtime block is not read here.
struct EnvironmentSystemMetrics: Decodable, Equatable, Sendable {

    struct Host: Decodable, Equatable, Sendable {
        /// Share of all CPUs in use, 0...1. Nil on the first sample.
        let cpuUtilization: Double?
        let cpuCount: Double
        let effectiveCpuCount: Double
        let memoryTotalBytes: Double
        let memoryAvailableBytes: Double
        /// The container's memory limit, or 0 when none applies.
        let memoryLimitBytes: Double
        let containerLimited: Bool
        let load1: Double?
        let diskPath: String
        let diskTotalBytes: Double
        let diskFreeBytes: Double

        /// What memory is measured against: the container limit when one applies.
        var memoryCeilingBytes: Double { memoryLimitBytes > 0 ? memoryLimitBytes : memoryTotalBytes }
        var memoryUsedBytes: Double { max(0, memoryCeilingBytes - memoryAvailableBytes) }
        var memoryUsedFraction: Double? { memoryCeilingBytes > 0 ? memoryUsedBytes / memoryCeilingBytes : nil }
        var diskUsedFraction: Double? { diskTotalBytes > 0 ? (diskTotalBytes - diskFreeBytes) / diskTotalBytes : nil }
        var cpus: Double { effectiveCpuCount > 0 ? effectiveCpuCount : cpuCount }
    }

    struct Process: Decodable, Equatable, Sendable, Identifiable {
        let pid: Int
        let startTimeMs: Double
        /// engine, server, extension, mcp, backend, or tool.
        let role: String
        let name: String
        /// 100 = one full core. Nil on a process's first sample.
        let cpuPercent: Double?
        let rssBytes: Double
        var id: String { "\(pid):\(Int(startTimeMs))" }
    }

    let sampledAt: Double
    let host: Host
    let processes: [Process]

    private static let roleOrder = ["engine", "server", "extension", "mcp", "backend", "tool"]

    /// Engine and server first, then children by role; heaviest first within a
    /// role. The order the server's desktop client lists them in.
    var sortedProcesses: [Process] {
        func rank(_ role: String) -> Int { Self.roleOrder.firstIndex(of: role) ?? Self.roleOrder.count }
        return processes.sorted { a, b in
            rank(a.role) != rank(b.role) ? rank(a.role) < rank(b.role) : a.rssBytes > b.rssBytes
        }
    }
}
