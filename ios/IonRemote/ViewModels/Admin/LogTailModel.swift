import Foundation
import Observation

/// The last lines of one of a server's logs.
@MainActor
@Observable
final class LogTailModel {

    static let lineCount = 200

    let file: EnvironmentLogTail.File
    private(set) var tail: EnvironmentLogTail?
    private(set) var loading = false
    private(set) var error: String?

    @ObservationIgnored private let client: ServerAdminClient

    init(client: ServerAdminClient, file: EnvironmentLogTail.File) {
        self.client = client
        self.file = file
    }

    var serverLabel: String { client.serverLabel }
    /// The tail as one text, for sharing.
    var text: String { tail?.lines.joined(separator: "\n") ?? "" }

    func load() async {
        loading = true
        defer { loading = false }
        do {
            let read = try await client.logTail(file, lines: Self.lineCount)
            tail = read
            error = nil
            DiagnosticLog.log("log tail read", tag: "settings.health", fields: [
                "server": client.serverLabel, "file": file.rawValue, "lines": String(read.lines.count)
            ])
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("log tail failed", tag: "settings.health", level: .warn, fields: [
                "server": client.serverLabel, "file": file.rawValue, "error": String(describing: error)
            ])
        }
    }
}
