import Foundation

/// Browses the local network for one paired server and reports its address
/// once. Owns its browser, so stopping it stops the browse.
final class StudioAddressWatcher: @unchecked Sendable {
    private let record: StudioServerRecord
    private var browser: BonjourBrowser?
    private var task: Task<Void, Never>?

    init(record: StudioServerRecord) {
        self.record = record
    }

    /// Starts browsing. `onFound` is called at most once, with the server's address.
    @MainActor
    func start(onFound: @escaping @Sendable (URL) async -> Void) {
        guard task == nil else { return }
        let browser = BonjourBrowser()
        self.browser = browser
        browser.startBrowsing()
        let record = record
        task = Task { @MainActor [weak self] in
            if let url = await StudioServerDiscovery.waitForAddress(of: record, browser: browser) {
                await onFound(url)
            }
            self?.stopBrowsing()
        }
    }

    @MainActor
    func stop() {
        task?.cancel()
        task = nil
        stopBrowsing()
    }

    @MainActor
    private func stopBrowsing() {
        browser?.stopBrowsing()
        browser = nil
    }
}
