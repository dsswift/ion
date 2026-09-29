import SwiftUI

/// Adds or edits one engine profile: its name, its extensions (paths on the
/// server), and the mode its conversations open in.
struct EngineProfileEditSheet: View {
    let session: ServerAdminSession
    let model: EngineProfilesModel
    /// Nil adds a new profile.
    let existing: EngineProfile?

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var extensions: [String]
    @State private var defaultMode: String
    @State private var newPath = ""
    @State private var saving = false

    init(session: ServerAdminSession, model: EngineProfilesModel, existing: EngineProfile?) {
        self.session = session
        self.model = model
        self.existing = existing
        _name = State(initialValue: existing?.name ?? "")
        _extensions = State(initialValue: existing?.extensions ?? [])
        _defaultMode = State(initialValue: existing?.defaultMode == "plan" ? "plan" : "auto")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("e.g. cos", text: $name)
                        .autocorrectionDisabled()
                }
                Section {
                    ForEach(extensions, id: \.self) { path in
                        Text(path).font(.callout.monospaced()).lineLimit(2).truncationMode(.middle)
                    }
                    .onDelete { extensions.remove(atOffsets: $0) }
                    HStack {
                        TextField("Path on \(session.serverLabel)", text: $newPath)
                            .font(.callout.monospaced())
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .onSubmit(addPath)
                        Button("Add", action: addPath)
                            .disabled(trimmedPath.isEmpty)
                    }
                } header: {
                    Text("Extensions")
                } footer: {
                    Text("At least one. Enter the full path of each extension on \(session.serverLabel). Swipe to remove one.")
                }
                Section("Default Mode") {
                    Picker("Default mode", selection: $defaultMode) {
                        Text("Auto").tag("auto")
                        Text("Plan").tag("plan")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
                if let error = model.error {
                    Section { AdminErrorRow(message: error) }
                }
            }
            .navigationTitle(existing?.name ?? "New Profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save).disabled(!canSave)
                }
            }
        }
    }

    private var trimmedPath: String { newPath.trimmingCharacters(in: .whitespaces) }

    private var canSave: Bool {
        !saving && !name.trimmingCharacters(in: .whitespaces).isEmpty && !extensions.isEmpty
    }

    private func addPath() {
        guard !trimmedPath.isEmpty, !extensions.contains(trimmedPath) else { return }
        extensions.append(trimmedPath)
        newPath = ""
    }

    private func save() {
        saving = true
        let profile = EngineProfile(
            id: existing?.id ?? EngineProfilesModel.newId(),
            name: name.trimmingCharacters(in: .whitespaces),
            extensions: extensions,
            defaultMode: defaultMode
        )
        Task {
            let saved = await model.save(profile)
            saving = false
            if saved { dismiss() }
        }
    }
}
