import SwiftUI

/// Approval card for an extension elicitation (`ctx.elicit`). The engine fans
/// `engine_elicitation_request` to every client and parks the run on an
/// indefinite human-wait until one answers; this card lets the user approve or
/// cancel and sends `desktop_respond_elicitation` back. Generic by design —
/// it renders any `mode`/`schema` so any extension's elicitation works, not
/// just Ion Dev's dispatch approval.
struct ElicitationCardView: View {
    @Environment(\.appTheme) private var theme
    @Environment(\.openURL) private var openURL
    @Environment(SessionViewModel.self) private var viewModel
    let tabId: String
    let request: ElicitationRequest

    @State private var dragOffset: CGFloat = 0

    private var heading: String {
        request.mode == "approval" ? "Approval Requested" : "Input Requested"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(heading)
                .font(.headline)

            if let message = request.message, !message.isEmpty {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(theme.textSecondary)
            }

            if request.mode == "url", let value = request.url, let url = URL(string: value) {
                Text(url.host ?? value)
                    .font(.subheadline.weight(.semibold))
                Text(value)
                    .ionType(.mono)
                    .textSelection(.enabled)
                    .lineLimit(3)

                Button("Open website") {
                    Haptic.medium()
                    openURL(url)
                }
                .buttonStyle(.bordered)
            }

            if let schema = request.schema, !schema.isEmpty {
                ScrollView {
                    Text(formatSchema(schema))
                        .ionType(.mono)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 160)
            }

            HStack(spacing: 12) {
                Button {
                    Haptic.medium()
                    viewModel.respondElicitation(tabId: tabId, requestId: request.requestId, approved: true)
                } label: {
                    Text("Approve")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, IonSpace.contentGap)
                }
                .buttonStyle(.borderedProminent)
                .tint(theme.accent)

                Button {
                    Haptic.medium()
                    viewModel.respondElicitation(tabId: tabId, requestId: request.requestId, approved: false, declined: true)
                } label: {
                    Text("Decline")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, IonSpace.contentGap)
                }
                .buttonStyle(.bordered)

                Button {
                    Haptic.medium()
                    viewModel.respondElicitation(tabId: tabId, requestId: request.requestId, approved: false)
                } label: {
                    Text("Cancel")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, IonSpace.contentGap)
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
            }
        }
        .padding()
        .cardStyle()
        .offset(y: dragOffset)
        .gesture(
            DragGesture(minimumDistance: 20)
                .onChanged { value in
                    if value.translation.height > 0 {
                        dragOffset = value.translation.height
                    }
                }
                .onEnded { value in
                    if value.translation.height > 80 {
                        Haptic.medium()
                        // Swipe-down cancels (declines), matching the permission card's
                        // swipe-to-deny gesture.
                        viewModel.respondElicitation(tabId: tabId, requestId: request.requestId, approved: false)
                    }
                    withAnimation(IonTheme.snappySpring) { dragOffset = 0 }
                }
        )
    }

    // MARK: - Helpers

    /// Render the harness-defined schema as a compact key: value list. Scalars
    /// inline; nested values JSON-described via AnyCodable's underlying value.
    private func formatSchema(_ schema: [String: AnyCodable]) -> String {
        schema
            .sorted { $0.key < $1.key }
            .map { key, value in "\(key): \(String(describing: value.value))" }
            .joined(separator: "\n")
    }
}
