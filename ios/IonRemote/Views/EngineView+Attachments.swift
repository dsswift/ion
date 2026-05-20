import SwiftUI
import PhotosUI

// MARK: - Attachments

extension EngineView {

    func addFileAttachment(path: String, name: String) {
        let imageExts: Set = ["png", "jpg", "jpeg", "gif", "webp", "svg"]
        let ext = (name as NSString).pathExtension.lowercased()
        let type = imageExts.contains(ext) ? "image" : "file"
        pendingAttachments.append(PendingAttachment(
            id: UUID().uuidString, type: type, name: name, path: path, isUploading: false
        ))
    }

    func handlePhotoSelection(_ item: PhotosPickerItem) {
        let placeholderId = UUID().uuidString
        let correlationId = UUID().uuidString
        let name = "photo-\(Int(Date().timeIntervalSince1970 * 1000)).jpeg"
        pendingAttachments.append(PendingAttachment(
            id: placeholderId, type: "image", name: name, path: "", isUploading: true, correlationId: correlationId
        ))

        Task {
            guard let data = try? await item.loadTransferable(type: Data.self) else {
                await MainActor.run { pendingAttachments.removeAll { $0.id == placeholderId } }
                return
            }
            let compressed = compressImage(data: data, maxBytes: 1_000_000)
            AttachmentImageCache.shared.store(data: compressed, forKey: placeholderId)
            let base64 = compressed.base64EncodedString()
            let dataUrl = "data:image/jpeg;base64,\(base64)"
            await MainActor.run {
                viewModel.uploadAttachment(dataUrl: dataUrl, name: name, correlationId: correlationId)
            }
        }
    }

    func handleDocumentPickerResult(_ result: Result<[URL], Error>) {
        guard case .success(let urls) = result else { return }
        for url in urls {
            guard url.startAccessingSecurityScopedResource() else { continue }
            defer { url.stopAccessingSecurityScopedResource() }
            let name = url.lastPathComponent
            guard let data = try? Data(contentsOf: url) else { continue }

            let placeholderId = UUID().uuidString
            let correlationId = UUID().uuidString
            let imageExts: Set = ["png", "jpg", "jpeg", "gif", "webp", "svg"]
            let ext = url.pathExtension.lowercased()
            let type = imageExts.contains(ext) ? "image" : "file"

            pendingAttachments.append(PendingAttachment(
                id: placeholderId, type: type, name: name, path: "", isUploading: true, correlationId: correlationId
            ))
            if type == "image" {
                let compressed = compressImage(data: data, maxBytes: 1_000_000)
                AttachmentImageCache.shared.store(data: compressed, forKey: placeholderId)
                let base64 = compressed.base64EncodedString()
                let mimeExt = (ext == "jpg" || ext == "jpeg") ? "jpeg" : ext
                let dataUrl = "data:image/\(mimeExt);base64,\(base64)"
                viewModel.uploadAttachment(dataUrl: dataUrl, name: name, correlationId: correlationId)
            } else {
                let base64 = data.base64EncodedString()
                let dataUrl = "data:application/octet-stream;base64,\(base64)"
                viewModel.uploadAttachment(dataUrl: dataUrl, name: name, correlationId: correlationId)
            }
        }
    }

    func compressImage(data: Data, maxBytes: Int) -> Data {
        guard let uiImage = UIImage(data: data) else { return data }
        var quality: CGFloat = 0.8
        while quality > 0.1 {
            if let jpeg = uiImage.jpegData(compressionQuality: quality), jpeg.count <= maxBytes {
                return jpeg
            }
            quality -= 0.1
        }
        return uiImage.jpegData(compressionQuality: 0.1) ?? data
    }

    func consumeUploadResults(_ results: [UploadAttachmentResult]) {
        guard !results.isEmpty else { return }
        var consumedIds = Set<String>()
        for result in results {
            guard let cid = result.correlationId, !cid.isEmpty else { continue }
            if let idx = pendingAttachments.firstIndex(where: { $0.isUploading && $0.correlationId == cid }) {
                consumedIds.insert(cid)
                if let error = result.error, !error.isEmpty {
                    pendingAttachments.remove(at: idx)
                } else {
                    AttachmentImageCache.shared.rekey(from: pendingAttachments[idx].id, to: result.id)
                    // Also key the cache by the desktop-side path: this is what
                    // survives in the rendered message text after rehydration,
                    // so a path-keyed lookup is what makes the inline image
                    // render when the user re-enters the conversation.
                    if pendingAttachments[idx].type == "image", !result.path.isEmpty,
                       let bytes = AttachmentImageCache.shared.data(forKey: result.id) {
                        AttachmentImageCache.shared.store(data: bytes, forKey: result.path)
                    }
                    pendingAttachments[idx] = PendingAttachment(
                        id: result.id, type: pendingAttachments[idx].type, name: result.name, path: result.path, isUploading: false, correlationId: cid
                    )
                }
            }
        }
        if !consumedIds.isEmpty {
            viewModel.pendingUploadResults.removeAll { r in
                guard let cid = r.correlationId else { return false }
                return consumedIds.contains(cid)
            }
        }
    }
}
