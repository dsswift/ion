import Foundation

// MARK: - Decoded payload delivery

extension TransportManager {

    /// Reassemble transport fragments before decoding and publishing complete
    /// application events. Inbound callers serialize this state on inboundQueue.
    func handleDecodedPayload(_ jsonData: Data, wire: WireMessage) {
        switch payloadChunkAssembler.accept(jsonData) {
        case .passthrough(let payload):
            decodeAndYieldEvent(payload, wire: wire, markFrame: true)
        case .held:
            markFrameProcessed(wire.seq)
        case .rejected:
            DiagnosticLog.log("payload chunk rejected; requesting full sync", tag: "transport.receive", level: .error, fields: [
                "seq": String(wire.seq),
                "payload_bytes": String(jsonData.count)
            ])
            requestFullSyncAfterPayloadFailure()
        case .assembled(let payloads):
            markFrameProcessed(wire.seq)
            for payload in payloads {
                decodeAndYieldEvent(payload, wire: wire, markFrame: false)
            }
        }
    }

    private func decodeAndYieldEvent(_ jsonData: Data, wire: WireMessage, markFrame: Bool) {
        // Heartbeat: update the clock-skew estimate. (LAN liveness is marked
        // at decrypt time above for EVERY LAN frame — heartbeats included —
        // so this branch no longer touches the watchdog state.)
        if let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
           let type = json["type"] as? String, type == "desktop_heartbeat" {
            let senderTs = json["ts"] as? Double ?? 0
            let buffered = json["buffered"] as? Int ?? 0
            // Compute one-way latency from the desktop's send timestamp.
            // Update the exponential moving average clock-skew estimate so
            // subsequent frame-latency logs are skew-corrected.
            // α = 0.25: smooth out jitter while converging in ~4 samples.
            let nowMs = Date().timeIntervalSince1970 * 1000
            if senderTs > 0 {
                let rawLatencyMs = nowMs - senderTs
                // Blend into the running estimate.  On first heartbeat the
                // estimate is 0; the first sample seeds it directly.
                let alpha = 0.25
                clockSkewEstimateMs = clockSkewEstimateMs == 0.0
                    ? rawLatencyMs
                    : clockSkewEstimateMs * (1.0 - alpha) + rawLatencyMs * alpha
            }
            if markFrame { markFrameProcessed(wire.seq) }
            // Log the heartbeat with latency fields so it is visible in
            // the diagnostic stream (no longer skipped — commit 9).
            DiagnosticLog.trace("heartbeat received",
                              tag: "transport.receive",
                              fields: ["event_type": "desktop_heartbeat",
                                       "seq": String(wire.seq),
                                       "raw_latency_ms": senderTs > 0 ? String(Int(nowMs - senderTs)) : "0",
                                       "skew_est_ms": String(Int(clockSkewEstimateMs)),
                                       "buffered": String(buffered)])
            eventContinuation.yield(.heartbeat(senderTs: senderTs, buffered: buffered))
            return
        }

        let event: RemoteEvent
        do {
            event = try JSONDecoder().decode(RemoteEvent.self, from: jsonData)
        } catch RemoteEventDecodeError.unknownType(let rawType) {
            // The desktop forwards every engine event to iOS; many engine event
            // types have no TypeKey case yet (e.g. desktop_compacting,
            // desktop_extension_died, desktop_schedule_registered). This is
            // expected — not data loss — so we skip at trace level with no
            // resync. The decoder distinguishes this error from a genuine
            // payload decode failure so these two categories are handled
            // separately.
            DiagnosticLog.trace("unknown event type skipped", tag: "transport.receive",
                                fields: ["type": rawType, "size": String(jsonData.count)])
            // An unknown-type event is a PROCESSED frame (expected skip, not
            // data loss) — advance the dedup mark so the gap logic doesn't
            // endlessly request resends of a frame we will always skip.
            if markFrame { markFrameProcessed(wire.seq) }
            return
        } catch {
            // True decode failure: the type string matched a known TypeKey but
            // the payload was malformed (missing required field, wrong type,
            // truncated frame). Log at error and request a full resync so the
            // state self-heals rather than stalling silently. DiagnosticLog
            // writes to the on-disk log file that gets sent to desktop via
            // requestDiagnosticLogs — without this, decode errors are invisible
            // in remote diagnostics.
            let typeHint = (try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any])?["type"] as? String ?? "unknown"
            let errDesc = String(describing: error).prefix(500)
            DiagnosticLog.log("event decode failed", tag: "transport.receive", level: .error, fields: [
                "type": typeHint,
                "size": String(jsonData.count),
                "error": String(errDesc)
            ])
            requestFullSyncAfterPayloadFailure()
            return
        }

        // Intercept gap-recovery control events before yielding to consumers.
        // desktop_resend_unavailable means the desktop could not replay the
        // requested range (evicted); drop the pending range so we stop expecting
        // those frames and let the snapshot reconcile heal the gap. The event is
        // still yielded so the ViewModel can log/observe it.
        if case .resendUnavailable(let fromSeq) = event {
            DiagnosticLog.log("resend unavailable; clearing pending range (snapshot reconcile will heal)", tag: "transport.receive", level: .warn, fields: [
                "fromSeq": String(fromSeq),
            ])
            pendingResendSeqs.removeAll()
            payloadChunkAssembler.reset()
            requestFullSyncAfterPayloadFailure()
        }

        // Record snapshot arrival for the retryable sync handshake
        // (TransportManager+Sync.swift): a snapshot proves the desktop
        // answered the sync, so the retry loop can stop.
        if case .snapshot = event {
            lastSnapshotReceivedAt = Date()
        }

        // The frame decoded successfully — it is now "processed"; advance the
        // dedup mark so duplicates of it are dropped but nothing before this
        // point can blackhole a frame the consumer never saw.
        if markFrame { markFrameProcessed(wire.seq) }

        // Per-frame receive latency log. Records the time from the desktop's
        // frame-build timestamp (wire.ts, epoch ms) to iOS receive time.
        // Skew-corrected using the rolling clockSkewEstimateMs from heartbeats.
        // Fields go in the fields map (additive — no wire rename).
        let receiveNowMs = Date().timeIntervalSince1970 * 1000
        let wireTs = wire.ts ?? 0.0
        let rawLatency = wireTs > 0 ? receiveNowMs - wireTs : 0.0
        let adjustedLatency = rawLatency - clockSkewEstimateMs
        DiagnosticLog.trace("frame received",
                          tag: "transport.receive",
                          fields: ["event_type": event.typeKey,
                                   "seq": String(wire.seq),
                                   "raw_latency_ms": String(Int(rawLatency)),
                                   "adj_latency_ms": String(Int(adjustedLatency)),
                                   "skew_est_ms": String(Int(clockSkewEstimateMs)),
                                   "payload_bytes": String(jsonData.count)])

        eventContinuation.yield(event)
    }

}
