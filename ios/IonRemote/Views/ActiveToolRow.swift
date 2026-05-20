import SwiftUI

// MARK: - ActiveToolRow

/// Displays an in-progress tool call with elapsed time and an abort button
/// when the tool appears stalled (> 30s or marked stalled by the engine).
struct ActiveToolRow: View {
    let tabId: String
    let tool: ActiveToolInfo
    @Environment(SessionViewModel.self) private var viewModel
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
            Text(tool.toolName)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(isLikelyStalled ? Color.red.opacity(0.85) : Color.orange.opacity(0.85))
                .clipShape(Capsule())

            // Elapsed time
            Text(formatElapsed(elapsed))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(isLikelyStalled ? .red : .secondary)

            if isLikelyStalled {
                Text("may be stuck")
                    .font(.caption2)
                    .foregroundStyle(.red.opacity(0.8))
            }

            Spacer()

            // Status indicator or abort button
            if isLikelyStalled {
                Button {
                    showAbortConfirm = true
                } label: {
                    Text("Abort")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Color.red)
                        .clipShape(Capsule())
                }
            } else {
                // Pulsing activity dot
                Circle()
                    .fill(.orange)
                    .frame(width: 6, height: 6)
                    .opacity(pulseOpacity)
                    .animation(.easeInOut(duration: 1).repeatForever(autoreverses: true), value: now)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            (isLikelyStalled ? Color.red : Color.orange)
                .opacity(0.08)
        )
        .clipShape(RoundedRectangle(cornerRadius: 6))
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
        // Alternate between 0.3 and 1.0 based on time
        let phase = now.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2)
        return phase < 1 ? 0.3 : 1.0
    }

    private func formatElapsed(_ interval: TimeInterval) -> String {
        let seconds = Int(interval)
        if seconds < 60 {
            return "\(seconds)s"
        }
        let minutes = seconds / 60
        let secs = seconds % 60
        return "\(minutes)m \(secs)s"
    }
}
