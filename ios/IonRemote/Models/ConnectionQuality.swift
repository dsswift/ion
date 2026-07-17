import Foundation
import SwiftUI
import Observation

// MARK: - ConnectionQuality

/// Tracks rolling heartbeat measurements and derives a signal quality level
/// for the current transport connection.
@Observable
final class ConnectionQuality {

    // MARK: - SignalLevel

    enum SignalLevel {
        case excellent, good, fair, poor, none

        var color: Color {
            switch self {
            case .excellent: .green
            case .good:      .green
            case .fair:      .yellow
            case .poor:      .orange
            case .none:      .red
            }
        }

        var label: String {
            switch self {
            case .excellent: "Excellent"
            case .good:      "Good"
            case .fair:      "Fair"
            case .poor:      "Poor"
            case .none:      "No Signal"
            }
        }

        var barCount: Int {
            switch self {
            case .excellent: 3
            case .good:      2
            case .fair:      1
            case .poor:      0
            case .none:      0
            }
        }
    }

    // MARK: - HeartbeatSample

    struct HeartbeatSample {
        let receivedAt: Date
        /// Desktop-side Unix timestamp in milliseconds.
        let senderTs: Double
        /// Number of buffered events on the desktop side.
        let buffered: Int
    }

    // MARK: - State

    /// Rolling window of the most recent heartbeat measurements (max 5).
    private(set) var samples: [HeartbeatSample] = []

    /// Current transport connectivity state, kept in sync by the session.
    var transportState: TransportState = .disconnected

    /// Wall-clock time the last heartbeat was received, or nil if none yet.
    /// Tracked for liveness/diagnostics; the wire-level watchdog lives in
    /// `TransportManager`, but the ViewModel records the receive time here too.
    var lastHeartbeatAt: Date?

    // MARK: - Computed

    var signalLevel: SignalLevel {
        switch transportState {
        case .disconnected:
            return .none
        case .lanPreferred:
            return .excellent
        case .relayOnly:
            return relaySignalLevel
        }
    }

    var lastBuffered: Int {
        samples.last?.buffered ?? 0
    }

    var transportLabel: String {
        switch transportState {
        case .lanPreferred:  "LAN Direct"
        case .relayOnly:     "Relay"
        case .disconnected:  "Disconnected"
        }
    }

    /// Human-readable median latency for relay connections, nil otherwise.
    var latencyLabel: String? {
        guard transportState == .relayOnly, !samples.isEmpty else { return nil }
        let median = medianLatency
        guard median >= 0 else { return nil }
        if median < 1000 {
            return "\(Int(median))ms"
        } else {
            return String(format: "%.1fs", median / 1000)
        }
    }

    // MARK: - Mutation

    func recordHeartbeat(senderTs: Double, buffered: Int) {
        let sample = HeartbeatSample(
            receivedAt: Date(),
            senderTs: senderTs,
            buffered: buffered
        )
        lastHeartbeatAt = sample.receivedAt
        samples.append(sample)
        if samples.count > 5 {
            samples.removeFirst(samples.count - 5)
        }
    }

    func reset() {
        samples.removeAll()
        lastHeartbeatAt = nil
    }

    // MARK: - Private

    private var relaySignalLevel: SignalLevel {
        guard let latest = samples.last else { return .good }

        let elapsed = Date().timeIntervalSince(latest.receivedAt)
        if elapsed > 45 { return .none }
        if elapsed > 30 { return .poor }
        if elapsed > 15 { return .fair }

        let median = medianLatency
        if median < 200   { return .excellent }
        if median < 1000  { return .good }
        if median < 5000  { return .fair }
        return .poor
    }

    /// Median one-way latency across current samples in milliseconds.
    private var medianLatency: Double {
        let latencies = samples
            .map { $0.receivedAt.timeIntervalSince1970 * 1000 - $0.senderTs }
            .sorted()
        guard !latencies.isEmpty else { return 0 }
        let mid = latencies.count / 2
        if latencies.count.isMultiple(of: 2) {
            return (latencies[mid - 1] + latencies[mid]) / 2
        }
        return latencies[mid]
    }
}
