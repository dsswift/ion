import SwiftUI

/// Compact voice playback bar with skip/stop controls, shown as an overlay
/// at the top of the conversation list while a spoken response plays.
struct VoicePlaybackBar: View {
    @Environment(\.appTheme) private var theme
    let onSkip: () -> Void
    let onStopAll: () -> Void
    var hasPending: Bool = false

    var body: some View {
        HStack(spacing: IonSpace.compactGap) {
            Image(systemName: "speaker.wave.2.fill")
                .font(IonType.metadata)
                .foregroundStyle(theme.accent)
                .symbolEffect(.variableColor.iterative)

            Text("Speaking…")
                .font(IonType.metadata)
                .foregroundStyle(theme.textSecondary)

            Spacer()

            if hasPending {
                Button { onSkip() } label: {
                    Image(systemName: "forward.fill")
                        .font(IonType.metadata)
                        .foregroundStyle(theme.textSecondary)
                        .frame(width: IonSpace.screenInset, height: IonSpace.screenInset)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Skip to next response")
            }

            Button { onStopAll() } label: {
                Image(systemName: "stop.fill")
                    .font(IonType.metadata)
                    .foregroundStyle(theme.statusError)
                    .frame(width: IonSpace.screenInset, height: IonSpace.screenInset)
                    .background(Circle().fill(theme.statusError.opacity(0.15)))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop speaking")
        }
        .padding(.horizontal, IonSpace.rowInset)
        .padding(.vertical, IonSpace.hairlineGap)
        .background(.ultraThinMaterial)
    }
}
