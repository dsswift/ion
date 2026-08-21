import SwiftUI

/// Flat, reverse-time history for conversations that left the active inbox.
struct InboxSettledHistorySheet: View {
    @Environment(\.dismiss) private var dismiss
    let tabs: [RemoteTabState]
    let onOpen: (RemoteTabState) -> Void

    var body: some View {
        NavigationStack {
            List(tabs) { tab in
                Button {
                    onOpen(tab)
                } label: {
                    InboxRowView(tab: tab)
                }
                .buttonStyle(.plain)
            }
            .navigationTitle("Settled History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
