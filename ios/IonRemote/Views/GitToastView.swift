import SwiftUI

/// Transient toast overlay for git mutation results.
/// Slides in from top, auto-dismisses after 2 seconds.
struct GitToastView: View {
    let toast: GitToast
    let onDismiss: () -> Void

    @State private var isVisible = false

    var body: some View {
        if isVisible {
            HStack(spacing: 8) {
                Image(systemName: toast.isError ? "xmark.circle.fill" : "checkmark.circle.fill")
                    .font(.subheadline)
                    .foregroundStyle(toast.isError ? IonTheme.statusError : IonTheme.accent)

                Text(toast.message)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
            }
            .padding(.horizontal, IonTheme.md)
            .padding(.vertical, IonTheme.sm)
            .background(.regularMaterial)
            .clipShape(Capsule())
            .shadow(color: .black.opacity(0.15), radius: 8, y: 4)
            .transition(.move(edge: .top).combined(with: .opacity))
            .onTapGesture { dismiss() }
        }
    }

    private func dismiss() {
        withAnimation(IonTheme.snappySpring) {
            isVisible = false
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            onDismiss()
        }
    }

    // Present on appear and auto-dismiss after 2 seconds
    func onAppearAnimate() -> some View {
        self.onAppear {
            withAnimation(IonTheme.snappySpring) {
                isVisible = true
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                dismiss()
            }
        }
    }
}
