import Foundation

/// Lightweight HTTP poller that checks whether the "ion" role is connected
/// on a relay channel. Used by the desktop picker to show online/offline
/// status for non-active paired devices without opening a WebSocket.
enum PeerStatusPoller {

    /// Check whether the desktop ("ion" role) is connected on a channel.
    /// Returns `true` if connected, `false` if not, `nil` on error.
    static func checkDesktopOnline(
        relayURL: String,
        apiKey: String,
        channelId: String
    ) async -> Bool? {
        guard !relayURL.isEmpty,
              let base = URL(string: relayURL) else {
            DiagnosticLog.log("peer status poll: invalid or empty relay URL", tag: "transport.peerstatus", level: .warn, fields: [
                "channel_id": channelId,
            ])
            return nil
        }

        // Build the status URL: {relayURL}/v1/channel/{channelId}/status
        var components = URLComponents()
        switch base.scheme {
        case "wss": components.scheme = "https"
        case "ws":  components.scheme = "http"
        default:    components.scheme = base.scheme
        }
        components.host = base.host(percentEncoded: false)
        components.port = base.port
        let basePath = base.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = basePath.isEmpty
            ? "/v1/channel/\(channelId)/status"
            : "/\(basePath)/v1/channel/\(channelId)/status"

        guard let url = components.url else {
            DiagnosticLog.log("peer status poll: could not build status URL", tag: "transport.peerstatus", level: .warn, fields: [
                "channel_id": channelId,
            ])
            return nil
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 5

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                DiagnosticLog.log("peer status poll: non-200 response", tag: "transport.peerstatus", level: .warn, fields: [
                    "channel_id": channelId, "status": String(status),
                ])
                return nil
            }
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Bool] else {
                DiagnosticLog.log("peer status poll: JSON decode failed", tag: "transport.peerstatus", level: .warn, fields: [
                    "channel_id": channelId,
                ])
                return nil
            }
            return json["ion"] ?? false
        } catch {
            DiagnosticLog.log("peer status poll: request failed", tag: "transport.peerstatus", level: .warn, fields: [
                "channel_id": channelId, "error": String(describing: error),
            ])
            return nil
        }
    }
}
