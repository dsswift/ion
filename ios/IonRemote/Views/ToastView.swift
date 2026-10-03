import SwiftUI

// MARK: - ToastMessage

struct ToastMessage: Identifiable {
    let id = UUID()
    let style: ToastStyle
    let title: String
    let detail: String?
    let duration: TimeInterval

    init(style: ToastStyle, title: String, detail: String? = nil, duration: TimeInterval? = nil) {
        self.style = style
        self.title = title
        self.detail = detail
        self.duration = duration ?? (style == .error ? 6.0 : 4.0)
    }
}

enum ToastStyle {
    case error, warning, info, success

    var icon: String {
        switch self {
        case .error:   return "xmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .info:    return "info.circle.fill"
        case .success: return "checkmark.circle.fill"
        }
    }
    var color: Color {
        switch self {
        case .error: return .red;    case .warning: return .orange
        case .info:  return .blue;   case .success: return .green
        }
    }
}

// MARK: - ToastOverlay

struct ToastOverlay: View {
    let messages: [ToastMessage]
    let onDismiss: (UUID) -> Void

    var body: some View {
        // Center-aligned VStack so each toast hugs its content horizontally
        // rather than stretching to the full width of the overlay container.
        VStack(alignment: .center, spacing: IonSpace.compactGap) {
            ForEach(messages.prefix(2)) { toast in
                toastBanner(toast)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .onTapGesture { onDismiss(toast.id) }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, IonSpace.contentGap)
        .padding(.top, IonSpace.compactGap)
        .animation(IonTheme.snappySpring, value: messages.map(\.id))
    }

    private func toastBanner(_ toast: ToastMessage) -> some View {
        // Content-hugging HStack + .fixedSize on the vertical axis keeps the
        // pill compact. Without these, a Spacer() would let the overlay
        // container inflate the banner to fill the entire screen.
        HStack(spacing: IonSpace.compactGap) {
            Image(systemName: toast.style.icon)
                .foregroundStyle(toast.style.color)
                .font(IonType.rowTitle)
            VStack(alignment: .leading, spacing: 2) { // design-geometry: 2pt title-to-detail gap inside a two-line toast; below the 4pt rhythm floor
                Text(toast.title)
                    .font(IonType.sectionLabel)
                    .foregroundStyle(.primary)
                if let detail = toast.detail {
                    Text(detail)
                        .font(IonType.metadata)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
        .padding(.horizontal, IonSpace.contentGap)
        .padding(.vertical, IonSpace.compactInset)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: IonRadius.container))
        .shadow(color: .black.opacity(0.25), radius: 8, y: 4)
        // Cap width so long detail strings wrap inside the pill instead of
        // spanning the whole screen.
        .frame(maxWidth: 360)
        // Lock the pill to the intrinsic height of its content.
        .fixedSize(horizontal: false, vertical: true)
    }
}
