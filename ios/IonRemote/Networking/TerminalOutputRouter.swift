import Foundation

/// High-performance router for terminal output data.
///
/// Routes `terminal_output` events directly to registered SwiftTerm views,
/// bypassing SwiftUI's @Observable system. Terminal output at high volume
/// would cause catastrophic re-rendering if routed through observation.
///
/// Live output and snapshot history reach a view through separate handlers.
/// History is the raw pty stream, so it still carries the questions programs
/// asked the terminal (background color, cursor position); a view must parse
/// it without answering, or the answers land in the live shell as text.
final class TerminalOutputRouter: @unchecked Sendable {
    static let shared = TerminalOutputRouter()

    private let lock = NSLock()
    private var dataListeners: [String: (String) -> Void] = [:]
    private var historyListeners: [String: (String) -> Void] = [:]
    private var exitListeners: [String: (Int) -> Void] = [:]
    private var restartListeners: [String: () -> Void] = [:]
    private var pendingBuffers: [String: String] = [:]

    /// Internal rather than private so a test can build an isolated router.
    init() {}

    /// Register handlers for a specific key ("tabId:instanceId"): live output,
    /// snapshot history, exit, and restart (a fresh shell replaced the old one).
    func register(
        key: String,
        dataHandler: @escaping (String) -> Void,
        historyHandler: @escaping (String) -> Void,
        exitHandler: @escaping (Int) -> Void,
        restartHandler: @escaping () -> Void
    ) {
        lock.lock()
        dataListeners[key] = dataHandler
        historyListeners[key] = historyHandler
        exitListeners[key] = exitHandler
        restartListeners[key] = restartHandler
        let pending = pendingBuffers.removeValue(forKey: key)
        lock.unlock()
        // Flush any buffered snapshot history that arrived before the handler was registered.
        if let pending {
            historyHandler(pending)
        }
    }

    /// Unregister handlers for a specific key.
    func unregister(key: String) {
        lock.lock()
        dataListeners.removeValue(forKey: key)
        historyListeners.removeValue(forKey: key)
        exitListeners.removeValue(forKey: key)
        restartListeners.removeValue(forKey: key)
        pendingBuffers.removeValue(forKey: key)
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

    /// Route a terminal restart. History held for a view that has not
    /// registered yet belongs to the replaced shell, so it is dropped.
    func routeRestart(tabId: String, instanceId: String) {
        let key = "\(tabId):\(instanceId)"
        lock.lock()
        let handler = restartListeners[key]
        pendingBuffers.removeValue(forKey: key)
        lock.unlock()
        handler?()
    }

    /// Feed snapshot history to a registered view's history handler.
    /// If no handler is registered yet, the data is held in a pending buffer
    /// and flushed automatically when a handler registers for this key.
    func feedBuffer(tabId: String, instanceId: String, data: String) {
        let key = "\(tabId):\(instanceId)"
        lock.lock()
        if let handler = historyListeners[key] {
            lock.unlock()
            handler(data)
        } else {
            // No handler yet — buffer the data so it can be flushed on register().
            if let existing = pendingBuffers[key] {
                pendingBuffers[key] = existing + data
            } else {
                pendingBuffers[key] = data
            }
            lock.unlock()
        }
    }
}
