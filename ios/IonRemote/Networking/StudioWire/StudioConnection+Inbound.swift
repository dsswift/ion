import Foundation

// What arrives on the socket: the handshake's answer, action results, and the
// frames passed through to the owner.
extension StudioConnection {

    func handle(_ event: StudioSocketEvent, generation: UInt64) {
        // A socket that was superseded keeps reporting until it is gone. Its
        // late close must never tear down the connection that replaced it.
        guard generation == self.generation else { return }
        switch event {
        case .opened:
            sendHello()
        case .text(let text):
            handleText(text)
        case .binary(let data):
            do {
                inboundContinuation.yield(.binary(try StudioBinaryFrame.decode(data)))
            } catch {
                DiagnosticLog.log("studio connection: malformed binary frame ignored", tag: "studio.conn", level: .warn, fields: [
                    "client_id": clientId, "error": error.localizedDescription
                ])
            }
        case .closed(let closure):
            guard running else { return }
            let status = closure.httpStatus.map { " (HTTP \($0))" } ?? ""
            handleFailure(reason: "connection closed: \(closure.reason)\(status)")
        }
    }

    func sendHello() {
        guard let credential else { return }
        DiagnosticLog.log("studio connection: sending hello", tag: "studio.conn", fields: [
            "client_id": clientId, "credential_kind": credential.kind, "view": "thin"
        ])
        // The hello goes out ahead of the queue that the welcome releases.
        transmit(.hello(.thinMobile(clientId: clientId, credential: credential)))
    }

    func handleText(_ text: String) {
        let frame: StudioFrame
        do {
            frame = try StudioFrame.decode(text: text)
        } catch {
            DiagnosticLog.log("studio connection: malformed frame ignored", tag: "studio.conn", level: .warn, fields: [
                "client_id": clientId, "error": error.localizedDescription
            ])
            return
        }
        switch frame {
        case .welcome(let welcome): handleWelcome(welcome)
        case .refused(let refused): handleRefused(refused)
        case .close(let close): handleClose(close)
        case .actionResult(let result): handleActionResult(result)
        case .event(let event): inboundContinuation.yield(.event(event))
        case .snapshot(let snapshot): inboundContinuation.yield(.snapshot(snapshot))
        case .body(let body): inboundContinuation.yield(.body(body))
        case .environmentPolicy(let policy): inboundContinuation.yield(.environmentPolicy(policy))
        case .ping(let ping):
            // Answered before anything else this frame could queue behind:
            // the round trip the server is timing includes whatever we make
            // it wait for. The `t` it carries is the SERVER's clock and is
            // never differenced against ours -- that skew is exactly what
            // this measure avoids needing to correct.
            send(.pong(StudioPing(nonce: ping.nonce, t: Date().timeIntervalSince1970 * 1000)))
        case .pong:
            DiagnosticLog.log("studio connection: pong is server-bound; ignoring", tag: "studio.conn", level: .warn, fields: [
                "client_id": clientId
            ])
        case .command(let command):
            // The hello advertises only `wire-ping`, which routes no command
            // here. Answer anyway so its caller does not wait out a timeout.
            DiagnosticLog.log("studio connection: reverse command declined, this client answers none", tag: "studio.conn", level: .warn, fields: [
                "client_id": clientId, "command": command.command, "command_id": command.id
            ])
            send(.commandResult(StudioCommandResult(id: command.id, ok: false, value: nil, error: "this client answers no reverse commands")))
        case .hello, .action, .commandResult, .reauth, .snapshotRequest, .bodyRequest:
            DiagnosticLog.log("studio connection: client-bound frame type ignored", tag: "studio.conn", level: .warn, fields: [
                "client_id": clientId, "frame_type": frame.wireType
            ])
        }
    }

    func handleWelcome(_ welcome: StudioWelcome) {
        welcomeDeadlineTask?.cancel()
        welcomeDeadlineTask = nil
        attempts = 0
        windowStart = nil
        welcomed = true
        lastWelcome = welcome
        let route = socket?.routeKind ?? .tcp
        DiagnosticLog.log("studio connection: welcomed", tag: "studio.conn", fields: [
            "client_id": clientId,
            "environment_id": welcome.environmentId,
            "route": route.rawValue,
            "scope_count": String(welcome.scopes.count),
            "relay_count": String(welcome.relays?.count ?? 0)
        ])
        // The welcome reaches the owner before anything the flush below provokes.
        inboundContinuation.yield(.welcome(welcome))
        setState(.connected(route: route, environmentId: welcome.environmentId))
        flushPending()
    }

    func handleRefused(_ refused: StudioRefused) {
        let reason = "refused: \(refused.reason.wire)\(refused.detail.map { " (\($0))" } ?? "")"
        guard !refused.reason.isRetryable else {
            DiagnosticLog.log("studio connection: hello refused, will retry", tag: "studio.conn", level: .warn, fields: [
                "client_id": clientId, "reason": refused.reason.wire, "detail": refused.detail ?? ""
            ])
            handleFailure(reason: reason)
            return
        }
        DiagnosticLog.log("studio connection: hello refused, not retrying", tag: "studio.conn", level: .error, fields: [
            "client_id": clientId,
            "reason": refused.reason.wire,
            "detail": refused.detail ?? "",
            "required_protocol_version": refused.requiredProtocolVersion.map(String.init) ?? "none"
        ])
        endWithoutRetry(.refused(refused), why: reason)
    }

    func handleClose(_ close: StudioClose) {
        let reason = "closed by server: \(close.reason.wire)\(close.detail.map { " (\($0))" } ?? "")"
        guard !close.reason.shouldReconnect else {
            DiagnosticLog.log("studio connection: closed by server, will reconnect", tag: "studio.conn", level: .warn, fields: [
                "client_id": clientId, "reason": close.reason.wire, "detail": close.detail ?? ""
            ])
            handleFailure(reason: reason)
            return
        }
        DiagnosticLog.log("studio connection: closed by server, not reconnecting", tag: "studio.conn", level: .warn, fields: [
            "client_id": clientId, "reason": close.reason.wire, "detail": close.detail ?? ""
        ])
        endWithoutRetry(.closedByServer(close), why: reason)
    }

    func handleActionResult(_ result: StudioActionResult) {
        guard let pending = pendingActions[result.id] else {
            DiagnosticLog.log("studio connection: action result with no waiter ignored", tag: "studio.conn", level: .debug, fields: [
                "client_id": clientId, "action_id": result.id
            ])
            return
        }
        if result.ok {
            resolveAction(id: result.id, with: .success(result.value ?? .null), why: "ok")
        } else if let refusal = result.refusal {
            resolveAction(id: result.id, with: .failure(StudioActionFailure.refused(code: refusal.code, message: refusal.message)), why: "refused")
        } else {
            let code = result.error?.code ?? "unknown"
            let message = result.error?.message ?? "studio_action '\(pending.action)' failed"
            resolveAction(id: result.id, with: .failure(StudioActionFailure.failed(code: code, message: message)), why: "failed")
        }
    }
}
