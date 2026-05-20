import SwiftUI

/// Terminal panel presented as a full-screen cover from ConversationView.
///
/// Reuses SwiftTermWrapper and TerminalInstanceBar to provide the same
/// terminal experience as RemoteTerminalView, wrapped in a NavigationStack
/// with a Done button following the FileExplorerView / GitPaneView pattern.
struct ConversationTerminalView: View {
    let tabId: String
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss

    private var instances: [TerminalInstanceInfo] {
        viewModel.terminalInstances[tabId] ?? []
    }

    private var activeInstanceId: String {
        viewModel.activeTerminalInstance[tabId] ?? instances.first?.id ?? ""
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if instances.count > 1 {
                    TerminalInstanceBar(
                        tabId: tabId,
                        instances: instances,
                        activeInstanceId: activeInstanceId
                    )
                }

                if !activeInstanceId.isEmpty {
                    SwiftTermWrapper(tabId: tabId, instanceId: activeInstanceId)
                        .id("\(tabId):\(activeInstanceId)")
                } else {
                    ContentUnavailableView(
                        "No Terminal",
                        systemImage: "terminal",
                        description: Text("Waiting for terminal instance...")
                    )
                }
            }
            .navigationTitle("Terminal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        viewModel.addTerminalInstance(tabId: tabId)
                    } label: {
                        Image(systemName: "plus.rectangle")
                    }
                }
            }
            .onAppear {
                viewModel.requestTerminalSnapshot(tabId: tabId)
            }
        }
    }
}
