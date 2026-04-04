import SwiftUI

/// Main terminal tab view for remote terminal sessions.
///
/// Shows a SwiftTerm terminal for the active instance, with an instance
/// tab bar when multiple shell instances exist within the terminal tab.
struct RemoteTerminalView: View {
    let tabId: String
    @Environment(SessionViewModel.self) private var viewModel

    private var instances: [TerminalInstanceInfo] {
        viewModel.terminalInstances[tabId] ?? []
    }

    private var activeInstanceId: String {
        viewModel.activeTerminalInstance[tabId] ?? instances.first?.id ?? ""
    }

    var body: some View {
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
        .onAppear {
            viewModel.requestTerminalSnapshot(tabId: tabId)
        }
        .navigationTitle(viewModel.tab(for: tabId)?.displayTitle ?? "Terminal")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    viewModel.addTerminalInstance(tabId: tabId)
                } label: {
                    Image(systemName: "plus.rectangle")
                }
            }
        }
    }
}
