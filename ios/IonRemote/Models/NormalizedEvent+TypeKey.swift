import Foundation

// MARK: - RemoteEvent wire type key helper

extension RemoteEvent {
    /// The wire type string for this event (e.g. "desktop_snapshot", "desktop_tab_status").
    /// Used by the per-frame receive latency logger in TransportManager+Receive.swift
    /// so log lines can be bucketed by event type in Grafana without encoding the event.
    ///
    /// Derivation: re-encode to JSON, extract the "type" field, fall back to
    /// "<unknown>" when decode fails (should never happen for well-formed events).
    var typeKey: String {
        guard let data = try? JSONEncoder().encode(self),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type_ = json["type"] as? String else {
            return "<unknown>"
        }
        return type_
    }
}
