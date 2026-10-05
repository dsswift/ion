import SwiftUI

/// The conversation's other paths, left on disk by a rewind. Tapping one
/// makes it the active path; the new transcript arrives on its own.
struct ConversationBranchesSheet: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let tabId: String

    private var branches: [ConversationBranch] {
        (viewModel.conversationBranches[tabId]?.branches ?? []).sorted { $0.timestamp > $1.timestamp }
    }

    var body: some View {
        NavigationStack {
            List {
                if let error = viewModel.branchSwitchError[tabId] {
                    Text(error)
                        .font(IonType.meaning)
                        .foregroundStyle(theme.statusError)
                }
                ForEach(branches) { branch in
                    Button { choose(branch) } label: { row(branch) }
                        .disabled(branch.active || viewModel.branchSwitchPending[tabId] != nil)
                }
            }
            .navigationTitle("Branches")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
            .onChange(of: viewModel.branchSwitchPending[tabId]) { old, new in
                // A switch that finished without a refusal closes the sheet.
                if old != nil, new == nil, viewModel.branchSwitchError[tabId] == nil { dismiss() }
            }
        }
    }

    private func row(_ branch: ConversationBranch) -> some View {
        VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
            Text(branch.preview.isEmpty ? "(no text)" : branch.preview)
                .font(IonType.rowTitle)
                .foregroundStyle(theme.textPrimary)
                .lineLimit(2)
            Text(detail(branch))
                .font(IonType.metadata)
                .foregroundStyle(theme.textSecondary)
        }
        .accessibilityElement(children: .combine)
    }

    private func detail(_ branch: ConversationBranch) -> String {
        let when = Date(timeIntervalSince1970: branch.timestamp / 1000).formatted(.relative(presentation: .named))
        let state = branch.active ? "Current · "
            : viewModel.branchSwitchPending[tabId] == branch.leafId ? "Switching… · " : ""
        return "\(state)\(branch.messageCount) messages · \(when)"
    }

    private func choose(_ branch: ConversationBranch) {
        guard !branch.active else { return }
        viewModel.switchBranch(tabId: tabId, leafId: branch.leafId)
    }
}
