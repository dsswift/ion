import SwiftUI

/// Host CPU over the history window, 0...1, as a static line.
struct CPUHistoryLine: View {
    let values: [Double]

    @Environment(\.appTheme) private var theme

    var body: some View {
        GeometryReader { geo in
            Path { path in
                let step = geo.size.width / CGFloat(max(values.count - 1, 1))
                for (index, value) in values.enumerated() {
                    let point = CGPoint(x: CGFloat(index) * step, y: geo.size.height * (1 - CGFloat(min(max(value, 0), 1))))
                    if index == 0 { path.move(to: point) } else { path.addLine(to: point) }
                }
            }
            .stroke(theme.accent, lineWidth: 1)
        }
    }
}
