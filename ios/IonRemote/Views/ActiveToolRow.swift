import SwiftUI

// MARK: - ActiveToolRow
//
// Displays an in-progress tool call with elapsed time and an abort button
// when the tool appears stalled (> 30s or marked stalled by the engine).
// Ported from Jarvis fork StatusDrawer, adapted to mainline AppTheme.
// Used exclusively by StatusDrawerView (not the main conversation transcript).

struct ActiveToolRow: View {
    let tabId: String
    let tool: ActiveToolInfo
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme
    @State private var now = Date()
    @State private var showAbortConfirm = false

    private var elapsed: TimeInterval {
        now.timeIntervalSince(tool.startTime)
    }

    private var isLikelyStalled: Bool {
        tool.isStalled || elapsed > 30
    }

    var body: some View {
        HStack(spacing: 8) {
            // Tool name capsule
            //
            // Foreground and background are chosen as a PAIR. The previous
            // white-on-saturated-fill spelling was an accessibility defect that
            // no token could fix: white 12pt semibold over the warm fill at 0.85
            // computes 2.80:1 on ion-dark and 3.80:1 on ion-light, and over the
            // stalled statusError fill 3.54:1 and 4.14:1 -- all below the 4.5:1
            // this small-but-bold text needs. Any hue saturated enough to read
            // as a warning is too light to back white text, so retinting the
            // background alone would have shipped a token that looked correct
            // and left the failure in place.
            //
            // A low-alpha tint of the same status hue with theme.textPrimary on
            // top fixes it and keeps the semantic color visible: 10.76:1 on
            // ion-dark, 12.66:1 on ion-light, 5.35:1 on ion-classic and 8.44:1
            // on jarvis-hud for the active-warning arm; 11.51:1 / 12.06:1 /
            // 6.00:1 / 9.65:1 for the stalled arm.
            Text(tool.toolName)
                .font(.caption.weight(.semibold))
                .foregroundStyle(theme.textPrimary)
                .padding(.horizontal, IonSpace.compactGap)
                .padding(.vertical, 3) // design-geometry: 3pt inset; below the 4pt rhythm floor
                .background(
                    (isLikelyStalled ? theme.statusError : theme.statusActiveWarning)
                        .opacity(0.18)
                )
                .clipShape(Capsule())

            // Elapsed time
            Text(formatElapsed(elapsed))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(isLikelyStalled ? theme.statusError : theme.textSecondary)

            if isLikelyStalled {
                Text("may be stuck")
                    .font(.caption2)
                    .foregroundStyle(theme.statusError.opacity(0.8))
            }

            Spacer()

            // Interrupt lives in the composer. Transcript/status drawer has no
            // second abort control or animated running indicator.
        }
        .padding(.horizontal, 10) // design-geometry: 10pt gap between compactGap and contentGap; off the 4pt ratio scale
        .padding(.vertical, IonSpace.compactInset)
        .background(
            (isLikelyStalled ? theme.statusError : theme.statusActiveWarning)
                .opacity(0.08)
        )
        .clipShape(RoundedRectangle(cornerRadius: IonRadius.container))
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { time in
            now = time
        }
        .alert("Abort Run?", isPresented: $showAbortConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Abort", role: .destructive) {
                viewModel.abortEngine(tabId: tabId)
            }
        } message: {
            Text("\(tool.toolName) has been running for \(Int(elapsed))s. This may be waiting for a macOS permission dialog. Aborting will stop the entire run.")
        }
    }

    private var pulseOpacity: Double {
        let phase = now.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2)
        return phase < 1 ? 0.3 : 1.0
    }

    private func formatElapsed(_ interval: TimeInterval) -> String {
        let seconds = Int(interval)
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        let secs = seconds % 60
        return "\(minutes)m \(secs)s"
    }
}
