import SwiftUI

/// Everything about one pairing, and Revoke.
struct PairedClientDetailView: View {
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let model: DevicesAdminModel
    let paired: PairedClient
    /// Why this connection may not revoke, when it may not.
    let revokeDenial: String?

    @State private var confirming = false

    private var isOwn: Bool { model.isOwn(paired) }

    var body: some View {
        List {
            Section {
                LabeledContent("Kind", value: paired.kindName.capitalized)
                LabeledContent("Paired", value: paired.pairedDate.formatted(date: .abbreviated, time: .shortened))
                LabeledContent("Last seen", value: paired.isConnected ? "Connected now" : paired.lastSeenDate.formatted(.relative(presentation: .named)))
                LabeledContent("Id") {
                    Text(paired.clientId)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                }
                .contextMenu {
                    Button("Copy id", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = paired.clientId
                        DiagnosticLog.log("devices: id copied", tag: "admin.access", level: .debug)
                    }
                }
            }
            Section("Scopes") {
                ForEach(paired.scopes, id: \.self) { scope in
                    Text(scope)
                        .font(.body.monospaced())
                        .foregroundStyle(scope == StudioScope.admin.rawValue ? theme.accent : theme.textPrimary)
                }
            }
            Section {
                Button(role: .destructive) {
                    confirming = true
                } label: {
                    HStack {
                        Text("Revoke")
                        if model.revokingId == paired.clientId {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(isOwn || revokeDenial != nil || model.revokingId != nil)
            } footer: {
                if isOwn {
                    Text(DevicesAdminModel.ownPairingReason)
                } else if let revokeDenial {
                    Text(revokeDenial)
                } else if let error = model.revokeError {
                    Text(error).foregroundStyle(theme.statusError)
                } else {
                    Text("The device is disconnected now and must pair again to come back.")
                }
            }
        }
        .navigationTitle(paired.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Revoke \(paired.displayName)?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Revoke", role: .destructive) {
                Task {
                    if await model.revoke(paired) { dismiss() }
                }
            }
        } message: {
            Text("It is disconnected now and must pair again to come back.")
        }
    }
}
