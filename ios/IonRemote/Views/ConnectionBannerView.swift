import SwiftUI

// MARK: - ConnectionBannerView

/// Persistent banner shown at the top of TabListView when the connection
/// is not live -- reconnecting, showing cached data, or fully disconnected.
/// Surfaces the cache timestamp and staleness that was previously invisible.
struct ConnectionBannerView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme

    var body: some View {
        let state = viewModel.connectionState
        let health = viewModel.connectionHealth
        let freshness = health.freshness

        if shouldShow(state: state, freshness: freshness) {
            bannerContent(state: state, freshness: freshness, health: health)
                .transition(.move(edge: .top).combined(with: .opacity))
                .animation(IonTheme.snappySpring, value: state)
        }
    }

    // MARK: - Visibility

    private func shouldShow(state: ConnectionState, freshness: ConnectionHealth.Freshness) -> Bool {
        switch state {
        case .reconnecting, .connecting:
            return true
        case .disconnected:
            return !viewModel.tabs.isEmpty
        case .connected:
            return !freshness.isLive
        }
    }

    // MARK: - Content

    @ViewBuilder
    private func bannerContent(
        state: ConnectionState,
        freshness: ConnectionHealth.Freshness,
        health: ConnectionHealth
    ) -> some View {
        HStack(spacing: IonSpace.compactGap) {
            Image(systemName: icon(state: state, freshness: freshness))
                .font(.caption)
                .foregroundStyle(iconColor(state: state, freshness: freshness))

            VStack(alignment: .leading, spacing: 1) {
                Text(title(state: state, freshness: freshness))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.primary)

                if let subtitle = subtitle(state: state, health: health) {
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            if state == .reconnecting || state == .connecting {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, IonSpace.contentGap)
        .padding(.vertical, IonSpace.compactGap)
        .background(bannerBackground(state: state, freshness: freshness))
        .clipShape(RoundedRectangle(cornerRadius: IonRadius.control))
        .padding(.horizontal, IonSpace.contentGap)
        .padding(.top, IonSpace.hairlineGap)
    }

    // MARK: - Helpers

    private func icon(state: ConnectionState, freshness: ConnectionHealth.Freshness) -> String {
        switch state {
        case .reconnecting, .connecting:
            return "arrow.triangle.2.circlepath"
        case .disconnected:
            return "wifi.slash"
        case .connected:
            return freshness.icon
        }
    }

    private func iconColor(state: ConnectionState, freshness: ConnectionHealth.Freshness) -> Color {
        switch state {
        case .reconnecting, .connecting:
            return .yellow
        case .disconnected:
            return .red
        case .connected:
            return freshness.color
        }
    }

    private func title(state: ConnectionState, freshness: ConnectionHealth.Freshness) -> String {
        switch state {
        case .reconnecting:
            return "Reconnecting to desktop..."
        case .connecting:
            return "Connecting..."
        case .disconnected:
            return "Desktop offline"
        case .connected:
            return freshness.label
        }
    }

    private func subtitle(state: ConnectionState, health: ConnectionHealth) -> String? {
        switch state {
        case .reconnecting, .connecting:
            if let label = health.lastSyncLabel {
                return "Last sync: \(label)"
            }
            return "Showing cached layout"
        case .disconnected:
            if let label = health.lastSyncLabel {
                return "Last sync: \(label)"
            }
            return nil
        case .connected:
            if let label = health.lastSyncLabel {
                return "Last sync: \(label)"
            }
            return relayModeLabel(health: health)
        }
    }

    private func relayModeLabel(health: ConnectionHealth) -> String? {
        switch health.relayAckMode {
        case .legacy:     return "Relay (legacy)"
        case .unavailable: return nil
        case .strict:     return nil
        }
    }

    private func bannerBackground(state: ConnectionState, freshness: ConnectionHealth.Freshness) -> some ShapeStyle {
        let base: Color = switch state {
        case .reconnecting, .connecting: .yellow
        case .disconnected: .red
        case .connected: freshness.color
        }
        return base.opacity(0.12)
    }
}
