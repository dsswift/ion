import SwiftUI

/// Restart and Update for a server installed from a bundle. Each asks first;
/// each needs admin access; neither applies to a server a desktop runs.
struct ServerLifecycleRows: View {
    let session: ServerAdminSession
    let model: ServerOverviewModel

    private enum Pending: Identifiable {
        case restart, update
        var id: Self { self }
    }

    @State private var pending: Pending?

    var body: some View {
        Button("Restart server") { pending = .restart }
            .disabled(!enabled(.environmentServerRestart))
        Button("Update server") { pending = .update }
            .disabled(!enabled(.environmentServerUpdate))
            .confirmationDialog(title, isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }), titleVisibility: .visible, presenting: pending) { choice in
                Button(choice == .restart ? "Restart" : "Update") {
                    Task { choice == .restart ? await model.restart() : await model.update() }
                }
            } message: { _ in
                Text("Every connection to \(session.serverLabel) drops for a moment.")
            }
        if let reason = disabledReason {
            Text(reason)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        if let notice = model.lifecycleNotice {
            Label(notice, systemImage: "checkmark.circle")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        if let error = model.lifecycleError {
            Label(error, systemImage: "exclamationmark.triangle")
                .font(.callout)
                .foregroundStyle(.orange)
        }
    }

    private var title: String {
        pending == .update ? "Update \(session.serverLabel)?" : "Restart \(session.serverLabel)?"
    }

    private func enabled(_ action: PhoneAction) -> Bool {
        session.allows(action) && model.isBundleInstall && !model.lifecycleBusy
    }

    private var disabledReason: String? {
        if let reason = session.denialReason(.environmentServerRestart) { return reason }
        if model.info != nil, !model.isBundleInstall {
            return "Only a server installed from a bundle can be restarted or updated from here. Restart it the way it was started."
        }
        return nil
    }
}
