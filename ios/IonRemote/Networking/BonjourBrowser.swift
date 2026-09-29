import Foundation
import Network
import Observation

// MARK: - DiscoveredService

/// An Ion Studio Server discovered on the local network via Bonjour. There is
/// only one kind: the `_ion._tcp` and `_ion-relay._tcp` browses went with the
/// `desktop_*` wire.
struct DiscoveredService: Identifiable, Hashable {
    let id: String
    let name: String
    let host: String
    let port: UInt16
    /// Key-value pairs from the Bonjour TXT record: the server's `label`, its
    /// environment `id`, and its `machine` id. `StudioServerDiscovery` matches a
    /// paired server by these, never by hostname.
    let metadata: [String: String]

    /// The server's base URL (`http://host:port`), where it answers
    /// `/auth/pair` and `/auth/config`.
    var studioServerURL: URL? { StudioServerDiscovery.serverURL(for: self) }

    /// The server's label, when it announced one. Its Bonjour instance name is
    /// decorated ("Ion Studio (grover)"); the TXT record carries the plain one.
    var displayName: String { metadata["label"].flatMap { $0.isEmpty ? nil : $0 } ?? name }

    init(id: String, name: String, host: String, port: UInt16, metadata: [String: String] = [:]) {
        self.id = id
        self.name = name
        self.host = host
        self.port = port
        self.metadata = metadata
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }

    static func == (lhs: DiscoveredService, rhs: DiscoveredService) -> Bool {
        lhs.id == rhs.id
    }
}

typealias DiscoveredHost = DiscoveredService

// MARK: - BonjourBrowser

/// Discovers Ion Studio Servers on the local network, by browsing for
/// `_ion-studio._tcp`.
@Observable
final class BonjourBrowser {

    // MARK: - Public state

    private(set) var discoveredHosts: [DiscoveredService] = []

    // MARK: - Internals

    private var studioBrowser: NWBrowser?
    private var connections: [String: NWConnection] = [:]

    // MARK: - Public API

    func startBrowsing() {
        stopBrowsing()
        DiagnosticLog.log("bonjour: browse starting", tag: "bonjour", level: .info, fields: [
            "type": "_ion-studio._tcp"
        ])
        startBrowser(type: "_ion-studio._tcp")
    }

    func stopBrowsing() {
        if studioBrowser != nil {
            DiagnosticLog.log("bonjour: browse stopping", tag: "bonjour", level: .info, fields: [
                "known_hosts": String(discoveredHosts.count)
            ])
        }
        studioBrowser?.cancel()
        studioBrowser = nil

        for (_, connection) in connections {
            connection.cancel()
        }
        connections.removeAll()
        discoveredHosts.removeAll()
    }

    // MARK: - Browser setup

    /// The browse descriptor for `type`. It must be the TXT-carrying variant:
    /// a plain `.bonjour` browse reports each service with no metadata, so a
    /// paired server could never be told apart from any other announcement.
    static func descriptor(for type: String) -> NWBrowser.Descriptor {
        .bonjourWithTXTRecord(type: type, domain: nil)
    }

    private func startBrowser(type: String) {
        let descriptor = Self.descriptor(for: type)
        let parameters = NWParameters()
        parameters.includePeerToPeer = true

        let browser = NWBrowser(for: descriptor, using: parameters)

        studioBrowser = browser

        // Every state is logged. `.waiting` is the one that matters most: on
        // iOS a browse with no Local Network permission never fails and never
        // returns a result, it simply waits — which is indistinguishable from
        // an empty network unless this says so.
        browser.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                DiagnosticLog.log("bonjour: browser ready", tag: "bonjour", level: .info, fields: ["type": type])
            case .waiting(let error):
                DiagnosticLog.log("bonjour: browser waiting; local network permission is the usual cause", tag: "bonjour", level: .warn, fields: [
                    "type": type, "error": String(describing: error)
                ])
            case .cancelled:
                DiagnosticLog.log("bonjour: browser cancelled", tag: "bonjour", level: .info, fields: ["type": type])
            case .failed(let error):
                DiagnosticLog.log("bonjour: browser failed, restarting in 2s", tag: "bonjour", level: .error, fields: [
                    "type": type, "error": String(describing: error)
                ])
                browser.cancel()
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                    self?.startBrowser(type: type)
                }
            default:
                DiagnosticLog.log("bonjour: browser state", tag: "bonjour", level: .debug, fields: [
                    "type": type, "status": String(describing: state)
                ])
            }
        }

        browser.browseResultsChangedHandler = { [weak self] results, changes in
            DiagnosticLog.log("bonjour: results changed", tag: "bonjour", level: .info, fields: [
                "type": type, "count": String(results.count), "changes": String(changes.count)
            ])
            self?.handleResultsChanged(results, changes: changes)
        }

        browser.start(queue: .main)
    }

    // MARK: - Result handling

    private func handleResultsChanged(
        _ results: Set<NWBrowser.Result>,
        changes: Set<NWBrowser.Result.Change>
    ) {
        // Process removals first.
        for change in changes {
            if case .removed(let result) = change {
                let endpointID = result.endpoint.debugDescription
                DiagnosticLog.log("bonjour: service removed", tag: "bonjour", level: .info, fields: [
                    "name": extractInstanceName(from: result)
                ])
                discoveredHosts.removeAll { $0.id == endpointID }
                connections[endpointID]?.cancel()
                connections.removeValue(forKey: endpointID)
            }
        }

        // Process additions.
        for change in changes {
            let result: NWBrowser.Result
            switch change {
            case .added(let r): result = r
            case .changed(old: _, new: let r, flags: _): result = r
            default: continue
            }

            let endpointID = result.endpoint.debugDescription
            if discoveredHosts.contains(where: { $0.id == endpointID }) {
                DiagnosticLog.log("bonjour: service already known, not re-resolving", tag: "bonjour", level: .debug, fields: [
                    "name": extractInstanceName(from: result)
                ])
                continue
            }

            let instanceName = extractInstanceName(from: result)
            let metadata = extractMetadata(from: result)
            // The identity a paired client matches on travels in the TXT
            // record, so it is logged with the name: a service that is seen
            // but never matched is a different failure from one never seen.
            DiagnosticLog.log("bonjour: service found, resolving", tag: "bonjour", level: .info, fields: [
                "name": instanceName,
                "machine": metadata["machine"] ?? "-",
                "environment_id": metadata["id"] ?? "-",
                "label": metadata["label"] ?? "-"
            ])
            resolveEndpoint(result.endpoint, id: endpointID, instanceName: instanceName, metadata: metadata)
        }
    }

    private func extractInstanceName(from result: NWBrowser.Result) -> String {
        if case .service(let name, _, _, _) = result.endpoint {
            return name
        }
        return "Unknown"
    }

    private func extractMetadata(from result: NWBrowser.Result) -> [String: String] {
        guard case .bonjour(let txtRecord) = result.metadata else { return [:] }
        var dict: [String: String] = [:]
        for (key, value) in txtRecord.dictionary {
            dict[key] = value
        }
        return dict
    }

    private func resolveEndpoint(_ endpoint: NWEndpoint, id: String, instanceName: String, metadata: [String: String]) {
        resolveEndpointWithIPv4(endpoint, id: id, instanceName: instanceName, metadata: metadata)
    }

    /// Try resolving with IPv4 preference first. URLSession can't handle IPv6
    /// link-local zone IDs in URLs, so IPv4 is more reliable for LAN WebSockets.
    /// Falls back to any-IP resolution if IPv4 fails.
    private func resolveEndpointWithIPv4(_ endpoint: NWEndpoint, id: String, instanceName: String, metadata: [String: String]) {
        let params = NWParameters.tcp
        if let ip = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
            ip.version = .v4
        }
        let connection = NWConnection(to: endpoint, using: params)
        connections[id] = connection

        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }

            switch state {
            case .ready:
                guard let innerEndpoint = connection.currentPath?.remoteEndpoint else {
                    DiagnosticLog.log("bonjour: resolved but the path carried no endpoint", tag: "bonjour", level: .warn, fields: [
                        "name": instanceName, "path": "ipv4"
                    ])
                    connection.cancel()
                    self.connections.removeValue(forKey: id)
                    return
                }

                if let resolved = self.extractHostPort(from: innerEndpoint, id: id, instanceName: instanceName, metadata: metadata) {
                    if !self.discoveredHosts.contains(where: { $0.id == id }) {
                        self.discoveredHosts.append(resolved)
                        DiagnosticLog.log("bonjour: service resolved to an address", tag: "bonjour", level: .info, fields: [
                            "name": instanceName, "host": resolved.host, "port": String(resolved.port), "path": "ipv4"
                        ])
                    }
                } else {
                    DiagnosticLog.log("bonjour: endpoint was not a host/port, dropped", tag: "bonjour", level: .warn, fields: [
                        "name": instanceName, "path": "ipv4"
                    ])
                }

                connection.cancel()
                self.connections.removeValue(forKey: id)

            case .failed(let error):
                // IPv4 resolution failed -- fall back to any IP version.
                DiagnosticLog.log("bonjour: ipv4 resolve failed, retrying without a version preference", tag: "bonjour", level: .info, fields: [
                    "name": instanceName, "error": String(describing: error)
                ])
                connection.cancel()
                self.connections.removeValue(forKey: id)
                self.resolveEndpointAnyIP(endpoint, id: id, instanceName: instanceName, metadata: metadata)

            case .cancelled:
                self.connections.removeValue(forKey: id)

            default:
                break
            }
        }

        connection.start(queue: .main)
    }

    /// Fallback: resolve without IP version constraint.
    private func resolveEndpointAnyIP(_ endpoint: NWEndpoint, id: String, instanceName: String, metadata: [String: String]) {
        let connection = NWConnection(to: endpoint, using: .tcp)
        connections[id] = connection

        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }

            switch state {
            case .ready:
                guard let innerEndpoint = connection.currentPath?.remoteEndpoint else {
                    DiagnosticLog.log("bonjour: resolved but the path carried no endpoint", tag: "bonjour", level: .warn, fields: [
                        "name": instanceName, "path": "any"
                    ])
                    connection.cancel()
                    self.connections.removeValue(forKey: id)
                    return
                }

                if let resolved = self.extractHostPort(from: innerEndpoint, id: id, instanceName: instanceName, metadata: metadata) {
                    if !self.discoveredHosts.contains(where: { $0.id == id }) {
                        self.discoveredHosts.append(resolved)
                        DiagnosticLog.log("bonjour: service resolved to an address", tag: "bonjour", level: .info, fields: [
                            "name": instanceName, "host": resolved.host, "port": String(resolved.port), "path": "any"
                        ])
                    }
                } else {
                    DiagnosticLog.log("bonjour: endpoint was not a host/port, dropped", tag: "bonjour", level: .warn, fields: [
                        "name": instanceName, "path": "any"
                    ])
                }

                connection.cancel()
                self.connections.removeValue(forKey: id)

            case .failed(let error):
                DiagnosticLog.log("bonjour: resolve failed on both ipv4 and any; this service stays undiscovered", tag: "bonjour", level: .warn, fields: [
                    "name": instanceName, "error": String(describing: error)
                ])
                self.connections.removeValue(forKey: id)

            case .cancelled:
                self.connections.removeValue(forKey: id)

            default:
                break
            }
        }

        connection.start(queue: .main)
    }

    private func extractHostPort(
        from endpoint: NWEndpoint,
        id: String,
        instanceName: String,
        metadata: [String: String]
    ) -> DiscoveredService? {
        switch endpoint {
        case .hostPort(let host, let port):
            let hostString: String
            switch host {
            case .ipv4(let addr):
                // Strip any interface suffix (e.g., "192.168.1.1%en0" -> "192.168.1.1")
                let raw = "\(addr)"
                hostString = raw.components(separatedBy: "%").first ?? raw
            case .ipv6(let addr):
                // Bracket for URL compatibility. Preserve zone ID for link-local
                // addresses (fe80::) -- without it, the OS can't route the packet.
                // URL-encode the % as %25 per RFC 6874.
                let raw = "\(addr)"
                let encoded = raw.replacingOccurrences(of: "%", with: "%25")
                hostString = "[\(encoded)]"
            case .name(let name, _):
                hostString = name
            @unknown default:
                hostString = "\(host)"
            }

            return DiscoveredService(
                id: id,
                name: instanceName,
                host: hostString,
                port: port.rawValue,
                metadata: metadata
            )

        default:
            return nil
        }
    }
}
