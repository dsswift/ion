import Foundation

/// Turns what a `StudioConnection` delivers into the `RemoteEvent`s the view
/// model already handles.
///
/// A thin connection's state rides one channel whose every payload is a
/// `RemoteEvent` object, so it is decoded with `RemoteEvent`'s own decoder and
/// nothing here knows any event type. A transcript page arrives as a
/// `studio_body` frame and becomes a transcript page event.
struct StudioEventMapper: Sendable {

    struct Output {
        var events: [RemoteEvent] = []
        /// A payload of a known type did not decode, so local state may now
        /// be missing something the server sent. The owner should resync.
        var needsResync = false
        /// Events on a channel an admin screen reads, passed on uninterpreted.
        var adminEvents: [StudioEvent] = []
    }

    /// Channels a thin connection receives that carry nothing this app acts on yet.
    static let observedOnlyChannels: Set<String> = ["studio:push-doorbell"]

    func map(_ inbound: StudioInbound) -> Output {
        switch inbound {
        case .event(let event):
            return map(event)
        case .body(let body):
            return Output(events: [Self.transcriptEvent(from: body)])
        case .welcome(let welcome):
            // The welcome carries no tabs for a thin view; the first paint
            // follows it as thin events. Its relays and scopes are the transport's to keep.
            DiagnosticLog.log("studio mapper: welcome carries no events", tag: "studio.map", level: .debug, fields: [
                "environment_id": welcome.environmentId, "scope_count": String(welcome.scopes.count)
            ])
            return Output()
        case .snapshot:
            DiagnosticLog.log("studio mapper: snapshot frame ignored, a thin view is painted by thin events", tag: "studio.map", level: .debug)
            return Output()
        case .environmentPolicy(let policy):
            // The transport keeps the policy's developer surfaces; it carries no events.
            DiagnosticLog.log("studio mapper: environment policy carries no events", tag: "studio.map", level: .debug, fields: [
                "policy_hash": policy.policyHash
            ])
            return Output()
        case .binary(let frame):
            DiagnosticLog.log("studio mapper: binary frame ignored, no surface reads it", tag: "studio.map", level: .debug, fields: [
                "key": frame.key
            ])
            return Output()
        }
    }

    // MARK: - Events

    private func map(_ event: StudioEvent) -> Output {
        // The server asks for this client's own log lines on its own channel,
        // not as a thin event. A client's log is the only record of what it
        // did, so a dropped request here is the whole record going missing.
        if event.channel == studioClientLogRequestChannel {
            let sinceSeq = event.payload["sinceSeq"]?.intValue ?? 0
            DiagnosticLog.log("studio mapper: client log requested", tag: "studio.map", level: .debug, fields: [
                "since_seq": String(sinceSeq)
            ])
            return Output(events: [.requestDiagnosticLogs(sinceSeq: sinceSeq)])
        }
        if ServerAdminEvent.channels.contains(event.channel) {
            DiagnosticLog.log("studio mapper: admin channel event routed", tag: "studio.map", level: .debug, fields: [
                "channel": event.channel
            ])
            return Output(adminEvents: [event])
        }
        guard event.channel == studioThinEventChannel else {
            if Self.observedOnlyChannels.contains(event.channel) {
                DiagnosticLog.log("studio mapper: channel observed, nothing to do", tag: "studio.map", level: .debug, fields: [
                    "channel": event.channel, "tab_id": event.payload["tabId"]?.stringValue ?? ""
                ])
            } else {
                DiagnosticLog.log("studio mapper: event on a channel a thin view does not expect, dropped", tag: "studio.map", level: .warn, fields: [
                    "channel": event.channel
                ])
            }
            return Output()
        }
        let type = event.payload["type"]?.stringValue ?? "unknown"
        let data: Data
        do {
            data = try JSONEncoder().encode(event.payload)
        } catch {
            DiagnosticLog.log("studio mapper: thin event payload did not re-encode, dropped", tag: "studio.map", level: .error, fields: [
                "type": type, "error": String(describing: error)
            ])
            return Output(needsResync: true)
        }
        do {
            return Output(events: [try JSONDecoder().decode(RemoteEvent.self, from: data)])
        } catch RemoteEventDecodeError.unknownType(let rawType) {
            // The server forwards event types this build has no case for. Skipping one loses nothing it could have shown.
            DiagnosticLog.trace("studio mapper: unknown event type skipped", tag: "studio.map", fields: [
                "type": rawType, "size": String(data.count)
            ])
            return Output()
        } catch {
            DiagnosticLog.log("studio mapper: thin event did not decode, dropped", tag: "studio.map", level: .error, fields: [
                "type": type, "size": String(data.count), "error": String(String(describing: error).prefix(500))
            ])
            return Output(needsResync: true)
        }
    }

    // MARK: - Transcript pages

    /// A `studio_body` reply as a transcript page. `before` echoes the
    /// request: nil means the newest page (which subscribed this connection to
    /// the stream), a row id means an older page.
    ///
    /// A row that does not decode fails the whole page rather than being
    /// skipped: a page with a hole in it no longer lines up with the
    /// revisions that follow, so the honest answer is no page at all.
    static func transcriptEvent(from body: StudioBody) -> RemoteEvent {
        let isNewest: Bool
        switch body.anchor {
        case .before: isNewest = false
        case .newest, .none: isNewest = true
        }
        guard let streamId = body.streamId, let epoch = body.epoch, let rev = body.rev,
              let total = body.total, let startIndex = body.startIndex else {
            DiagnosticLog.log("studio mapper: transcript reply carries no stream", tag: "studio.map", level: .warn, fields: [
                "tab_id": body.tabId, "rows": String(body.rows.count), "newest": String(isNewest)
            ])
            return .transcriptUnavailable(tabId: body.tabId, conversationId: body.conversationId, dispatchId: body.dispatchId, isNewest: isNewest, reason: "no_stream")
        }
        let rows: [Message]
        do {
            let data = try JSONEncoder().encode(body.rows)
            rows = try JSONDecoder().decode([TranscriptRow].self, from: data).map(\.message)
        } catch {
            DiagnosticLog.log("studio mapper: transcript page did not decode", tag: "studio.map", level: .error, fields: [
                "tab_id": body.tabId, "stream_id": streamId, "rows": String(body.rows.count),
                "error": String(String(describing: error).prefix(500))
            ])
            return .transcriptUnavailable(tabId: body.tabId, conversationId: body.conversationId, dispatchId: body.dispatchId, isNewest: isNewest, reason: "decode_failed")
        }
        DiagnosticLog.log("studio mapper: transcript page mapped", tag: "studio.map", level: .debug, fields: [
            "tab_id": body.tabId, "stream_id": streamId, "rows": String(rows.count),
            "rev": String(rev), "start_index": String(startIndex), "total": String(total), "newest": String(isNewest)
        ])
        return .transcriptPage(TranscriptPage(
            tabId: body.tabId,
            instanceId: body.instanceId ?? ConversationInstanceInfo.mainInstanceId,
            conversationId: body.conversationId,
            dispatchId: body.dispatchId,
            streamId: streamId,
            epoch: epoch,
            rev: rev,
            total: total,
            startIndex: startIndex,
            rows: rows,
            hasOlder: body.hasMore ?? (startIndex > 0),
            isNewest: isNewest
        ))
    }
}
