import Foundation

/// Correlates one-at-a-time transcript copy requests with desktop responses.
@MainActor
final class TranscriptCopyCoordinator {
    enum Resolution: Equatable {
        case copied(String)
        case empty
        case failed(String)
    }

    private(set) var pendingRequestId: String?
    private(set) var pendingTabId: String?
    private var timeoutTask: Task<Void, Never>?
    private let makeRequestId: () -> String
    private let timeout: Duration

    init(
        timeout: Duration = .seconds(15),
        makeRequestId: @escaping () -> String = { UUID().uuidString }
    ) {
        self.timeout = timeout
        self.makeRequestId = makeRequestId
    }

    deinit {
        timeoutTask?.cancel()
    }

    func begin(tabId: String, onTimeout: @escaping @MainActor (String, String) -> Void) -> String {
        cancel()
        let requestId = makeRequestId()
        pendingRequestId = requestId
        pendingTabId = tabId
        timeoutTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(for: self?.timeout ?? .seconds(15))
            } catch {
                return
            }
            guard let self,
                  self.pendingRequestId == requestId,
                  self.pendingTabId == tabId else { return }
            self.clear()
            onTimeout(tabId, requestId)
        }
        return requestId
    }

    func resolve(tabId: String, requestId: String, transcript: String, error: String?) -> Resolution? {
        guard requestId == pendingRequestId, tabId == pendingTabId else { return nil }
        clear()
        if let error, !error.isEmpty { return .failed(error) }
        guard !transcript.isEmpty else { return .empty }
        return .copied(transcript)
    }

    func cancel() {
        clear()
    }

    private func clear() {
        timeoutTask?.cancel()
        timeoutTask = nil
        pendingRequestId = nil
        pendingTabId = nil
    }
}
