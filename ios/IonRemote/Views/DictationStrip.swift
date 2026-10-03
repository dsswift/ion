import SwiftUI

/// The listening indicator inside the composer's controls row while a
/// dictation session is open: a short level-reactive waveform and an elapsed
/// counter, or a spinner while the recognizer finishes its tail.
///
/// The bars move with the voice and only with the voice. A looping idle
/// animation would repaint the composer continuously for the whole session;
/// silence here is a still strip, which is also the honest reading of it.
struct DictationStrip: View {
    @Environment(\.appTheme) private var theme
    let audioLevel: Float
    let startedAt: Date?
    let isFinishing: Bool

    /// The most recent levels, newest last, so the bars read as a scrolling
    /// waveform rather than five copies of one number.
    @State private var levels: [Float] = Array(repeating: 0, count: DictationStrip.barCount)

    private static let barCount = 7
    private static let barWidth: CGFloat = 3
    private static let barMinHeight: CGFloat = 3
    private static let barMaxHeight: CGFloat = 18

    var body: some View {
        HStack(spacing: IonSpace.compactGap) {
            if isFinishing {
                ProgressView()
                    .controlSize(.small)
                Text("Finishing…")
                    .font(IonType.metadata)
                    .foregroundStyle(theme.textSecondary)
            } else {
                waveform
                if let startedAt {
                    TimelineView(.periodic(from: startedAt, by: 1)) { context in
                        Text(Self.elapsedLabel(from: startedAt, to: context.date))
                            .font(IonType.mono)
                            .foregroundStyle(theme.textSecondary)
                            .monospacedDigit()
                    }
                }
            }
        }
        .frame(minHeight: Self.barMaxHeight)
        .onChange(of: audioLevel) { _, level in
            levels.removeFirst()
            levels.append(level)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(isFinishing ? "Finishing dictation" : "Listening")
    }

    private var waveform: some View {
        HStack(spacing: 2) { // design-geometry: 2pt gap between 3pt waveform bars; below the 4pt rhythm floor
            ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                RoundedRectangle(cornerRadius: Self.barWidth / 2) // design-geometry: hairline rounding on a thin waveform bar; below the control radius floor
                    .fill(theme.accent)
                    .frame(width: Self.barWidth, height: Self.barHeight(for: level))
                    .animation(.easeOut(duration: 0.1), value: level)
            }
        }
    }

    /// Bar height for a normalized level. The curve lifts quiet speech so a
    /// normal speaking voice fills a visible share of the range.
    static func barHeight(for level: Float) -> CGFloat {
        let eased = CGFloat(min(max(level, 0), 1)).squareRoot()
        return barMinHeight + eased * (barMaxHeight - barMinHeight)
    }

    /// "0:07" style elapsed counter.
    static func elapsedLabel(from start: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

#if DEBUG
#Preview {
    VStack(spacing: 16) {
        DictationStrip(audioLevel: 0.6, startedAt: Date().addingTimeInterval(-67), isFinishing: false)
        DictationStrip(audioLevel: 0, startedAt: Date(), isFinishing: false)
        DictationStrip(audioLevel: 0, startedAt: nil, isFinishing: true)
    }
    .padding()
    .background(Color(.systemBackground))
}
#endif
