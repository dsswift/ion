import SwiftUI

/// A server's engine profiles: each with its extension count and default
/// mode. A row opens its editor, a swipe deletes it, Add Profile adds one.
struct EngineProfilesAdminSection: View {
    let session: ServerAdminSession

    @State private var model: EngineProfilesModel
    @State private var editing: Editing?
    @State private var deleting: EngineProfile?

    private enum Editing: Identifiable, Equatable {
        case new
        case existing(EngineProfile)
        var id: String {
            switch self {
            case .new: return "new"
            case .existing(let profile): return profile.id
            }
        }
    }

    init(session: ServerAdminSession) {
        self.session = session
        _model = State(initialValue: EngineProfilesModel(client: session.client, serverId: session.serverId))
    }

    private var canEdit: Bool { session.allows(scope: .admin) }

    var body: some View {
        Group {
            if let profiles = model.profiles {
                if profiles.isEmpty {
                    Text("No engine profiles. A profile loads a set of extensions into a new conversation.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                ForEach(profiles) { profile in
                    Button {
                        editing = .existing(profile)
                    } label: {
                        row(profile)
                    }
                    .buttonStyle(.plain)
                    .disabled(!canEdit)
                    .swipeActions {
                        if canEdit {
                            Button("Delete", role: .destructive) { deleting = profile }
                        }
                    }
                }
                Button {
                    editing = .new
                } label: {
                    Label("Add Profile", systemImage: "plus")
                }
                .disabled(!canEdit)
                // One row carries this, so it attaches once rather than once per row of the section.
                .sheet(item: $editing) { which in
                    switch which {
                    case .new: EngineProfileEditSheet(session: session, model: model, existing: nil)
                    case .existing(let profile): EngineProfileEditSheet(session: session, model: model, existing: profile)
                    }
                }
                .confirmationDialog(
                    "Delete \(deleting?.name ?? "this profile")?",
                    isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                    titleVisibility: .visible
                ) {
                    Button("Delete Profile", role: .destructive) {
                        guard let profile = deleting else { return }
                        Task { await model.remove(id: profile.id) }
                    }
                } message: {
                    Text("Removes the profile from \(session.serverLabel). Its extension files stay where they are.")
                }
                if let reason = session.denialReason(scope: .admin) {
                    Text(reason).font(.footnote).foregroundStyle(.secondary)
                }
                if let error = model.error, editing == nil { AdminErrorRow(message: error) }
            } else if let error = model.error {
                AdminErrorRow(message: error)
            } else {
                AdminLoadingRow(text: "Loading engine profiles…")
            }
        }
        .task { await model.load() }
        .reloadsWithServerPage("engine-profiles") { [model] in await model.load() }
    }

    private func row(_ profile: EngineProfile) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(profile.name).foregroundStyle(.primary)
                Text(profile.extensions.count == 1 ? "1 extension" : "\(profile.extensions.count) extensions")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Text(profile.defaultMode == "plan" ? "Plan" : "Auto")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            Image(systemName: "chevron.right")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
