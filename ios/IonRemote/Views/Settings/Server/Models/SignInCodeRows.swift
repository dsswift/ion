import SwiftUI

/// A code the person enters on a provider's page, shown large, with Copy and
/// a button that opens the page.
struct SignInCodeRows: View {
    let code: String
    let verificationUrl: URL?
    let caption: String

    @Environment(\.openURL) private var openURL
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: IonSpace.compactGap) {
            Text(caption).font(.callout).foregroundStyle(.secondary)
            Text(code)
                .font(.system(.largeTitle, design: .monospaced).weight(.semibold)) // design-type: display-size code read off this screen and typed on another device; text-style based, so it still scales
                .textSelection(.enabled)
                .accessibilityLabel("Code \(code.map(String.init).joined(separator: " "))")
        }
        .padding(.vertical, IonSpace.hairlineGap)
        Button {
            UIPasteboard.general.string = code
            copied = true
        } label: {
            Label(copied ? "Copied" : "Copy Code", systemImage: copied ? "checkmark" : "doc.on.doc")
        }
        if let verificationUrl {
            Button {
                openURL(verificationUrl)
            } label: {
                Label("Open Verification Page", systemImage: "safari")
            }
        }
    }
}
