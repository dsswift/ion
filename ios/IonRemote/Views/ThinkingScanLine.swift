import SwiftUI

// MARK: - ThinkingScanLine

/// A horizontal scan-line that sweeps left-to-right while the assistant
/// is thinking. Used as the custom activity indicator for JarvisArcReactorTheme.
struct ThinkingScanLine: View {
    let isActive: Bool
    @Environment(\.appTheme) private var theme
    @State private var offset: CGFloat = -0.4

    var body: some View {
        GeometryReader { geo in
            Rectangle()
                .fill(LinearGradient(
                    colors: [.clear, theme.accent.opacity(0.7), .clear],
                    startPoint: .leading,
                    endPoint: .trailing
                ))
                .frame(width: geo.size.width * 0.4, height: 1)
                .offset(x: offset * geo.size.width)
                .onChange(of: isActive) { _, active in
                    if active { animateScan(width: geo.size.width) }
                    else { offset = -0.4 }
                }
                .onAppear {
                    if isActive { animateScan(width: geo.size.width) }
                }
        }
        .frame(height: 1)
        .opacity(isActive ? 1 : 0)
        .animation(.easeInOut(duration: 0.3), value: isActive)
    }

    private func animateScan(width: CGFloat) {
        offset = -0.4
        withAnimation(.linear(duration: 1.8).repeatForever(autoreverses: false)) {
            offset = 1.0
        }
    }
}
