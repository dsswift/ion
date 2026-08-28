import UIKit

extension SessionViewModel {
    @MainActor
    func copyTranscript(tabId: String) {
        let requestId = transcriptCopyCoordinator.begin(tabId: tabId) { [weak self] timedOutTabId, timedOutRequestId in
            DiagnosticLog.log("transcript request timed out", tag: "session.transcript", level: .warn, fields: [
                "tab_id": timedOutTabId,
                "request_id": timedOutRequestId,
            ])
            self?.showToast(ToastMessage(style: .error, title: "Copy failed", detail: "Transcript request timed out"))
        }
        send(.requestTranscript(tabId: tabId, requestId: requestId), intent: .userInitiated)
    }

    @MainActor
    func handleTranscript(tabId: String, requestId: String, transcript: String, error: String?) {
        guard let resolution = transcriptCopyCoordinator.resolve(
            tabId: tabId,
            requestId: requestId,
            transcript: transcript,
            error: error
        ) else {
            DiagnosticLog.log("stale transcript response ignored", tag: "session.transcript", level: .debug, fields: [
                "tab_id": tabId,
                "request_id": requestId,
            ])
            return
        }

        switch resolution {
        case .copied(let value):
            UIPasteboard.general.string = value
            DiagnosticLog.log("transcript copied", tag: "session.transcript", fields: [
                "tab_id": tabId,
                "request_id": requestId,
                "length": String(value.count),
            ])
            showToast(ToastMessage(style: .success, title: "Transcript copied"))
        case .empty:
            DiagnosticLog.log("transcript response empty", tag: "session.transcript", level: .warn, fields: [
                "tab_id": tabId,
                "request_id": requestId,
            ])
            showToast(ToastMessage(style: .warning, title: "Nothing to copy", detail: "This conversation has no transcript"))
        case .failed(let detail):
            DiagnosticLog.log("transcript response failed", tag: "session.transcript", level: .error, fields: [
                "tab_id": tabId,
                "request_id": requestId,
                "error": detail,
            ])
            showToast(ToastMessage(style: .error, title: "Copy failed", detail: detail))
        }
    }

    @MainActor
    func cancelTranscriptCopy() {
        transcriptCopyCoordinator.cancel()
    }
}
