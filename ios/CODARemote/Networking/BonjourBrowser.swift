import Foundation
import Network
import Observation

// MARK: - DiscoveredService

/// A service discovered on the local network via Bonjour.
enum ServiceKind: String {
    /// A relay server (_coda-relay._tcp). Requires API key.
    case relay
    /// A CODA desktop instance (_coda._tcp). Requires pairing code.
    case codaDirect
}

struct DiscoveredService: Identifiable, Hashable {
    let id: String
    let kind: ServiceKind
    let name: String
    let host: String
    let port: UInt16

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }

    static func == (lhs: DiscoveredService, rhs: DiscoveredService) -> Bool {
        lhs.id == rhs.id
    }
}

// Keep backward compat aliases.
typealias DiscoveredRelay = DiscoveredService
typealias DiscoveredHost = DiscoveredService

// MARK: - BonjourBrowser

/// Discovers CODA relay servers and CODA desktop instances on the local network.
///
/// Browses for both `_coda-relay._tcp` (relay servers) and `_coda._tcp`
/// (CODA desktop LAN server).
@Observable
final class BonjourBrowser {

    // MARK: - Public state

    private(set) var discoveredHosts: [DiscoveredService] = []

    // MARK: - Internals

    private var relayBrowser: NWBrowser?
    private var codaBrowser: NWBrowser?
    private var connections: [String: NWConnection] = [:]

    // MARK: - Public API

    func startBrowsing() {
        stopBrowsing()
        startBrowser(type: "_coda-relay._tcp", kind: .relay)
        startBrowser(type: "_coda._tcp", kind: .codaDirect)
    }

    func stopBrowsing() {
        relayBrowser?.cancel()
        relayBrowser = nil
        codaBrowser?.cancel()
        codaBrowser = nil

        for (_, connection) in connections {
            connection.cancel()
        }
        connections.removeAll()
        discoveredHosts.removeAll()
    }

    // MARK: - Browser setup

    private func startBrowser(type: String, kind: ServiceKind) {
        let descriptor = NWBrowser.Descriptor.bonjour(type: type, domain: nil)
        let parameters = NWParameters()
        parameters.includePeerToPeer = true

        let browser = NWBrowser(for: descriptor, using: parameters)

        switch kind {
        case .relay: relayBrowser = browser
        case .codaDirect: codaBrowser = browser
        }

        browser.stateUpdateHandler = { [weak self] state in
            if case .failed = state {
                browser.cancel()
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                    self?.startBrowser(type: type, kind: kind)
                }
            }
        }

        browser.browseResultsChangedHandler = { [weak self] results, changes in
            self?.handleResultsChanged(results, changes: changes, kind: kind)
        }

        browser.start(queue: .main)
    }

    // MARK: - Result handling

    private func handleResultsChanged(
        _ results: Set<NWBrowser.Result>,
        changes: Set<NWBrowser.Result.Change>,
        kind: ServiceKind
    ) {
        // Process removals first.
        for change in changes {
            if case .removed(let result) = change {
                let endpointID = "\(kind.rawValue):\(result.endpoint.debugDescription)"
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

            let endpointID = "\(kind.rawValue):\(result.endpoint.debugDescription)"
            if discoveredHosts.contains(where: { $0.id == endpointID }) {
                continue
            }

            let instanceName = extractInstanceName(from: result)
            resolveEndpoint(result.endpoint, id: endpointID, instanceName: instanceName, kind: kind)
        }
    }

    private func extractInstanceName(from result: NWBrowser.Result) -> String {
        if case .service(let name, _, _, _) = result.endpoint {
            return name
        }
        return "Unknown"
    }

    private func resolveEndpoint(_ endpoint: NWEndpoint, id: String, instanceName: String, kind: ServiceKind) {
        resolveEndpointWithIPv4(endpoint, id: id, instanceName: instanceName, kind: kind)
    }

    /// Try resolving with IPv4 preference first. URLSession can't handle IPv6
    /// link-local zone IDs in URLs, so IPv4 is more reliable for LAN WebSockets.
    /// Falls back to any-IP resolution if IPv4 fails.
    private func resolveEndpointWithIPv4(_ endpoint: NWEndpoint, id: String, instanceName: String, kind: ServiceKind) {
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
                    connection.cancel()
                    self.connections.removeValue(forKey: id)
                    return
                }

                if let resolved = self.extractHostPort(from: innerEndpoint, id: id, instanceName: instanceName, kind: kind) {
                    if !self.discoveredHosts.contains(where: { $0.id == id }) {
                        self.discoveredHosts.append(resolved)
                    }
                }

                connection.cancel()
                self.connections.removeValue(forKey: id)

            case .failed:
                // IPv4 resolution failed -- fall back to any IP version.
                connection.cancel()
                self.connections.removeValue(forKey: id)
                self.resolveEndpointAnyIP(endpoint, id: id, instanceName: instanceName, kind: kind)

            case .cancelled:
                self.connections.removeValue(forKey: id)

            default:
                break
            }
        }

        connection.start(queue: .main)
    }

    /// Fallback: resolve without IP version constraint.
    private func resolveEndpointAnyIP(_ endpoint: NWEndpoint, id: String, instanceName: String, kind: ServiceKind) {
        let connection = NWConnection(to: endpoint, using: .tcp)
        connections[id] = connection

        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }

            switch state {
            case .ready:
                guard let innerEndpoint = connection.currentPath?.remoteEndpoint else {
                    connection.cancel()
                    self.connections.removeValue(forKey: id)
                    return
                }

                if let resolved = self.extractHostPort(from: innerEndpoint, id: id, instanceName: instanceName, kind: kind) {
                    if !self.discoveredHosts.contains(where: { $0.id == id }) {
                        self.discoveredHosts.append(resolved)
                    }
                }

                connection.cancel()
                self.connections.removeValue(forKey: id)

            case .failed, .cancelled:
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
        kind: ServiceKind
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
                kind: kind,
                name: instanceName,
                host: hostString,
                port: port.rawValue
            )

        default:
            return nil
        }
    }
}
