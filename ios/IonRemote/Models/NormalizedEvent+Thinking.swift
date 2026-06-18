import Foundation

// MARK: - Extended-thinking events (issue #158)
//
// Decode + encode for the three extended-thinking wire events the desktop
// forwards to iOS:
//
//   - desktop_thinking_block_start — a reasoning block began. No payload
//     beyond the standard tabId / instanceId correlators; its arrival is the
//     liveness signal that drives the activity indicator on the thinking row.
//   - desktop_thinking_delta — an incremental chunk of reasoning text on
//     `thinkingText`. This is the ONLY thinking event that may NOT arrive:
//     the engine's ThinkingConfig.StreamDeltas and the per-pairing
//     `streamThinkingToRemote` desktop setting can gate it off for
//     low-bandwidth links, in which case the UI works from the boundaries
//     (start / end) alone and renders a summary-only row.
//   - desktop_thinking_block_end — the reasoning block finished. All three
//     summary fields are optional on the wire (the engine ships them with
//     omitempty): thinkingTotalTokens (approximate token estimate),
//     thinkingElapsedSeconds (wall-clock duration), thinkingRedacted (true
//     for encrypted reasoning with no readable text). Older desktops omit
//     them; decodeIfPresent keeps absent fields absent rather than failing.
//
// Extracted into its own file (rather than extending NormalizedEvent+Engine /
// +EngineDecoder) because both of those files are already near the 600-line
// Swift cap. The decode helper is dispatched from NormalizedEvent+Codable.swift
// after the other families; the encode helper returns false for non-thinking
// cases so the encoder fan-out can fall through to the next family.

extension RemoteEvent {

    /// Decode the three extended-thinking events from their wire shape.
    /// Returns `nil` when `type` is not a thinking event so the dispatcher
    /// in NormalizedEvent+Codable.swift can try the next family.
    static func decodeThinking(
        type: TypeKey,
        container: KeyedDecodingContainer<CodingKeys>
    ) throws -> RemoteEvent? {
        switch type {
        case .engineThinkingBlockStart:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            return .engineThinkingBlockStart(tabId: tabId, instanceId: instanceId)

        case .engineThinkingDelta:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            // `thinkingText` defaults to empty so a malformed/empty delta
            // never fails the decode — the accumulator simply appends "".
            let thinkingText = try container.decodeIfPresent(String.self, forKey: .thinkingText) ?? ""
            return .engineThinkingDelta(tabId: tabId, instanceId: instanceId, thinkingText: thinkingText)

        case .engineThinkingBlockEnd:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            // All three summary fields are optional. decodeIfPresent leaves
            // them nil when the desktop omits them (older desktop, or the
            // engine had no authoritative token count) so the UI can choose
            // the right summary affordance without inventing values.
            let totalTokens = try container.decodeIfPresent(Int.self, forKey: .thinkingTotalTokens)
            let elapsedSeconds = try container.decodeIfPresent(Double.self, forKey: .thinkingElapsedSeconds)
            let redacted = try container.decodeIfPresent(Bool.self, forKey: .thinkingRedacted)
            return .engineThinkingBlockEnd(
                tabId: tabId,
                instanceId: instanceId,
                thinkingTotalTokens: totalTokens,
                thinkingElapsedSeconds: elapsedSeconds,
                thinkingRedacted: redacted
            )

        default:
            return nil
        }
    }

    /// Encode the three extended-thinking events. Returns `true` if the
    /// receiver was a thinking event (so the encoder fan-out in
    /// NormalizedEvent+Codable.swift stops), `false` otherwise.
    ///
    /// iOS never originates these events in practice (the engine emits them
    /// and the desktop forwards), but a clean encoder is required so the
    /// decode → encode round-trip in the contract tests loses no fields and
    /// — critically — leaves absent optional fields absent (encodeIfPresent
    /// rather than emitting JSON null).
    func encodeThinking(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {
        case .engineThinkingBlockStart(let tabId, let instanceId):
            try container.encode(TypeKey.engineThinkingBlockStart, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            return true

        case .engineThinkingDelta(let tabId, let instanceId, let thinkingText):
            try container.encode(TypeKey.engineThinkingDelta, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            try container.encode(thinkingText, forKey: .thinkingText)
            return true

        case .engineThinkingBlockEnd(let tabId, let instanceId, let totalTokens, let elapsedSeconds, let redacted):
            try container.encode(TypeKey.engineThinkingBlockEnd, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encodeIfPresent(instanceId, forKey: .instanceId)
            // encodeIfPresent so an absent summary field stays absent on the
            // round-trip — the contract test asserts this forward-compat
            // posture (a legacy-desktop block_end has no summary fields).
            try container.encodeIfPresent(totalTokens, forKey: .thinkingTotalTokens)
            try container.encodeIfPresent(elapsedSeconds, forKey: .thinkingElapsedSeconds)
            try container.encodeIfPresent(redacted, forKey: .thinkingRedacted)
            return true

        default:
            return false
        }
    }
}
