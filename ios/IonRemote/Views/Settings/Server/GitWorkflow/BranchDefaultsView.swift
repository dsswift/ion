import SwiftUI

/// The saved source branch per directory, with swipe to remove.
struct BranchDefaultsView: View {
    let session: ServerAdminSession
    let model: BranchDefaultsModel

    var body: some View {
        List {
            Section {
                if let entries = model.entries {
                    if entries.isEmpty {
                        Text("No saved branches. The branch picker shows every time.").foregroundStyle(.secondary)
                    }
                    ForEach(entries) { entry in
                        VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                            Text(BranchDefaultsModel.shortened(entry.directory)).font(.callout.monospaced())
                            Text(entry.branch).font(.caption).foregroundStyle(.secondary)
                        }
                        .swipeActions(edge: .trailing) {
                            Button("Remove", role: .destructive) {
                                Task { await model.remove(directory: entry.directory) }
                            }
                        }
                    }
                } else if let error = model.loadError {
                    AdminErrorRow(message: error)
                } else {
                    AdminLoadingRow(text: "Loading…")
                }
                if let error = model.operationError {
                    AdminErrorRow(message: error)
                }
            } footer: {
                Text("The source branch saved for each directory on \(session.serverLabel). Remove one to see the branch picker again.")
            }
        }
        .navigationTitle("Branch Defaults")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { session.open() }
        .onDisappear { session.close() }
        .task { await model.load() }
    }
}
