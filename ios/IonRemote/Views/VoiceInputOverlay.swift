import SwiftUI

// MARK: - VoiceRecordingStrip

/// Minimal inline recording indicator that sits in the same button slot as the mic button.
/// Shows animated waveform bars, a stop button (keep text), and a cancel button (discard).
/// Text streams directly into the draft field — there is no staging buffer here.
struct VoiceRecordingStrip: View {
    let audioLevel: Float
    let onStop: () -> Void
    let onCancel: () -> Void

    @State private var animationPhase: Double = 0

    private static let barCount = 5
    private static let barPhases: [Double] = [0, 0.5, 0.2, 0.7, 0.35]
    private static let barFreqs: [Double] = [1.1, 0.9, 1.3, 0.85, 1.0]

    var body: some View {
        HStack(spacing: 4) {
            // Cancel — discard dictated text, restore pre-recording draft
            Button(action: onCancel) {
                Image(systemName: "xmark.circle.fill")
                    .font(.body)
                    .foregroundStyle(.secondary)
            }
            .accessibilityLabel("Cancel voice input")

            // Waveform bars
            HStack(spacing: 2) {
                ForEach(0..<Self.barCount, id: \.self) { index in
                    WaveBar(
                        audioLevel: audioLevel,
                        phase: Self.barPhases[index],
                        frequency: Self.barFreqs[index],
                        animationPhase: animationPhase
                    )
                }
            }
            .frame(width: 26)

            // Stop — keeps whatever is already in the text field
            Button(action: onStop) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(IonTheme.accent)
            }
            .accessibilityLabel("Done — keep dictated text")
        }
        .onAppear {
            withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) {
                animationPhase = 1.0
            }
        }
    }
}

// MARK: - WaveBar

private struct WaveBar: View {
    let audioLevel: Float
    let phase: Double
    let frequency: Double
    let animationPhase: Double

    private var barHeight: CGFloat {
        // Baseline idle oscillation (3–8pt) + audio-reactive boost (0–14pt)
        let idle = sin((animationPhase * frequency * .pi * 2) + phase * .pi * 2)
        let idleHeight = CGFloat(3 + idle * 2.5)
        let boost = CGFloat(audioLevel) * 14
        return max(3, idleHeight + boost)
    }

    var body: some View {
        RoundedRectangle(cornerRadius: 1.5)
            .fill(IonTheme.accent)
            .frame(width: 3, height: barHeight)
            .animation(.easeInOut(duration: 0.08), value: barHeight)
    }
}

// MARK: - Preview

#if DEBUG
#Preview {
    HStack(spacing: 8) {
        VoiceRecordingStrip(audioLevel: 0.5, onStop: {}, onCancel: {})
        VoiceRecordingStrip(audioLevel: 0, onStop: {}, onCancel: {})
    }
    .padding()
    .background(Color(.systemBackground))
}
#endif
