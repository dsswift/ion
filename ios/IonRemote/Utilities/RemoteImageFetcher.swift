import UIKit

/// Coordinates lazy fetches of image bytes from the desktop.
///
/// `EngineMessageRow` renders inline images by parsing `[Attached image: PATH]`
/// markers in the message body and looking up bytes in `AttachmentImageCache`
/// by path. After an iOS reinstall the local cache is empty, so the lookup
/// misses. Calling `request(path:viewModel:completion:)` sends `fs_read_image`
/// to the desktop, populates the cache when the response arrives, and notifies
/// every observer registered for that path. Multiple concurrent observers for
/// the same path coalesce into a single network round-trip.
@MainActor
final class RemoteImageFetcher {
    static let shared = RemoteImageFetcher()

    private var pending: [String: [(UIImage?) -> Void]] = [:]
    private var failed: Set<String> = []

    private init() {}

    /// Look up `path` in the local cache; on a miss, request bytes from the
    /// desktop. The completion fires once with the resolved image (or nil if
    /// the desktop rejected the path). Already-fetched paths short-circuit.
    func request(path: String, viewModel: SessionViewModel, completion: @escaping (UIImage?) -> Void) {
        if let img = AttachmentImageCache.shared.image(forKey: path) {
            completion(img)
            return
        }
        if failed.contains(path) {
            completion(nil)
            return
        }
        if pending[path] != nil {
            pending[path]?.append(completion)
            return
        }
        pending[path] = [completion]
        viewModel.send(.fsReadImage(filePath: path))
    }

    /// Called by the event handler when `fs_image_content` arrives.
    func deliver(path: String, dataUrl: String?) {
        let observers = pending.removeValue(forKey: path) ?? []
        guard let dataUrl, let bytes = decodeDataUrl(dataUrl) else {
            failed.insert(path)
            for cb in observers { cb(nil) }
            return
        }
        AttachmentImageCache.shared.store(data: bytes, forKey: path)
        let image = UIImage(data: bytes)
        for cb in observers { cb(image) }
    }

    private func decodeDataUrl(_ s: String) -> Data? {
        guard let comma = s.firstIndex(of: ",") else { return nil }
        let base64 = String(s[s.index(after: comma)...])
        return Data(base64Encoded: base64)
    }
}
