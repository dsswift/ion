import SwiftUI

/// Uninstalling Ion from a server's host. Reads what is there, lets the
/// person pick how much to remove beyond the services and bundle (which
/// always go), asks once more, then shows what was removed. When the
/// uninstall was scheduled the server is removed from this phone on Done.
struct ServerPurgeView: View {
    let model: ServerPurgeModel
    /// Called on Done after a scheduled uninstall: the server is going away.
    let onUninstalled: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false

    var body: some View {
        @Bindable var model = model
        List {
            if let result = model.result {
                resultSection(result)
            } else if let appraisal = model.appraisal {
                levelsSection(appraisal, levels: $model.levels)
                Section {
                    Button("Uninstall from host", role: .destructive) { confirming = true }
                        .disabled(!model.canRun)
                    if model.running {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Removing…").foregroundStyle(.secondary)
                        }
                    }
                    if let error = model.error {
                        Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                    }
                } footer: {
                    if appraisal.bundle == nil {
                        Text("\(model.serverLabel) was not installed from a bundle, so there is nothing to uninstall from here.")
                    }
                }
            } else if let error = model.appraisalError {
                Section {
                    Label("Could not read the host: \(error)", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
            } else {
                Section {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Looking at what is on the host…").foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Uninstall Ion")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(model.running)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(model.result == nil ? "Cancel" : "Done") {
                    let uninstalled = model.result?.uninstallScheduled == true
                    dismiss()
                    if uninstalled { onUninstalled() }
                }
                .disabled(model.running)
            }
        }
        .task { if model.appraisal == nil { await model.appraise() } }
        .confirmationDialog("Uninstall Ion from \(model.serverLabel)?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Uninstall", role: .destructive) { Task { await model.run() } }
        } message: {
            Text("This cannot be undone. The server stops once the uninstall starts.")
        }
    }

    private func levelsSection(_ appraisal: EnvironmentPurgeAppraisal, levels: Binding<EnvironmentPurgeLevels>) -> some View {
        Section {
            levelRow("Studio Server services and bundle", detail: appraisal.bundle.map { "Version \($0.version) at \($0.root)" } ?? "Not installed from a bundle", isOn: .constant(true))
                .disabled(true)
            levelRow(
                "Git credentials",
                detail: appraisal.gitCredentialHosts.isEmpty ? "None stored" : "Keys and tokens for \(appraisal.gitCredentialHosts.joined(separator: ", "))",
                isOn: levels.gitCredentials
            )
            .disabled(appraisal.gitCredentialHosts.isEmpty)
            levelRow("Repositories Ion cloned", detail: Self.clonesDetail(appraisal), isOn: levels.clones)
                .disabled(appraisal.clonedProjects.isEmpty)
            if levels.wrappedValue.clones, !appraisal.dirtyClones.isEmpty {
                levelRow(
                    "Delete the ones with changes too",
                    detail: appraisal.dirtyClones.map { ($0.dir as NSString).lastPathComponent }.joined(separator: ", "),
                    isOn: levels.force
                )
            }
            levelRow(
                "All Ion data on the host",
                detail: "\(appraisal.conversations) conversations, settings, engine and server config, pairings: \(Self.bytes(appraisal.dataBytes))",
                isOn: levels.data
            )
        } header: {
            Text("Remove")
        } footer: {
            Text("Anything you leave stays for the next time you add this server.")
        }
    }

    private func levelRow(_ title: String, detail: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func resultSection(_ result: EnvironmentPurgeResult) -> some View {
        Section {
            if result.uninstallScheduled {
                Label("Uninstall started. The services stop in a moment.", systemImage: "checkmark.circle")
            } else {
                Label("The services were not removed: \(result.uninstallError ?? "no reason given")", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
            }
            if !result.removedClones.isEmpty {
                Text("Removed \(result.removedClones.count) cloned repositories.")
            }
            if !result.keptDirtyClones.isEmpty {
                Text("Kept, with uncommitted changes: \(result.keptDirtyClones.map { ($0 as NSString).lastPathComponent }.joined(separator: ", "))")
            }
            if !result.removedGitCredentialHosts.isEmpty {
                Text("Removed credentials for \(result.removedGitCredentialHosts.joined(separator: ", ")).")
            }
        } footer: {
            if result.uninstallScheduled {
                Text("Done removes \(model.serverLabel) from this iPhone.")
            }
        }
    }

    static func clonesDetail(_ appraisal: EnvironmentPurgeAppraisal) -> String {
        guard !appraisal.clonedProjects.isEmpty else { return "None" }
        var text = "\(appraisal.clonedProjects.count) cloned, \(bytes(appraisal.clonedBytes))"
        if !appraisal.dirtyClones.isEmpty { text += "; \(appraisal.dirtyClones.count) with uncommitted changes" }
        return text
    }

    static func bytes(_ count: Double) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .file)
    }
}
