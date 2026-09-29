import SwiftUI

/// Sections that walk a server's folders and pick one: a path field, Home
/// and Up, hidden folders on request, and each folder marked when it is a
/// git checkout. Placed inside the caller's `List`.
struct ServerFolderBrowser: View {
    let pickLabel: String
    let disabled: Bool
    let onPick: (_ path: String, _ isGitRepo: Bool) -> Void

    @State private var model: ServerFolderModel

    init(session: ServerAdminSession, initialPath: String, pickLabel: String, disabled: Bool = false, onPick: @escaping (_ path: String, _ isGitRepo: Bool) -> Void) {
        self.pickLabel = pickLabel
        self.disabled = disabled
        self.onPick = onPick
        _model = State(initialValue: ServerFolderModel(serverId: session.serverId, client: session.client, initialPath: initialPath))
    }

    var body: some View {
        Section {
            TextField("Folder path", text: $model.typedPath)
                .font(.body.monospaced())
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .onSubmit { Task { await model.browseTyped() } }
                .task { await model.browseTyped() }
            HStack(spacing: IonSpace.compactGap) {
                Button { Task { await model.goHome() } } label: { Label("Home", systemImage: "house") }
                Spacer()
                Button { Task { await model.goUp() } } label: { Label("Up", systemImage: "arrow.turn.left.up") }
                    .disabled(model.listing?.parentPath == nil)
            }
            .buttonStyle(.borderless)
            Toggle("Show hidden folders", isOn: $model.showHidden)
                .onChange(of: model.showHidden) { Task { await model.browseTyped() } }
        }
        Section {
            folderRows
        } header: {
            Text("Folders")
        } footer: {
            Text("Tap a folder to open it. Touch and hold a git checkout to pick it directly.")
        }
        Section {
            Button {
                if let listing = model.listing { onPick(listing.path, listing.pathIsGitRepo) }
            } label: {
                Text(pickTitle).frame(maxWidth: .infinity)
            }
            .disabled(model.listing == nil || disabled)
        }
    }

    private var pickTitle: String {
        guard let listing = model.listing else { return pickLabel }
        return "\(pickLabel): \(ProjectListRow.baseName(listing.path))"
    }

    @ViewBuilder private var folderRows: some View {
        if let error = model.error {
            Label(error, systemImage: "exclamationmark.triangle")
                .foregroundStyle(.red)
                .font(.callout)
        }
        if let listing = model.listing {
            if listing.entries.isEmpty {
                Text("No folders here").foregroundStyle(.secondary)
            }
            ForEach(listing.entries) { entry in
                Button { Task { await model.descend(into: entry) } } label: {
                    FolderEntryRow(entry: entry)
                }
                .foregroundStyle(.primary)
                .contextMenu {
                    Button { onPick(entry.fullPath, entry.isGitRepo) } label: { Label(pickLabel, systemImage: "checkmark.circle") }
                        .disabled(disabled)
                }
            }
        } else if model.error == nil {
            AdminLoadingRow(text: "Listing folders…")
        }
    }
}
