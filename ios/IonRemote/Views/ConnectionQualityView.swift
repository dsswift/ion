import SwiftUI

// MARK: - ConnectionQualityView

/// Signal-strength indicator that shows connection quality as three bars.
/// Tapping opens a popover with transport details.
struct ConnectionQualityView: View {
    @Environment(SessionViewModel.self) private var viewModel

    /// When `true`, shows only the bars icon without any inline labels.
    var compact: Bool = false

    @State private var showPopover = false

    var body: some View {
        let showView = viewModel.connectionState == .connected
            || viewModel.connectionState == .reconnecting
            || viewModel.connectionState == .connecting
        if showView {
            content
        } else {
            EmptyView()
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        let quality = viewModel.connectionQuality

        Button {
            showPopover = true
        } label: {
            if compact {
                signalBars(quality: quality)
            } else {
                HStack(spacing: 4) {
                    signalBars(quality: quality)
                    Text(quality.signalLevel.label)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showPopover) {
            popoverContent(quality: quality)
        }
    }

    // MARK: - Signal Bars

    private func signalBars(quality: ConnectionQuality) -> some View {
        let level = quality.signalLevel
        let filledCount = level.barCount
        let color = level.color

        return HStack(alignment: .bottom, spacing: 1.5) {
            ForEach(0..<3, id: \.self) { index in
                let barHeight: CGFloat = CGFloat(6 + index * 4) // 6, 10, 14
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(index < filledCount ? color : Color.gray.opacity(0.3))
                    .frame(width: 4, height: barHeight)
            }
        }
        .frame(height: 14)
    }

    // MARK: - Popover

    @ViewBuilder
    private func popoverContent(quality: ConnectionQuality) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(quality.transportLabel, systemImage: transportIcon(quality: quality))
                .font(.headline)

            HStack(spacing: 6) {
                signalBars(quality: quality)
                Text(quality.signalLevel.label)
                    .foregroundStyle(quality.signalLevel.color)
            }
            .font(.subheadline)

            if let latency = quality.latencyLabel {
                Label("Latency: \(latency)", systemImage: "clock")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            if quality.lastBuffered > 0 {
                Label("Desktop queue: \(quality.lastBuffered)", systemImage: "tray.full")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .presentationCompactAdaptation(.popover)
    }

    // MARK: - Helpers

    private func transportIcon(quality: ConnectionQuality) -> String {
        switch quality.transportState {
        case .lanPreferred:  "wifi"
        case .relayOnly:     "icloud"
        case .disconnected:  "wifi.slash"
        }
    }
}
