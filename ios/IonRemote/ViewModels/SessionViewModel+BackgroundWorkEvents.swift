import Foundation

extension SessionViewModel {
    /// Handles late-added lifecycle events outside the core event switch so the
    /// main dispatcher stays beneath the source-file cap.
    @MainActor
    func handleLateLifecycleEvent(_ event: RemoteEvent) {
        switch event {
        case .backgroundWorkDelivered(let tabId, let instanceId, let message):
            handleBackgroundWorkDelivered(tabId: tabId, instanceId: instanceId, message: message)
        default:
            break
        }
    }
}
