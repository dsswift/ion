import Foundation

// MARK: - Upload event handlers
//
// Extracted from SessionViewModel+EventHandlers.swift to keep that file
// under the per-file size cap. This file owns the per-event handlers
// for upload-result events. The dispatch (the `case ...:` branch in the
// `handleEvent` switch) still lives in the umbrella file; only the
// handler implementations move here.

extension SessionViewModel {

    @MainActor
    func handleUploadAttachmentResult(id: String, name: String, path: String, correlationId: String?, error: String?) {
        if let error, !error.isEmpty {
            pendingUploadResults.append(UploadAttachmentResult(id: "", name: name, path: "", correlationId: correlationId, error: error))
        } else {
            pendingUploadResults.append(UploadAttachmentResult(id: id, name: name, path: path, correlationId: correlationId, error: nil))
        }
    }
}
