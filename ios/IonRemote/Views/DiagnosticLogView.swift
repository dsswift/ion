import SwiftUI

/// On-device diagnostic log viewer.
///
/// Shows timestamped connection lifecycle events in a scrollable list.
/// Supports multi-session history — logs survive app restarts and crashes.
/// Use the Share button to AirDrop/copy the full multi-session log for analysis.
struct DiagnosticLogView: View {
    @State private var entries: [DiagnosticLog.Entry] = []
    @State private var sessionCount: Int = 1

    private let timeFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()

    var body: some View {
        List {
            if entries.isEmpty {
                Text("No diagnostic entries yet.\nConnect or switch desktops to generate logs.")
                    .foregroundStyle(.secondary)
                    .font(.caption)
            } else {
                ForEach(Array(entries.enumerated().reversed()), id: \.offset) { _, entry in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(timeFmt.string(from: entry.timestamp))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .monospaced()
                        Text(entry.message)
                            .font(.caption)
                            .monospaced()
                    }
                    .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Diagnostic Log")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    ShareLink(item: DiagnosticLog.exportAllSessions()) {
                        Label("Share All Sessions", systemImage: "square.and.arrow.up")
                    }
                    ShareLink(item: DiagnosticLog.exportCurrentSession()) {
                        Label("Share Current Session", systemImage: "doc")
                    }
                    Button(role: .destructive) {
                        DiagnosticLog.clear()
                        entries = []
                    } label: {
                        Label("Clear Log", systemImage: "trash")
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text("\(sessionCount)s")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
        }
        .onAppear { refresh() }
        .refreshable { refresh() }
    }

    private func refresh() {
        entries = DiagnosticLog.entries()
        sessionCount = DiagnosticLog.sessionCount()
    }
}
