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
        VStack(spacing: IonTheme.sm) {
            ForEach(messages.prefix(2)) { toast in
                toastBanner(toast)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .onTapGesture { onDismiss(toast.id) }
            }
        }
        .padding(.horizontal, IonTheme.md)
        .padding(.top, IonTheme.sm)
        .animation(IonTheme.snappySpring, value: messages.map(\.id))
    }

    private func toastBanner(_ toast: ToastMessage) -> some View {
        HStack(spacing: IonTheme.sm) {
            RoundedRectangle(cornerRadius: 2).fill(toast.style.color).frame(width: 4)
            Image(systemName: toast.style.icon)
                .foregroundStyle(toast.style.color).font(.body)
            VStack(alignment: .leading, spacing: 2) {
                Text(toast.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                if let detail = toast.detail {
                    Text(detail).font(.caption)
                        .foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer()
        }
        .padding(.vertical, IonTheme.sm)
        .padding(.trailing, IonTheme.md)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.medium))
        .shadow(color: .black.opacity(0.25), radius: 8, y: 4)
    }
}
