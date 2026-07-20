import Foundation

// MARK: - Inbound

extension TransportManager {

    // MARK: - Relay listener

    func startRelayListener() {
        guard let relay else { return }
        relayListenTask?.cancel()
        relayListenTask = Task { [weak self] in
            guard let relay = self?.relay else { return }
            for await data in relay.messages {
                guard !Task.isCancelled, let self else { break }
                self.enqueueIncomingData(data, isRelay: true)
            }
        }
    }

    func startRelayStateObservation() {
        guard let relay else { return }
        relayStateTask?.cancel()
        relayStateTask = Task { [weak self] in
            var wasConnected = false
            while !Task.isCancelled {
                guard let self else { break }
                let connected = relay.isConnected
                if connected != wasConnected {
                    wasConnected = connected
                    if connected {
                        // Relay just connected — sync so the desktop knows
                        // we're here and replies with a snapshot. Retryable
                        // (bounded backoff until a snapshot arrives): a
                        // single-shot sync whose send failed used to deadlock
                        // the handshake — the ViewModel-level sync defers
                        // while `.reconnecting`, but `.connected` requires a
                        // snapshot, which requires this sync. Detached so the
                        // 250ms poll loop isn't blocked by the backoff.
                        Task { [weak self] in
                            await self?.sendSyncWithRetry(reason: "relay-connected")
                        }
                    }
                    self.updateState()
                }
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
    }

    // MARK: - LAN listener

    func startLANListener() {
        lanListenTask?.cancel()
        lanListenTask = Task { [weak self] in
            guard let lan = self?.lan else { return }
            DiagnosticLog.log("lan listener starting", tag: "transport.receive", fields: [
                "connected": String(lan.isConnected)
            ])
            for await data in lan.messages {
                guard !Task.isCancelled, let self else { break }
                self.enqueueIncomingData(data, isRelay: false)
            }
            // LAN stream ended naturally -- emit peerDisconnected if no relay fallback.
            // Skip if cancelled (transport.stop() was called): yielding peerDisconnected
            // here would call disconnect() and clobber a new connection being set up.
            DiagnosticLog.log("lan listener stream ended", tag: "transport.receive", fields: [
                "cancelled": String(Task.isCancelled)
            ])
            guard !Task.isCancelled else { return }
            guard let self else { return }
            // If the LAN client already reconnected (Bonjour observation called
            // startLANWithAuth which creates a new stream), don't emit
            // peerDisconnected — the new connection is alive and a new listener
            // task was started by that reconnection.
            if self.lan.isConnected { return }
            if self.relay == nil || !(self.relay?.isConnected ?? false) {
                self.eventContinuation.yield(.peerDisconnected)
            }
            self.updateState()
        }
    }

    func startLANStateObservation() {
        lanStateTask?.cancel()
        lanStateTask = Task { [weak self] in
            var wasConnected = false
            while !Task.isCancelled {
                guard let self else { break }
                let connected = self.lan.isConnected
                if connected != wasConnected {
                    DiagnosticLog.log("lan connection state changed", tag: "transport.receive", fields: [
                        "old": String(wasConnected),
                        "new": String(connected)
                    ])
                    wasConnected = connected
                    if !connected {
                        self.updateState()
                    }
                }
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
    }

    // MARK: - Wire message dispatch

    /// Single-consumer ingress for inbound frames. Both listener tasks (relay
    /// and LAN) call this instead of `handleIncomingData` directly: the raw
    /// data (+ origin) is enqueued onto the strict-FIFO `inboundQueue`, whose
    /// consumer runs `handleIncomingData` one frame at a time. This serializes
    /// every mutation of the receive-side state (`lastReceivedSeq`,
    /// `pendingResendSeqs`, `lastReceivedEpoch`, clock-skew/heartbeat fields)
    /// that the two listener tasks previously raced on. No decode happens on
    /// the listener task — it only hands the bytes off. Per-transport ordering
    /// is preserved because each listener enqueues in its receive order and
    /// the queue is FIFO.
    func enqueueIncomingData(_ data: Data, isRelay: Bool) {
        _ = inboundQueue.submit { [weak self] in
            guard let self else { return }
            self.handleIncomingData(data, isRelay: isRelay)
        }
    }

    /// Decode, dedup, decrypt, and apply one inbound frame.
    ///
    /// SERIALIZATION CONTRACT: this method mutates unsynchronized receive-side
    /// state and must only run on the `inboundQueue` (via
    /// `enqueueIncomingData`) — never concurrently from two tasks. Tests may
    /// call it directly because a single-threaded test context satisfies the
    /// same "one frame at a time" contract.
    func handleIncomingData(_ data: Data, isRelay: Bool) {
        // Check for relay control frames FIRST — they're bare JSON without a
        // WireMessage envelope (no seq field), so WireMessage decode would fail.
        if isRelay,
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let type = json["type"] as? String, type.hasPrefix("relay:") {
            if type == "relay:peer-disconnected" {
                DiagnosticLog.log("RELAY-CTRL: peer-disconnected")
                // The relay told us the desktop disconnected. Start grace
                // period with force=true because the relay WebSocket itself
                // is still connected — the *peer* is gone.
                startDisconnectGracePeriod(force: true)
            } else if type == "relay:peer-reconnected" {
                DiagnosticLog.log("RELAY-CTRL: peer-reconnected")
                cancelDisconnectGracePeriod()
                // No dedup reset here. The desktop's outbound seq is continuous
                // across relay reconnects of the SAME process; zeroing
                // lastReceivedSeq let late frames from the dying socket
                // re-apply as fresh. If the desktop actually restarted, its
                // frames carry a NEWER epoch and the epoch check below resets
                // the dedup — the epoch is the only reset trigger.
                updateState()
            } else if type == "relay:push-failed" {
                let reason = json["reason"] as? String ?? "unknown"
                let resourceId = json["resourceId"] as? String ?? ""
                DiagnosticLog.log("relay push failed", tag: "transport.receive", level: .warn, fields: [
                    "reason": reason,
                    "resource_id": resourceId
                ])
            }
            return
        }

        guard let wire = try? JSONDecoder().decode(WireMessage.self, from: data) else {
            return
        }

        // Plaintext auth_result on the DATA path is ignored (Hygiene: DoS
        // surface). A TransportManager always holds a shared secret (both
        // inits require `sharedKey`), and once a secret exists the desktop
        // never sends plaintext data frames — it rejects inbound plaintext
        // for the same reason (desktop transport-inbound-payload.ts:
        // "Shared secret is set but message is plaintext -- reject it").
        // Honoring an unencrypted `auth_result success=false` here let ANY
        // LAN peer inject one WireMessage-wrapped plaintext frame and force
        // `peerDisconnected`, tearing down a healthy session. The legitimate
        // auth-phase path is untouched: `performLANAuthCore` consumes
        // `lan.messages` during the handshake BEFORE `startLANListener`
        // exists, so pre-secret auth verdicts never flow through here. A
        // genuine late revocation arrives as an application close code
        // (4000–4999) on the socket, not as a plaintext data frame.
        if let payloadStr = wire.payload,
           let json = try? JSONSerialization.jsonObject(with: Data(payloadStr.utf8)) as? [String: Any],
           let type = json["type"] as? String, type == "auth_result" {
            DiagnosticLog.log("ignoring plaintext auth_result on data path", tag: "transport.receive", level: .warn, fields: [
                "origin": isRelay ? "relay" : "lan",
                "success": String(json["success"] as? Bool ?? false),
                "seq": String(wire.seq)
            ])
            return
        }

        // Outbound-seq epoch check — BEFORE the seq dedup. Epochs are
        // time-seeded ms and monotonic per desktop process generation, so the
        // compare is ordered, not equality:
        //  - NEWER epoch: the desktop's outbound seq space restarted (process
        //    restart, or an in-process stop()+recreate) — its seqs are back at
        //    1 and its retransmit buffer is empty. Reset the dedup state so
        //    the fresh seq=1..N stream is accepted instead of being dropped as
        //    "already seen" (which would blackhole every post-restart frame
        //    until the snapshot reconcile), then adopt the epoch.
        //  - OLDER epoch: a late frame from a dead desktop generation (old
        //    socket draining during a restart). DROP it entirely — do not
        //    adopt, do not process. Adopting on any difference (the old `!=`
        //    logic) let alternating old/new frames flap the tracker and reset
        //    the dedup repeatedly, re-poisoning the mark each time.
        //  - EQUAL epoch: normal path, plain seq dedup below.
        // First epoch-bearing frame seeds the tracker without a reset; a
        // desktop predating the field (epoch nil) skips the logic entirely.
        if let incomingEpoch = wire.epoch {
            if let known = lastReceivedEpoch {
                if incomingEpoch > known {
                    DiagnosticLog.log("wire epoch advanced, resetting dedup", tag: "transport.receive", fields: [
                        "old_epoch": String(Int64(known)),
                        "new_epoch": String(Int64(incomingEpoch))
                    ])
                    lastReceivedSeq = 0
                    pendingResendSeqs.removeAll()
                    lastReceivedEpoch = incomingEpoch
                } else if incomingEpoch < known {
                    DiagnosticLog.trace("dropping frame from stale desktop epoch", tag: "transport.receive", fields: [
                        "stale_epoch": String(Int64(incomingEpoch)),
                        "known_epoch": String(Int64(known)),
                        "seq": String(wire.seq)
                    ])
                    return
                }
            } else {
                // First-ever epoch: adopt without a reset.
                lastReceivedEpoch = incomingEpoch
            }
        }

        // Dedup vs. gap-recovery. A frame at/below lastReceivedSeq is normally a
        // duplicate and dropped — EXCEPT a replayed frame filling a gap we asked
        // the desktop to resend: its original (lower) seq is in pendingResendSeqs,
        // so we accept it and mark that seq filled. Frames not in the pending set
        // keep the normal dedup.
        //
        // This seq dedup is also what makes cross-transport delivery safe: the
        // desktop delivers each frame via exactly ONE transport (LAN or relay),
        // so a relay frame arriving while state is `.lanPreferred` is real data
        // (typically because the desktop's side of the LAN socket died and it
        // fell back to relay) and must be applied. iOS previously dropped ALL
        // relay data frames in `.lanPreferred` — and worse, advanced
        // lastReceivedSeq before the drop, permanently blackholing snapshots,
        // deltas, resend replays, and heartbeats behind a half-open LAN socket.
        if wire.seq > 0, wire.seq <= lastReceivedSeq {
            if pendingResendSeqs.contains(wire.seq) {
                pendingResendSeqs.remove(wire.seq)
                let stillMissing = pendingResendSeqs.count
                DiagnosticLog.log("wire resend frame applied", tag: "transport.receive", fields: [
                    "seq": String(wire.seq),
                    "still_missing": String(stillMissing)
                ])
                // fall through to decrypt/apply this replayed frame
            } else {
                return // genuine duplicate
            }
        } else if wire.seq > 0 {
            // Forward frame. Detect a gap and request resend of the missing range
            // so the live stream self-heals at the wire (the snapshot reconcile is
            // the slower backstop for ranges the desktop can no longer replay).
            if lastReceivedSeq > 0, wire.seq > lastReceivedSeq + 1 {
                let expected = lastReceivedSeq + 1
                let got = wire.seq
                DiagnosticLog.log("wire seq forward gap; requesting resend", tag: "transport.receive", level: .warn, fields: [
                    "expected": String(expected), "got": String(got), "lost": String(got - expected),
                ])
                requestResendForGap(fromSeq: expected, toSeq: got - 1)
            }
            // NOTE: lastReceivedSeq is NOT advanced here. It advances via
            // markFrameProcessed() only after the frame decrypts and decodes.
            // A frame that is dropped later in this function (decrypt failure,
            // malformed payload) must not advance the dedup mark past content
            // that was never applied — the gap logic above then self-heals it
            // on the next frame instead of losing it permanently.
        }

        // Decrypt -- encryption is required for data messages.
        guard let ciphertextB64 = wire.ciphertext, let nonceB64 = wire.nonce,
              let ciphertext = Data(base64Encoded: ciphertextB64),
              let nonce = Data(base64Encoded: nonceB64) else {
            DiagnosticLog.log("wire message missing ciphertext/nonce fields; frame dropped", tag: "transport.receive", level: .warn, fields: [
                "seq": String(wire.seq),
            ])
            return
        }

        guard let payloadData = try? E2ECrypto.decrypt(ciphertext: ciphertext, nonce: nonce, key: sharedKey) else {
            DiagnosticLog.log("decrypt failed; frame dropped (possible key mismatch)", tag: "transport.receive", level: .warn, fields: [
                "seq": String(wire.seq),
            ])
            return
        }

        // LAN liveness: ANY successfully decrypted LAN-delivered frame proves
        // the LAN socket is alive — decryption authenticates the desktop, so a
        // forged frame cannot spoof liveness. Marking here (not only on
        // heartbeats) is what lets the 3s post-resume probe and the 30s
        // starvation watchdog judge the socket by real traffic: the resume
        // sync's snapshot response, a delta, or a resend replay all count.
        // Previously only `desktop_heartbeat` advanced the mark, so a healthy
        // socket whose 15s heartbeat cadence didn't happen to land inside the
        // probe window was torn down as a zombie (the create-tab "not
        // connected" flap). Relay-delivered frames never update this: they
        // prove the relay works, NOT the LAN socket — counting them would mask
        // a wedged LAN forever (the half-open-socket failure the watchdog
        // exists to detect).
        if !isRelay {
            lastLANFrameAt = Date()
            // Backstop arm: setState arms the watchdog when LAN becomes the
            // active transport; this covers any path that reaches
            // `.lanPreferred` traffic with the watchdog disarmed.
            if state == .lanPreferred {
                startLANHeartbeatWatchdog()
            }
        }

        // Decompress if the payload has the 0x01 version prefix (raw DEFLATE).
        // The desktop compresses with zlib.deflateRawSync() and prepends 0x01.
        // Uncompressed (legacy) payloads start with '{' (0x7B) and pass through.
        let jsonData: Data
        if payloadData.first == 0x01 {
            do {
                jsonData = try PayloadCompression.inflateRaw(payloadData.dropFirst())
            } catch {
                DiagnosticLog.log("decompression failed; frame dropped", tag: "transport.receive", level: .error, fields: [
                    "seq": String(wire.seq), "error": String(describing: error),
                ])
                return
            }
        } else {
            jsonData = payloadData
        }

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
            markFrameProcessed(wire.seq)
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
            markFrameProcessed(wire.seq)
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
            // Defense-in-depth: request a full resync so a malformed/truncated
            // frame self-heals rather than leaving iOS in stale state.
            Task { [weak self] in
                do {
                    try await self?.send(.sync)
                } catch {
                    DiagnosticLog.log("self-heal resync send failed", tag: "transport.receive", level: .warn, fields: [
                        "error": String(describing: error),
                    ])
                }
            }
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
        markFrameProcessed(wire.seq)

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

    /// Advance the dedup mark for a frame that was actually applied (decrypted
    /// and decoded, or recognized as an expected skip). Never moves backwards:
    /// a replayed gap-fill frame carries a seq below the mark and must not
    /// lower it.
    func markFrameProcessed(_ seq: UInt64) {
        if seq > lastReceivedSeq {
            lastReceivedSeq = seq
        }
    }

    /// Record the missing seq range and request a resend from the desktop,
    /// coalescing a burst of gaps within a short window into one request. Caps
    /// the tracked range so a huge gap (e.g. a long offline period) does not
    /// balloon the pending set — beyond the cap we rely on the snapshot reconcile.
    ///
    /// Debounce shape: leading edge sends immediately; a gap arriving INSIDE
    /// the window schedules exactly one trailing task (if none is pending)
    /// that sleeps out the remainder of the window and then sends ONE merged
    /// request covering `pendingResendSeqs.min()...max()`. The old
    /// leading-edge-only debounce silently dropped in-window gaps: their seqs
    /// sat in `pendingResendSeqs` with no request ever sent, unhealed until
    /// the snapshot reconcile. The trailing task re-enters the inbound serial
    /// queue so its `pendingResendSeqs` access is serialized with frame
    /// processing (WI-7 contract).
    ///
    /// Runs on the inboundQueue (called from `handleIncomingData`).
    func requestResendForGap(fromSeq: UInt64, toSeq: UInt64) {
        guard toSeq >= fromSeq else { return }
        // Cap the range we track/ask for; a very large gap is better healed by
        // the snapshot reconcile than by replaying thousands of frames.
        let maxRange: UInt64 = 256
        let cappedTo = min(toSeq, fromSeq &+ maxRange &- 1)
        for s in fromSeq...cappedTo { pendingResendSeqs.insert(s) }

        // Debounce: coalesce bursts into one request.
        let now = Date()
        let sinceLast = now.timeIntervalSince(lastResendRequestAt)
        guard sinceLast >= resendDebounceInterval else {
            // Inside the window. Schedule ONE trailing coalesced request if
            // none is already pending; a pending one will pick this gap's
            // seqs up from pendingResendSeqs when it fires.
            scheduleTrailingResend(afterDelay: resendDebounceInterval - sinceLast)
            return
        }
        lastResendRequestAt = now
        lastResendRequestedRange = fromSeq...cappedTo

        DiagnosticLog.log("requesting resend", tag: "transport.receive", fields: [
            "from_seq": String(fromSeq),
            "to_seq": String(cappedTo)
        ])
        Task { [weak self] in
            do {
                try await self?.send(.requestResend(fromSeq: fromSeq, toSeq: cappedTo))
            } catch {
                DiagnosticLog.log("resend request send failed; frames stay missing", tag: "transport.receive", level: .warn, fields: [
                    "fromSeq": String(fromSeq), "toSeq": String(cappedTo), "error": String(describing: error),
                ])
            }
        }
    }

    /// Schedule the trailing coalesced resend request. At most one is pending
    /// at a time. Sleeps out the remaining debounce window on a detached task,
    /// then re-enters the inbound serial queue (so `pendingResendSeqs` is read
    /// under the same serialization as frame processing) and sends one merged
    /// request covering the full still-missing span.
    private func scheduleTrailingResend(afterDelay delay: TimeInterval) {
        guard resendCoalesceTask == nil else { return }
        resendCoalesceTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled else { return }
            _ = self.inboundQueue.submit { [weak self] in
                guard let self else { return }
                self.resendCoalesceTask = nil
                self.sendCoalescedResendRequest()
            }
        }
    }

    /// Send one merged resend request for everything still missing. Runs on
    /// the inboundQueue only.
    private func sendCoalescedResendRequest() {
        // Frames replayed (or a resendUnavailable) during the wait may have
        // drained the set — nothing left to ask for.
        guard let mergedFrom = pendingResendSeqs.min(),
              let mergedTo = pendingResendSeqs.max() else { return }
        lastResendRequestAt = Date()
        lastResendRequestedRange = mergedFrom...mergedTo
        DiagnosticLog.log("coalesced resend request", tag: "transport.receive", fields: [
            "from_seq": String(mergedFrom),
            "to_seq": String(mergedTo),
            "pending_count": String(pendingResendSeqs.count)
        ])
        Task { [weak self] in
            do {
                try await self?.send(.requestResend(fromSeq: mergedFrom, toSeq: mergedTo))
            } catch {
                DiagnosticLog.log("coalesced resend request send failed", tag: "transport.receive", level: .warn, fields: [
                    "from_seq": String(mergedFrom), "to_seq": String(mergedTo), "error": String(describing: error),
                ])
            }
        }
    }
}
