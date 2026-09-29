import Foundation

// MARK: - Health
//
// The host's load, the Ion processes on it, its developer tools, and the
// server's logs (`server/src/environment/actions.ts`).

extension ServerAdminClient {

    func systemMetricsLatest() async throws -> EnvironmentSystemMetricsLatest {
        try await call(.environmentSystemMetricsLatest)
    }

    func systemMetricsHistory(windowSeconds: Int) async throws -> SystemMetricsHistory {
        try await call(.environmentSystemMetricsHistory, fields: ["windowSec": .int(windowSeconds)])
    }

    func hostToolchains() async throws -> EnvironmentToolchains {
        try await call(.environmentHostToolchains, timeoutSeconds: 30)
    }

    func logTail(_ file: EnvironmentLogTail.File, lines: Int) async throws -> EnvironmentLogTail {
        try await call(.environmentServerLogTail, fields: ["file": .string(file.rawValue), "lines": .int(lines)])
    }
}
