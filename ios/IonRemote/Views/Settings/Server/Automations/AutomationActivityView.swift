import SwiftUI

/// The last ten automation runs, newest first. A run opens its stored
/// evaluation path.
struct AutomationActivityView: View {
    let session: ServerAdminSession
    let model: AutomationsAdminModel

    var body: some View {
        List {
            Section {
                if let runs = model.recentRuns {
                    if runs.isEmpty {
                        Text("No automation activity yet.").foregroundStyle(.secondary)
                    }
                    ForEach(runs) { run in
                        NavigationLink {
                            AutomationRunDetailView(run: run, name: model.name(for: run.automationId))
                        } label: {
                            AutomationRunRow(run: run, name: model.name(for: run.automationId))
                        }
                    }
                } else if let error = model.loadError {
                    AdminErrorRow(message: error)
                } else {
                    AdminLoadingRow(text: "Loading activity…")
                }
            } footer: {
                Text("Select a run to see the stored evaluation path.")
            }
        }
        .navigationTitle("Recent Activity")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { session.open() }
        .onDisappear { session.close() }
        .refreshable { await model.load() }
    }
}
