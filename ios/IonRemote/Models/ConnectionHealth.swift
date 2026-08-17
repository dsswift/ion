import Foundation
import SwiftUI
import Observation

// MARK: - ConnectionHealth

/// Centralized connection truth for UI rendering decisions.
/// Tracks whether the displayed data is live or cached, when the last
/// successful sync occurred, and derives a staleness assessment.
@Observable
final class ConnectionHealth {

    // MARK: - Freshness

    enum Freshness {
        case live
        case cached(age: TimeInterval)
        case stale(age: TimeInterval)
        case disconnected

        /// Threshold beyond which cached data is considered stale.
        static let staleThreshold: TimeInterval = 120

        var isLive: Bool {
            if case .live = self { return true }
            return false
        }

        var label: String {
            switch self {
            case .live:
                return "Live"
            case .cached(let age):
                return "Cached \(Self.formatAge(age))"
            case .stale(let age):
                return "Stale \(Self.formatAge(age))"
            case .disconnected:
                return "Disconnected"
            }
        }

        var color: Color {
            switch self {
            case .live:          .green
            case .cached:        .yellow
            case .stale:         .orange
            case .disconnected:  .red
            }
        }

        var icon: String {
            switch self {
            case .live:          "checkmark.circle.fill"
            case .cached:        "clock.arrow.circlepath"
            case .stale:         "exclamationmark.triangle.fill"
            case .disconnected:  "wifi.slash"
            }
        }

        private static func formatAge(_ interval: TimeInterval) -> String {
            let seconds = Int(interval)
            if seconds < 60 { return "\(seconds)s ago" }
            let minutes = seconds / 60
            if minutes < 60 { return "\(minutes)m ago" }
            let hours = minutes / 60
            if hours < 24 { return "\(hours)h ago" }
            let days = hours / 24
            return "\(days)d ago"
        }
    }

    // MARK: - Relay capability

    /// Relay delivery ACK mode discovered by the capability probe.
    /// Exposed here so the banner and any diagnostic UI can surface it.
    private(set) var relayAckMode: RelayCapabilities.AckMode = .unavailable

    func updateRelayAckMode(_ mode: RelayCapabilities.AckMode) {
        relayAckMode = mode
    }

    // MARK: - State

    /// When the last successful snapshot was received from the desktop.
    private(set) var lastSyncDate: Date?

    /// When the currently displayed cached layout was originally saved.
    private(set) var cacheRestoredAt: Date?

    /// The timestamp embedded in the restored cache (CachedLayout.cachedAt).
    private(set) var cacheOriginalDate: Date?

    /// Whether the current data was loaded from a disk cache rather than
    /// received live from the desktop.
    private(set) var isShowingCachedData: Bool = false

    // MARK: - Computed

    /// Current data freshness assessment.
    var freshness: Freshness {
        guard let lastSync = lastSyncDate else {
            if isShowingCachedData, let cacheDate = cacheOriginalDate {
                let age = Date().timeIntervalSince(cacheDate)
                if age > Freshness.staleThreshold {
                    return .stale(age: age)
                }
                return .cached(age: age)
            }
            return .disconnected
        }

        let age = Date().timeIntervalSince(lastSync)
        if age < 10 {
            return .live
        }
        if isShowingCachedData {
            if age > Freshness.staleThreshold {
                return .stale(age: age)
            }
            return .cached(age: age)
        }
        return .live
    }

    /// Formatted string for the last sync time, suitable for display.
    var lastSyncLabel: String? {
        guard let date = lastSyncDate ?? cacheOriginalDate else { return nil }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    // MARK: - Mutation

    /// Record a successful live snapshot from the desktop.
    func recordLiveSync() {
        lastSyncDate = Date()
        isShowingCachedData = false
        cacheRestoredAt = nil
        cacheOriginalDate = nil
    }

    /// Record that a cached layout was restored from disk.
    func recordCacheRestore(cachedAt: Date) {
        cacheRestoredAt = Date()
        cacheOriginalDate = cachedAt
        isShowingCachedData = true
    }

    /// Reset all state (device switch, unpair).
    func reset() {
        lastSyncDate = nil
        cacheRestoredAt = nil
        cacheOriginalDate = nil
        isShowingCachedData = false
        relayAckMode = .unavailable
    }
}
