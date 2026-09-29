import SwiftUI

/// Every paired device, searchable by name.
struct PairedClientListView: View {
    let model: DevicesAdminModel
    let revokeDenial: String?

    @State private var query = ""

    private var matches: [PairedClient] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return model.clients }
        return model.clients.filter { $0.displayName.lowercased().contains(needle) }
    }

    var body: some View {
        List {
            ForEach(matches) { paired in
                NavigationLink {
                    PairedClientDetailView(model: model, paired: paired, revokeDenial: revokeDenial)
                } label: {
                    PairedClientRow(paired: paired, isOwn: model.isOwn(paired))
                }
            }
        }
        .overlay {
            if matches.isEmpty && !query.isEmpty {
                ContentUnavailableView.search(text: query)
            }
        }
        .searchable(text: $query, prompt: "Device name")
        .navigationTitle("Paired devices")
        .navigationBarTitleDisplayMode(.inline)
    }
}
