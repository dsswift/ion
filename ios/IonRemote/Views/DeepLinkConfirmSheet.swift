import SwiftUI

/// Asks whether to run an `ion://` action link. Shows exactly what would run:
/// the full prompt, the full command, and where. A confirmation that only
/// describes the request trains people to approve without reading.
struct DeepLinkConfirmSheet: View {
    let request: DeepLinkConfirmRequest
    let onAnswer: (Bool) -> Void

    @Environment(\.appTheme) private var theme

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(Self.summary(request))
                        .font(IonType.rowTitle)
                } footer: {
                    Text("This link came from outside the app. Run it only if you trust where it came from.")
                }
                ForEach(Self.details(request), id: \.label) { detail in
                    Section(detail.label) {
                        Text(detail.value)
                            .font(detail.monospaced ? .system(.callout, design: .monospaced) : .callout)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .navigationTitle("Open link?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Decline", role: .cancel) { onAnswer(false) }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Approve") { onAnswer(true) }
                        .tint(theme.accent)
                }
            }
        }
        .interactiveDismissDisabled()
    }

    struct Detail: Equatable {
        let label: String
        let value: String
        let monospaced: Bool
    }

    /// One sentence saying what approving does.
    static func summary(_ request: DeepLinkConfirmRequest) -> String {
        switch request.action {
        case "prompt":
            return request.submit == false
                ? "Start a conversation with this prompt in the composer."
                : "Start a conversation and send this prompt."
        case "terminal":
            return "Run this command in a terminal."
        case "ext":
            return "Run \(request.label ?? request.routeId ?? "an extension command")."
        default:
            return "Run a \(request.action) link."
        }
    }

    /// Everything the server said would run, in full.
    static func details(_ request: DeepLinkConfirmRequest) -> [Detail] {
        var rows: [Detail] = []
        func add(_ label: String, _ value: String?, monospaced: Bool = false) {
            guard let value, !value.isEmpty else { return }
            rows.append(Detail(label: label, value: value, monospaced: monospaced))
        }
        switch request.action {
        case "prompt":
            add("Prompt", request.text)
            add("Folder", request.dir, monospaced: true)
        case "terminal":
            add("Command", request.cmd, monospaced: true)
            add("Terminal", request.title)
            add("Folder", request.dir, monospaced: true)
        case "ext":
            add("Command", request.command, monospaced: true)
            add("Conversation", request.conversationId, monospaced: true)
            add("Folder", request.dir, monospaced: true)
        default:
            add("Command", request.command ?? request.cmd, monospaced: true)
            add("Prompt", request.text)
            add("Folder", request.dir, monospaced: true)
        }
        return rows
    }
}
