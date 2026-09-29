import SwiftUI
import UIKit

/// A public key with Copy and Share, and for GitHub a link to its SSH keys
/// page. Rows for the caller's `Section`.
struct GitPublicKeyRows: View {
    let host: String
    let publicKey: String

    @State private var copied = false

    static let githubNewKeyURL = URL(string: "https://github.com/settings/ssh/new")

    var body: some View {
        Text(publicKey)
            .font(.caption.monospaced())
            .textSelection(.enabled)
            .padding(.vertical, IonSpace.hairlineGap)
        Button {
            UIPasteboard.general.string = publicKey
            copied = true
            DiagnosticLog.log("git access: public key copied", tag: "admin.git", fields: ["git_host": host])
        } label: {
            Label(copied ? "Copied" : "Copy Public Key", systemImage: copied ? "checkmark" : "doc.on.doc")
        }
        ShareLink(item: publicKey, subject: Text("SSH public key for \(host)")) {
            Label("Share Public Key", systemImage: "square.and.arrow.up")
        }
        if host == "github.com", let url = Self.githubNewKeyURL {
            Link(destination: url) {
                Label("Open GitHub SSH Keys", systemImage: "arrow.up.right.square")
            }
        }
    }
}
