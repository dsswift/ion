import SwiftUI

/// Compact voice playback bar with skip/stop controls.
/// Reused in both ConversationView (pinned above input bar) and
/// TabListView (global overlay at top of list).
struct VoicePlaybackBar: View {
    let onSkip: () -> Void
    let onStopAll: () -> Void
    var hasPending: Bool = false

    var body: some View {
        HStack(spacing: 10) {
            // Animated speaker icon
            Image(systemName: "speaker.wave.2.fill")
                .font(.caption)
                .foregroundStyle(IonTheme.accent)
                .symbolEffect(.variableColor.iterative)

            Text("Voice playing…")
                .font(.caption)
                .foregroundStyle(.secondary)

            Spacer()

            if hasPending {
                Button { onSkip() } label: {
                    Image(systemName: "forward.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Button { onStopAll() } label: {
                Image(systemName: "stop.circle.fill")
                    .font(.callout)
                    .foregroundStyle(.red)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.ultraThinMaterial)
    }
}
