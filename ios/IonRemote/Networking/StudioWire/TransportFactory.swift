import Foundation

/// Assembles the Studio wire's pieces into a `StudioTransport`. The Studio
/// wire is the only wire this app runs on, so there is nothing here to pick
/// between.
enum TransportFactory {

    /// What a Studio transport needs from its owner.
    struct StudioInputs: Sendable {
        var record: StudioServerRecord
        var store: any StudioServerStoring = StudioServerKeychainStore()
        /// The id the rest of the app knows this pairing by (the diagnostic log stamp).
        var deviceId: String
        var mapping: any StudioCommandMapping = StudioTransportCommandMapping()
        /// A token for an OIDC relay. Nil when this pairing has no signed-in identity.
        var oidcToken: (@Sendable (StudioEnvironmentRelay) async throws -> String)?
        /// Whether to look for the server's address on the local network.
        var discoversAddress = true
        /// Where events on the admin channels go, keyed by this record's `clientId`.
        var adminEvents: ServerAdminEvents = .shared
    }

    /// Builds the route, the connection, and the transport for one paired
    /// server. The transport is not started.
    static func makeStudioTransport(_ inputs: StudioInputs) -> StudioTransport {
        let record = inputs.record
        var dependencies = StudioRoute.Dependencies()
        dependencies.oidcToken = inputs.oidcToken
        let route = StudioRoute(
            serverURL: record.serverURL, clientId: record.clientId, secret: record.key,
            relays: record.relays, directAddresses: (record.directAddresses ?? []).compactMap { URL(string: $0) },
            environmentId: record.environmentId, dependencies: dependencies
        )
        let connection = StudioConnection(clientId: record.clientId, dial: route.dial)
        let watcher = inputs.discoversAddress ? StudioAddressWatcher(record: record) : nil
        let store = inputs.store
        let clientId = record.clientId
        let adminEvents = inputs.adminEvents

        DiagnosticLog.log("transport factory: studio transport built", tag: "studio.transport", fields: [
            "client_id": clientId, "has_url": String(record.url != nil), "relay_count": String(record.relays.count),
            "has_oidc_source": String(inputs.oidcToken != nil), "discovers_address": String(watcher != nil)
        ])

        // The closures below hold the route: the connection's dial only refers to it weakly.
        return StudioTransport(
            deviceId: inputs.deviceId,
            serverId: clientId,
            connection: connection,
            mapping: inputs.mapping,
            onStart: { [weak connection] transport in
                await route.setOnDirectRouteReturned { [weak connection] in
                    await connection?.restart()
                }
                // A dial that found the server at a reported address keeps it,
                // so the next launch tries it first.
                await route.setOnServerURLAdopted { url in
                    StudioServerRecordUpdater.apply(url: url, clientId: clientId, store: store)
                }
                await watcher?.start { [weak transport] url in
                    await route.setServerURL(url)
                    StudioServerRecordUpdater.apply(url: url, clientId: clientId, store: store)
                    // On a relay, the route's own timer would find the address
                    // within its interval; dialing now gets there sooner. A
                    // direct connection that is already up is left alone.
                    guard let transport, transport.state != .lanPreferred else { return }
                    await transport.reconnect(reason: "server address discovered")
                }
            },
            onWelcome: { welcome in
                if let relays = welcome.relays { await route.updateRelays(relays) }
                await route.setEnvironmentId(welcome.environmentId)
                StudioServerRecordUpdater.apply(welcome: welcome, clientId: clientId, store: store)
                // The server says where it can be reached directly on every
                // connect, including this one when it arrived over a relay.
                // That is what lets a client paired over a relay, or one whose
                // stored address went stale, find its way back to the LAN
                // without anyone switching discovery on. The route probes them
                // with the stored address on every dial and on its relay timer,
                // and keeps whichever answers as this server.
                if let addresses = welcome.directAddresses {
                    await route.updateDirectAddresses(addresses.compactMap { URL(string: $0) })
                }
            },
            onStop: {
                await route.stop()
                await watcher?.stop()
            },
            onAdminEvent: { event in
                adminEvents.publish(ServerAdminEvent(serverId: clientId, channel: event.channel, payload: event.payload))
            }
        )
    }
}
