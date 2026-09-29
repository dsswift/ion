import SwiftUI

/// Mints a pairing link another device pastes to pair with a server.
struct PairingLinkSheet: View {
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let serverLabel: String
    @State var model: PairingLinkModel
    @State private var copied = false

    var body: some View {
        NavigationStack {
            List {
                if let link = model.link {
                    Section {
                        Text(link.url)
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                    } footer: {
                        Text("Lets another device pair with \(serverLabel). Paste it into Add server → Pairing link there. Treat it as a password; it expires \(link.expiresDate.formatted(.relative(presentation: .named))).")
                    }
                    Section {
                        Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") {
                            UIPasteboard.general.string = link.url
                            copied = true
                            DiagnosticLog.log("pairing link: copied", tag: "admin.access")
                        }
                        ShareLink(item: link.url) {
                            Label("Share", systemImage: "square.and.arrow.up")
                        }
                        Button("Mint another", systemImage: "arrow.clockwise") {
                            copied = false
                            Task { await model.mint() }
                        }
                        .disabled(model.minting)
                    }
                } else if let error = model.error {
                    Section {
                        Text(error).foregroundStyle(theme.statusError)
                        Button("Try again") { Task { await model.mint() } }
                    }
                } else {
                    Section {
                        HStack(spacing: IonSpace.compactGap) {
                            ProgressView()
                            Text("Minting…").foregroundStyle(theme.textSecondary)
                        }
                    }
                }
            }
            .navigationTitle("Pairing link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task { if model.link == nil { await model.mint() } }
    }
}
