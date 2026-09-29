import SwiftUI

/// The code to enter at the provider's sign-in page, large, with Copy, a
/// button that opens the page, and the time left.
struct EntraDeviceCodeView: View {
    let signIn: EntraDeviceSignIn
    let expiresAt: Date
    let onCancel: () -> Void

    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: IonSpace.contentGap) {
            Text("Enter this code on the sign-in page:")
                .font(.callout)
                .foregroundStyle(.secondary)
            Text(signIn.userCode)
                .font(.system(.largeTitle, design: .monospaced).weight(.semibold))
                .textSelection(.enabled)
                .accessibilityLabel("Sign-in code \(signIn.userCode.map(String.init).joined(separator: " "))")
            HStack(spacing: IonSpace.compactGap) {
                Button {
                    UIPasteboard.general.string = signIn.userCode
                    Haptic.light()
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
                .buttonStyle(.bordered)
                Button {
                    if let url = URL(string: signIn.verificationUri) { openURL(url) }
                } label: {
                    Label("Open Sign-in Page", systemImage: "safari")
                }
                .buttonStyle(.borderedProminent)
            }
            // Updates once a second; a timer text, not a repainting animation.
            Text(timerInterval: Date()...max(expiresAt, Date()), countsDown: true)
                .font(.footnote.monospacedDigit())
                .foregroundStyle(.secondary)
            Button("Cancel", role: .cancel, action: onCancel)
                .font(.callout)
        }
        .padding(.vertical, IonSpace.hairlineGap)
    }
}
