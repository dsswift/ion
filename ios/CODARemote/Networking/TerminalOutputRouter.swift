import Foundation

/// High-performance router for terminal output data.
///
/// Routes `terminal_output` events directly to registered SwiftTerm views,
/// bypassing SwiftUI's @Observable system. Terminal output at high volume
/// would cause catastrophic re-rendering if routed through observation.
final class TerminalOutputRouter: @unchecked Sendable {
    static let shared = TerminalOutputRouter()

    private let lock = NSLock()
    private var dataListeners: [String: (String) -> Void] = [:]
    private var exitListeners: [String: (Int) -> Void] = [:]

    private init() {}

    /// Register a handler for terminal data on a specific key ("tabId:instanceId").
    func register(key: String, dataHandler: @escaping (String) -> Void, exitHandler: @escaping (Int) -> Void) {
        lock.lock()
        dataListeners[key] = dataHandler
        exitListeners[key] = exitHandler
        lock.unlock()
    }

    /// Unregister handlers for a specific key.
    func unregister(key: String) {
        lock.lock()
        dataListeners.removeValue(forKey: key)
        exitListeners.removeValue(forKey: key)
        lock.unlock()
    }

    /// Route terminal output data to the registered handler.
    func route(tabId: String, instanceId: String, data: String) {
        let key = "\(tabId):\(instanceId)"
        lock.lock()
        let handler = dataListeners[key]
        lock.unlock()
        handler?(data)
    }

    /// Route terminal exit to the registered handler.
    func routeExit(tabId: String, instanceId: String, exitCode: Int) {
        let key = "\(tabId):\(instanceId)"
        lock.lock()
        let handler = exitListeners[key]
        lock.unlock()
        handler?(exitCode)
    }

    /// Feed initial buffer data to a registered handler (for snapshot restore).
    func feedBuffer(tabId: String, instanceId: String, data: String) {
        route(tabId: tabId, instanceId: instanceId, data: data)
    }
}
